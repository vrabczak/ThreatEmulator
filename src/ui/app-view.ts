/**
 * Renders application state into the mounted HTML shell and its native row templates.
 * Dynamic values use `textContent`; the view depends on the stable bindings in `app.html`.
 */

import { formatThreatRange } from '../domain/geo';
import { buildPrimaryWarning } from '../domain/warning';
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
let highlightTimer: number | null = null;

export type MessageTone = 'normal' | 'warning' | 'error';

export interface AppViewModel {
  csvResult: ThreatCsvResult | null;
  threats: Threat[];
  threatsModified: boolean;
  terrainMetadata: TerrainMetadata | null;
  persistentTerrainSupported: boolean;
  rememberedTerrainFileName: string | null;
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
  wakeLockActive: boolean;
}

interface SummaryRow {
  label: string;
  value: string;
  valueClass?: 'muted' | 'warn' | 'bad';
}

/**
 * Renders the complete mutable application view from a state snapshot.
 * @param model - Current application state and derived display flags.
 * @returns Nothing.
 */
export function renderApp(model: AppViewModel): void {
  const primaryWarning = model.emulatorActive || model.lastEvaluation?.primary
    ? buildPrimaryWarning(model.lastEvaluation?.primary ?? null, model.aircraftState)
    : 'EMULATOR STOPPED';
  setText('primaryWarning', primaryWarning);
  getElement('primaryWarning').classList.toggle('active', Boolean(model.lastEvaluation?.primary));
  setText('emulatorState', model.emulatorActive ? 'ACTIVE' : 'STOPPED');
  getElement('emulatorState').classList.toggle('active', model.emulatorActive);
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
 * Animates the warning and threat panels after a completed evaluation.
 * @returns Nothing.
 */
export function highlightNewEvaluation(): void {
  const warningBand = getElement('warningBand');
  const evaluationPanel = getElement('evaluationPanel');

  if (highlightTimer !== null) {
    window.clearTimeout(highlightTimer);
  }
  warningBand.classList.remove('evaluation-updated');
  evaluationPanel.classList.remove('evaluation-updated');
  // Reading layout restarts the CSS animation even when evaluations complete close together.
  void warningBand.offsetWidth;
  warningBand.classList.add('evaluation-updated');
  evaluationPanel.classList.add('evaluation-updated');
  highlightTimer = window.setTimeout(() => {
    warningBand.classList.remove('evaluation-updated');
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
      value: getElement<HTMLInputElement>('terrainInput').files?.[0]?.name ?? 'Not loaded - LOS assumed clear',
      valueClass: 'muted'
    });
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
    value.textContent = row.value;
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
