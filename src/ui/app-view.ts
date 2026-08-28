/**
 * Renders application state into the mounted HTML shell and its native row templates.
 * Dynamic values use `textContent`; the view depends on the stable bindings in `app.html`.
 */

import { formatThreatRange } from '../domain/geo';
import { activeThreatClockCodes, buildThreatWarning } from '../domain/warning';
import type {
  AircraftState,
  TerrainMetadata,
  Threat,
  ThreatCsvResult,
  ThreatEvaluationSummary
} from '../domain/types';
import type { GeolocationStatus } from '../services/geolocation';
import { cloneTemplate, getElement, setText } from './dom';

const FEET_PER_METER = 3.280839895;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const THREAT_SCOPE_CENTER = 120;
const THREAT_MARKER_RADIUS = 69;
const ELEVATION_DOWNLOAD_URL =
  'https://1drv.ms/i/c/e4440e9fda796b83/IQC-MS0bzl02RYfhc9KcbcbpAcShtwlbw3aEe6shDZO69ks?e=sFnxux';
let highlightTimer: number | null = null;

export type MessageTone = 'normal' | 'warning' | 'error';

export interface AppViewModel {
  csvResult: ThreatCsvResult | null;
  threats: Threat[];
  threatsModified: boolean;
  terrainMetadata: TerrainMetadata | null;
  persistentTerrainSupported: boolean;
  rememberedTerrainFileName: string | null;
  rememberedTerrainLookupComplete: boolean;
  aircraftState: AircraftState | null;
  lastAircraftTerrainReason: string | null;
  geolocationStatus: GeolocationStatus;
  geolocationMessage: string;
  appMessage: string;
  appMessageTone: MessageTone;
  emulatorActive: boolean;
  evaluationInFlight: boolean;
  nextEvaluationAtMs: number | null;
  lastEvaluation: ThreatEvaluationSummary | null;
  activeThreatOrder: string[];
  wakeLockActive: boolean;
}

interface SummaryRow {
  label: string;
  value: string;
  valueClass?: 'muted' | 'warn' | 'bad';
  valueLink?: string;
}

/**
 * Renders the complete mutable application view from a state snapshot.
 * @param model - Current application state and derived display flags.
 * @returns Nothing.
 */
export function renderApp(model: AppViewModel): void {
  renderThreatDisplay(model);
  renderWarningCalls(model);
  updateEvaluationCountdown(model);

  const messageElement = getElement('appMessage');
  messageElement.textContent = model.appMessage;
  messageElement.className = `message${model.appMessageTone === 'error' ? ' error' : model.appMessageTone === 'warning' ? ' warning' : ''}`;

  renderSummaryRows(getElement('csvImportStatus'), buildCsvRows(model));
  renderSummaryRows(getElement('terrainImportStatus'), buildTerrainRows(model));
  setText('gnssStatus', `${model.geolocationStatus.toUpperCase()} - ${model.geolocationMessage}`);

  setText('latValue', model.aircraftState ? model.aircraftState.latitude.toFixed(6) : '--');
  setText('lonValue', model.aircraftState ? model.aircraftState.longitude.toFixed(6) : '--');
  setText(
    'altValue',
    model.aircraftState?.gpsAltitudeM !== null && model.aircraftState?.gpsAltitudeM !== undefined
      ? `${metersToFeet(model.aircraftState.gpsAltitudeM)} ft`
      : '--'
  );
  setText('aglValue', renderAgl(model));
  setText(
    'precisionValue',
    model.aircraftState?.gpsAccuracyM !== null && model.aircraftState?.gpsAccuracyM !== undefined
      ? `${model.aircraftState.gpsAccuracyM.toFixed(0)} m`
      : '--'
  );
  setText('trackValue', renderTrack(model.aircraftState));

  renderThreatRows(model.threats, model.lastEvaluation);
  getElement<HTMLButtonElement>('exportThreatsButton').hidden = model.threats.length === 0;

  const startStopButton = getElement<HTMLButtonElement>('startStopButton');
  startStopButton.textContent = model.emulatorActive ? 'Stop' : 'Start';
  startStopButton.classList.toggle('primary', !model.emulatorActive);
  startStopButton.classList.toggle('danger', model.emulatorActive);

  const stayAwakeButton = getElement<HTMLButtonElement>('stayAwakeButton');
  stayAwakeButton.textContent = model.wakeLockActive ? 'Allow sleep' : 'Stay awake';
  stayAwakeButton.setAttribute('aria-pressed', String(model.wakeLockActive));
  stayAwakeButton.classList.toggle('awake-active', model.wakeLockActive);
}

function renderThreatDisplay(model: AppViewModel): void {
  const activeResults = model.emulatorActive ? model.lastEvaluation?.active ?? [] : [];
  const clockCodes = activeThreatClockCodes(activeResults, model.aircraftState);
  const fragment = document.createDocumentFragment();

  for (const clockCode of clockCodes) {
    // Clock positions are fixed to a common radius: only direction, never threat distance, affects placement.
    const rotationDegrees = (clockCode % 12) * 30;
    const rotationRadians = rotationDegrees * Math.PI / 180;
    const markerX = THREAT_SCOPE_CENTER + Math.sin(rotationRadians) * THREAT_MARKER_RADIUS;
    const markerY = THREAT_SCOPE_CENTER - Math.cos(rotationRadians) * THREAT_MARKER_RADIUS;
    const marker = document.createElementNS(SVG_NAMESPACE, 'use');
    marker.setAttribute('href', '#threatRocketGlyph');
    marker.setAttribute('class', 'threat-direction-marker');
    marker.setAttribute(
      'transform',
      `translate(${markerX.toFixed(2)} ${markerY.toFixed(2)}) rotate(${rotationDegrees})`
    );
    marker.setAttribute('aria-hidden', 'true');
    fragment.append(marker);
  }

  getElement('threatDirectionMarkers').replaceChildren(fragment);
  const status = getElement('threatDisplayStatus');
  if (!model.emulatorActive) {
    status.textContent = 'Emulator stopped. No threat directions displayed.';
  } else if (activeResults.length === 0) {
    status.textContent = 'No active threat.';
  } else if (clockCodes.length === 0) {
    status.textContent = 'Active threat direction unavailable because aircraft track is unavailable.';
  } else {
    status.textContent = `Active threat ${clockCodes.length === 1 ? 'direction' : 'directions'}: ${clockCodes.map((clockCode) => `${clockCode} o'clock`).join(', ')}.`;
  }
}

function renderWarningCalls(model: AppViewModel): void {
  const container = getElement('warningCalls');
  const resultsByThreatId = new Map(
    (model.lastEvaluation?.active ?? []).map((result) => [result.threat.id, result])
  );
  const activeResults = model.activeThreatOrder.flatMap((id) => {
    const result = resultsByThreatId.get(id);
    return result ? [result] : [];
  });
  const fragment = document.createDocumentFragment();

  if (!model.emulatorActive || activeResults.length === 0) {
    const row = cloneTemplate<HTMLDivElement>('warningCallTemplate');
    row.textContent = model.emulatorActive ? 'NO ACTIVE THREAT' : 'EMULATOR STOPPED';
    fragment.append(row);
  } else {
    for (const result of activeResults) {
      const row = cloneTemplate<HTMLDivElement>('warningCallTemplate');
      row.textContent = buildThreatWarning(result, model.aircraftState);
      row.classList.add('active');
      fragment.append(row);
    }
  }

  container.replaceChildren(fragment);
}

/**
 * Updates only the high-frequency evaluation countdown and activity pulse.
 * @param model - Current evaluation timer state.
 * @returns Nothing.
 */
export function updateEvaluationCountdown(
  model: Pick<AppViewModel, 'emulatorActive' | 'evaluationInFlight' | 'nextEvaluationAtMs'>
): void {
  const countdown = getElement('evaluationCountdown');
  const pulse = getElement('evaluationPulse');

  if (!model.emulatorActive) {
    countdown.textContent = 'Updates stopped';
  } else if (model.evaluationInFlight) {
    countdown.textContent = 'Calculating threats...';
  } else {
    const remainingMs = Math.max(0, (model.nextEvaluationAtMs ?? Date.now()) - Date.now());
    countdown.textContent = `Next threat check in ${(remainingMs / 1000).toFixed(1)} s`;
  }
  pulse.classList.toggle('calculating', model.emulatorActive && model.evaluationInFlight);
}

/**
 * Animates the warning, direction display, and threat table after a completed evaluation.
 * @returns Nothing.
 */
export function highlightNewEvaluation(): void {
  const warningBand = getElement('warningBand');
  const threatDisplayPanel = getElement('threatDisplayPanel');
  const evaluationPanel = getElement('evaluationPanel');

  if (highlightTimer !== null) {
    window.clearTimeout(highlightTimer);
  }
  warningBand.classList.remove('evaluation-updated');
  threatDisplayPanel.classList.remove('evaluation-updated');
  evaluationPanel.classList.remove('evaluation-updated');
  // Reading layout restarts the CSS animation even when evaluations complete close together.
  void warningBand.offsetWidth;
  warningBand.classList.add('evaluation-updated');
  threatDisplayPanel.classList.add('evaluation-updated');
  evaluationPanel.classList.add('evaluation-updated');
  highlightTimer = window.setTimeout(() => {
    warningBand.classList.remove('evaluation-updated');
    threatDisplayPanel.classList.remove('evaluation-updated');
    evaluationPanel.classList.remove('evaluation-updated');
    highlightTimer = null;
  }, 900);
}

function buildCsvRows(model: AppViewModel): SummaryRow[] {
  if (!model.csvResult) {
    const rows: SummaryRow[] = [{
      label: 'CSV',
      value: getElement<HTMLInputElement>('csvInput').files?.[0]?.name ?? 'No file selected',
      valueClass: 'muted'
    }];
    if (model.threats.length > 0) {
      rows.push({ label: 'Manual threats', value: String(model.threats.length) });
    }
    return rows;
  }

  const rows: SummaryRow[] = [{ label: 'CSV file', value: model.csvResult.fileName }];
  if (model.threatsModified) {
    rows.push({ label: 'Threat list', value: 'Edited locally', valueClass: 'warn' });
  }
  for (const error of model.csvResult.errors) {
    rows.push({ label: 'File error', value: error, valueClass: 'bad' });
  }
  for (const invalid of model.csvResult.invalidRows.slice(0, 8)) {
    rows.push({ label: `Row ${invalid.rowNumber}`, value: invalid.errors.join(' '), valueClass: 'bad' });
  }
  return rows;
}

function buildTerrainRows(model: AppViewModel): SummaryRow[] {
  const rows: SummaryRow[] = [];
  if (!model.terrainMetadata) {
    rows.push({
      label: 'GeoTIFF',
      value: getElement<HTMLInputElement>('terrainInput').files?.[0]?.name ?? 'Not loaded',
      valueClass: 'muted'
    });
    if (model.rememberedTerrainLookupComplete && !model.rememberedTerrainFileName) {
      rows.push({
        label: 'Elevation file',
        value: 'Download GeoTIFF',
        valueLink: ELEVATION_DOWNLOAD_URL
      });
    }
  } else {
    rows.push({ label: 'GeoTIFF file', value: model.terrainMetadata.fileName });
    rows.push({
      label: 'Coverage',
      value: model.terrainMetadata.bbox.map((coordinate) => coordinate.toFixed(4)).join(', ')
    });
    for (const warning of model.terrainMetadata.warnings) {
      rows.push({ label: 'GeoTIFF warning', value: warning, valueClass: 'warn' });
    }
  }
  if (model.persistentTerrainSupported && model.rememberedTerrainFileName) {
    rows.push({ label: 'Remembered GeoTIFF', value: model.rememberedTerrainFileName });
  }
  return rows;
}

function renderSummaryRows(container: HTMLElement, rows: SummaryRow[]): void {
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const element = cloneTemplate<HTMLDivElement>('summaryRowTemplate');
    selectField(element, 'label').textContent = row.label;
    const value = selectField(element, 'value');
    if (row.valueLink) {
      const link = document.createElement('a');
      link.href = row.valueLink;
      link.textContent = row.value;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      value.replaceChildren(link);
    } else {
      value.textContent = row.value;
    }
    if (row.valueClass) {
      value.classList.add(row.valueClass);
    }
    fragment.append(element);
  }
  container.replaceChildren(fragment);
}

function renderAgl(model: AppViewModel): string {
  if (model.aircraftState?.aglM !== null && model.aircraftState?.aglM !== undefined) {
    const fallback = model.lastAircraftTerrainReason ? ' (last terrain)' : '';
    return `${metersToFeet(model.aircraftState.aglM)} ft${fallback}`;
  }
  return model.lastAircraftTerrainReason ? `-- (${model.lastAircraftTerrainReason})` : '--';
}

function renderTrack(aircraftState: AircraftState | null): string {
  if (!aircraftState || aircraftState.trackDegrees === null) {
    return 'Unavailable';
  }
  const age = aircraftState.trackAgeMs !== null ? `, ${Math.round(aircraftState.trackAgeMs / 1000)} s` : '';
  return `${aircraftState.trackDegrees.toFixed(0)} deg (${aircraftState.trackSource}${age})`;
}

function renderThreatRows(threats: Threat[], lastEvaluation: ThreatEvaluationSummary | null): void {
  const tbody = getElement<HTMLTableSectionElement>('threatRows');
  if (threats.length === 0) {
    tbody.replaceChildren(cloneTemplate<HTMLTableRowElement>('emptyThreatRowTemplate'));
    return;
  }

  const evaluationsByThreatId = new Map(
    (lastEvaluation?.results ?? []).map((result) => [result.threat.id, result])
  );
  const fragment = document.createDocumentFragment();

  threats.forEach((threat, index) => {
    const result = evaluationsByThreatId.get(threat.id);
    const distanceClass =
      result?.distanceKm === null || result?.distanceKm === undefined
        ? ''
        : result.distanceKm <= threat.rangeKm ? 'good' : 'bad';
    const lineOfSight =
      threat.heightAglM === null
        ? 'ALWAYS'
        : result?.lineOfSight?.status === 'clear'
          ? 'VLOS'
          : result?.lineOfSight?.status === 'blocked' ? 'BLOS' : '--';
    const lineOfSightClass =
      threat.heightAglM === null || result?.lineOfSight?.status === 'clear'
        ? 'good'
        : result?.lineOfSight?.status === 'blocked' ? 'bad' : '';
    const stateClass =
      result?.state === 'active' ? 'good' : result?.state === 'inactive' ? 'bad' : result ? 'warn' : '';

    const row = cloneTemplate<HTMLTableRowElement>('threatRowTemplate');
    setField(row, 'id', threat.id);
    const name = selectField(row, 'name');
    name.textContent = threat.name || 'No description';
    name.classList.toggle('muted', !threat.name);
    setField(row, 'distance', result?.distanceKm === null || result?.distanceKm === undefined ? '--' : formatThreatRange(result.distanceKm), distanceClass);
    setField(row, 'range', formatThreatRange(threat.rangeKm));
    setField(row, 'lineOfSight', lineOfSight, lineOfSightClass);
    setField(row, 'state', result ? result.state.toUpperCase() : 'NOT EVALUATED', stateClass);

    row.querySelectorAll<HTMLButtonElement>('button[data-threat-action]').forEach((button) => {
      button.dataset.threatIndex = String(index);
      const action = button.dataset.threatAction === 'delete' ? 'Delete' : 'Edit';
      button.setAttribute('aria-label', `${action} threat ${threat.id}`);
    });
    fragment.append(row);
  });

  tbody.replaceChildren(fragment);
}

function selectField(root: Element, name: string): HTMLElement {
  const field = root.querySelector<HTMLElement>(`[data-field="${name}"]`);
  if (!field) {
    throw new Error(`Missing template field: ${name}`);
  }
  return field;
}

function setField(root: Element, name: string, value: string, className = ''): void {
  const field = selectField(root, name);
  field.textContent = value;
  if (className) {
    field.classList.add(className);
  }
}

function metersToFeet(meters: number): string {
  return (meters * FEET_PER_METER).toFixed(0);
}
