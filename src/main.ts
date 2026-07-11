import { registerSW } from 'virtual:pwa-register';
import { parseThreatCsvFile } from './domain/csv';
import { calculateAgl, evaluateThreats, resolveTerrainElevationM } from './domain/evaluation';
import { Egm96GeoidModel } from './domain/geoid';
import { formatThreatRange } from './domain/geo';
import { buildPrimaryWarning } from './domain/warning';
import { GeolocationTracker, type GeolocationStatus } from './services/geolocation';
import {
  forgetPersistentTerrainFile,
  pickPersistentTerrainFile,
  restorePersistentTerrainFile,
  supportsPersistentFilePicker
} from './services/persistent-file';
import { WorkerTerrainService } from './services/terrain-service';
import type {
  AircraftState,
  TerrainMetadata,
  TerrainSample,
  ThreatCsvResult,
  ThreatEvaluationSummary
} from './domain/types';
import './styles.css';

const FEET_PER_METER = 3.280839895;
const EVALUATION_INTERVAL_MS = 3000;

registerSW({ immediate: true });

const terrainService = new WorkerTerrainService();
const geoidModel = new Egm96GeoidModel();
const persistentTerrainSupported = supportsPersistentFilePicker();

let csvResult: ThreatCsvResult | null = null;
let terrainMetadata: TerrainMetadata | null = null;
let terrainLoadedFromPersistentHandle = false;
let rememberedTerrainFileName: string | null = null;
let aircraftState: AircraftState | null = null;
let latestAircraftFixTimestampMs: number | null = null;
let lastAircraftTerrainElevationM: number | null = null;
let lastAircraftTerrainReason: string | null = null;
let geolocationStatus: GeolocationStatus = 'idle';
let geolocationMessage = 'GNSS watch starting.';
let appMessage = 'Load a threat CSV, import an elevation GeoTIFF, grant GNSS permission, then start the emulator.';
let appMessageTone: 'normal' | 'warning' | 'error' = 'normal';
let emulatorActive = false;
let evaluationTimer: number | null = null;
let countdownTimer: number | null = null;
let highlightTimer: number | null = null;
let nextEvaluationAtMs: number | null = null;
let evaluationInFlight = false;
let lastEvaluation: ThreatEvaluationSummary | null = null;
let stayAwakeRequested = false;
let wakeLock: WakeLockSentinel | null = null;

const geolocationTracker = new GeolocationTracker(
  (state) => {
    latestAircraftFixTimestampMs = state.timestampMs;
    // Keep the last fully converted state evaluable while this newer fix is converted to MSL.
    aircraftState ??= state;
    render();
    void convertAircraftAltitudeToMsl(state);
  },
  (status, message) => {
    geolocationStatus = status;
    geolocationMessage = message;
    if (status === 'denied' || status === 'unavailable' || status === 'error') {
      setMessage(message, 'error');
    }
    render();
  }
);

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <div class="brand">
        <h1>Threat Emulator</h1>
        <span>Offline terrain threat warning</span>
      </div>
      <div id="emulatorState" class="status-pill">STOPPED</div>
    </header>

    <section id="warningBand" class="warning-band">
      <div id="primaryWarning" class="warning-text" aria-live="polite">NO ACTIVE THREAT</div>
      <div class="evaluation-timing" aria-label="Threat calculation status">
        <span id="evaluationPulse" class="evaluation-pulse" aria-hidden="true"></span>
        <span id="evaluationCountdown">Updates stopped</span>
      </div>
    </section>

    <section class="content">
      <div class="panel">
        <div class="panel-header">Controls</div>
        <div class="panel-body">
          <div id="appMessage" class="message"></div>

          <div class="controls">
            <div class="field">
              <label for="csvInput">Threat CSV</label>
              <input id="csvInput" class="file-input-fallback" type="file" accept=".csv,text/csv" aria-label="Threat CSV file" />
              <div class="file-picker-control">
                <button id="csvImportButton" class="file-import-button" type="button">Import</button>
                <div id="csvImportStatus" class="file-picker-status" aria-live="polite">No file selected</div>
              </div>
            </div>
            <div class="field">
              <span class="field-label">Elevation GeoTIFF</span>
              <input id="terrainInput" class="file-input-fallback" type="file" accept=".tif,.tiff,image/tiff" aria-label="Elevation GeoTIFF file" />
              <div class="file-picker-control">
                <button id="terrainImportButton" class="file-import-button" type="button">Import</button>
                <div id="terrainImportStatus" class="file-picker-status" aria-live="polite">No file selected</div>
              </div>
            </div>
            <div class="button-row">
              <button id="startStopButton" class="primary" type="button">Start</button>
              <button id="stayAwakeButton" type="button" aria-pressed="false">Stay awake</button>
            </div>
          </div>

          <div class="summary-list">
            <div class="summary-row"><span>GNSS</span><strong id="gnssStatus">Idle</strong></div>
          </div>
        </div>
      </div>

      <div id="evaluationPanel" class="panel">
        <div class="panel-header">Aircraft Status</div>
        <div class="panel-body">
          <div class="status-grid">
            <div class="metric"><span class="metric-label">Latitude</span><span id="latValue" class="metric-value">--</span></div>
            <div class="metric"><span class="metric-label">Longitude</span><span id="lonValue" class="metric-value">--</span></div>
            <div class="metric"><span class="metric-label">GPS altitude</span><span id="altValue" class="metric-value">--</span></div>
            <div class="metric"><span class="metric-label">Height above ground</span><span id="aglValue" class="metric-value">--</span></div>
            <div class="metric"><span class="metric-label">GPS precision</span><span id="precisionValue" class="metric-value">--</span></div>
            <div class="metric"><span class="metric-label">Track</span><span id="trackValue" class="metric-value">--</span></div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Threat</th>
                  <th>State</th>
                  <th>Distance</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody id="evaluationRows"></tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">Threat Preview</div>
        <div class="panel-body">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Position</th>
                  <th>Range</th>
                </tr>
              </thead>
              <tbody id="threatRows"></tbody>
            </table>
          </div>
        </div>
      </div>

    </section>
  </main>
`;

const csvInput = getElement<HTMLInputElement>('csvInput');
const terrainInput = getElement<HTMLInputElement>('terrainInput');
const csvImportButton = getElement<HTMLButtonElement>('csvImportButton');
const csvImportStatus = getElement<HTMLDivElement>('csvImportStatus');
const startStopButton = getElement<HTMLButtonElement>('startStopButton');
const terrainImportButton = getElement<HTMLButtonElement>('terrainImportButton');
const terrainImportStatus = getElement<HTMLDivElement>('terrainImportStatus');
const stayAwakeButton = getElement<HTMLButtonElement>('stayAwakeButton');

csvInput.addEventListener('change', () => {
  const file = csvInput.files?.[0];
  if (!file) {
    return;
  }
  void loadCsv(file);
});

csvImportButton.addEventListener('click', () => {
  csvInput.click();
});

terrainInput.addEventListener('change', () => {
  const file = terrainInput.files?.[0];
  if (!file) {
    return;
  }
  void loadManualTerrain(file);
});

terrainImportButton.addEventListener('click', () => {
  void importTerrain();
});

startStopButton.addEventListener('click', () => {
  if (emulatorActive) {
    stopEmulator('Emulator stopped.');
  } else {
    startEmulator();
  }
});

stayAwakeButton.addEventListener('click', () => {
  void toggleStayAwake();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stayAwakeRequested && wakeLock === null) {
    void acquireWakeLock();
  }
});

async function toggleStayAwake(): Promise<void> {
  if (stayAwakeRequested) {
    stayAwakeRequested = false;
    await wakeLock?.release();
    wakeLock = null;
    render();
    return;
  }

  stayAwakeRequested = true;
  await acquireWakeLock();
}

async function acquireWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator)) {
    stayAwakeRequested = false;
    setMessage('This browser does not support keeping the screen awake.', 'warning');
    render();
    return;
  }

  try {
    const sentinel = await navigator.wakeLock.request('screen');
    wakeLock = sentinel;
    sentinel.addEventListener('release', () => {
      if (wakeLock === sentinel) {
        wakeLock = null;
        render();
      }
    });
  } catch (error) {
    stayAwakeRequested = false;
    const reason = error instanceof Error ? error.message : 'The wake lock request was rejected.';
    setMessage(`Unable to keep the screen awake: ${reason}`, 'warning');
  }
  render();
}

async function loadCsv(file: File): Promise<void> {
  csvResult = await parseThreatCsvFile(file);
  lastEvaluation = null;

  if (csvResult.errors.length > 0) {
    setMessage(csvResult.errors.join(' '), 'error');
  } else if (csvResult.invalidRows.length > 0) {
    setMessage(`${csvResult.threats.length} valid threats loaded; ${csvResult.invalidRows.length} rows need correction.`, 'warning');
  } else {
    setMessage(`${csvResult.threats.length} valid threats loaded from ${file.name}.`, 'normal');
  }
  render();
}

async function loadManualTerrain(file: File): Promise<void> {
  terrainLoadedFromPersistentHandle = false;
  rememberedTerrainFileName = null;
  if (persistentTerrainSupported) {
    void forgetPersistentTerrainFile().catch(() => undefined);
  }
  await loadTerrain(file, 'manual');
}

async function importTerrain(): Promise<void> {
  if (persistentTerrainSupported && rememberedTerrainFileName) {
    const shouldRestore = window.confirm(
      `Restore remembered GeoTIFF "${rememberedTerrainFileName}"? Choose Cancel to import another file.`
    );
    if (shouldRestore) {
      await restoreRememberedTerrain({ requestPermission: true, startup: false });
      return;
    }
  }

  await pickNewTerrain();
}

async function pickNewTerrain(): Promise<void> {
  if (persistentTerrainSupported) {
    await pickAndRememberTerrain();
    return;
  }

  terrainInput.click();
}

async function pickAndRememberTerrain(): Promise<void> {
  try {
    const file = await pickPersistentTerrainFile();
    if (!file) {
      return;
    }
    rememberedTerrainFileName = file.name;
    await loadTerrain(file, 'remembered');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Unable to remember GeoTIFF.', 'error');
    render();
  }
}

async function restoreRememberedTerrain(options: {
  requestPermission: boolean;
  startup: boolean;
}): Promise<boolean> {
  if (!persistentTerrainSupported) {
    if (!options.startup) {
      setMessage('Persistent GeoTIFF restore is not supported by this browser.', 'warning');
      render();
    }
    return false;
  }

  const restored = await restorePersistentTerrainFile({
    requestPermission: options.requestPermission
  });

  if (restored.status === 'loaded') {
    rememberedTerrainFileName = restored.file.name;
    await loadTerrain(restored.file, 'restored');
    return true;
  }

  if (restored.status === 'permission-needed') {
    rememberedTerrainFileName = restored.fileName;
    setMessage(`Previous GeoTIFF ${restored.fileName} is remembered. Use Import to restore it or import another file.`, 'warning');
    render();
    return false;
  }

  if (restored.status === 'unavailable') {
    rememberedTerrainFileName = restored.fileName;
    setMessage(restored.reason, 'error');
    render();
    return false;
  }

  if (!options.startup) {
    setMessage('No remembered GeoTIFF is available.', 'warning');
    render();
  }
  return false;
}

async function loadTerrain(file: File, source: 'manual' | 'remembered' | 'restored'): Promise<void> {
  stopEmulator('Loading replacement terrain.');
  terrainMetadata = null;
  lastAircraftTerrainElevationM = null;
  lastAircraftTerrainReason = null;
  if (aircraftState) {
    aircraftState = { ...aircraftState, aglM: null };
  }
  terrainLoadedFromPersistentHandle = source !== 'manual';
  lastEvaluation = null;
  setMessage(`Loading GeoTIFF metadata from ${file.name}.`, 'normal');
  render();

  try {
    terrainMetadata = await terrainService.loadGeoTiff(file);
    const warningText =
      terrainMetadata.warnings.length > 0 ? ` ${terrainMetadata.warnings.join(' ')}` : '';
    const persistenceText =
      source === 'remembered'
        ? ' GeoTIFF will be remembered on future launches.'
        : source === 'restored'
          ? ' Restored from remembered GeoTIFF.'
          : '';
    setMessage(`Terrain loaded: ${terrainMetadata.width} x ${terrainMetadata.height} cells.${warningText}${persistenceText}`, terrainMetadata.warnings.length > 0 ? 'warning' : 'normal');
    if (aircraftState) {
      void refreshAircraftAgl(aircraftState);
    }
  } catch (error) {
    terrainMetadata = null;
    terrainLoadedFromPersistentHandle = false;
    setMessage(error instanceof Error ? error.message : 'Unable to load GeoTIFF.', 'error');
  }
  render();
}

function startEmulator(): void {
  const readinessError = getReadinessError();
  if (readinessError) {
    setMessage(readinessError, 'error');
    render();
    return;
  }

  if (emulatorActive) {
    return;
  }

  emulatorActive = true;
  setMessage('Emulator active. Threats evaluate every 3 seconds.', 'normal');
  nextEvaluationAtMs = Date.now() + EVALUATION_INTERVAL_MS;
  void evaluateNow();
  evaluationTimer = window.setInterval(() => {
    nextEvaluationAtMs = Date.now() + EVALUATION_INTERVAL_MS;
    void evaluateNow();
  }, EVALUATION_INTERVAL_MS);
  countdownTimer = window.setInterval(updateEvaluationCountdown, 200);
  render();
}

function stopEmulator(message: string): void {
  if (evaluationTimer !== null) {
    window.clearInterval(evaluationTimer);
    evaluationTimer = null;
  }
  if (countdownTimer !== null) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
  nextEvaluationAtMs = null;
  emulatorActive = false;
  terrainService.cancelPending();
  setMessage(message, 'normal');
  render();
}

async function evaluateNow(): Promise<void> {
  if (evaluationInFlight) {
    return;
  }

  const readinessError = getReadinessError();
  if (readinessError) {
    setMessage(readinessError, 'error');
    render();
    return;
  }

  evaluationInFlight = true;
  render();
  let evaluationCompleted = false;
  try {
    lastEvaluation = await evaluateThreats(csvResult!.threats, aircraftState, terrainService);
    evaluationCompleted = true;
    const activeCount = lastEvaluation.results.filter((result) => result.state === 'active').length;
    setMessage(activeCount > 0 ? `${activeCount} active threat${activeCount === 1 ? '' : 's'} detected.` : 'No active threats detected.', activeCount > 0 ? 'warning' : 'normal');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Threat evaluation failed.', 'error');
  } finally {
    evaluationInFlight = false;
    render();
    if (evaluationCompleted) {
      highlightNewEvaluation();
    }
  }
}

async function convertAircraftAltitudeToMsl(state: AircraftState): Promise<void> {
  if (state.gpsEllipsoidAltitudeM === null) {
    return;
  }

  let gpsAltitudeMslM: number;
  try {
    gpsAltitudeMslM = await geoidModel.ellipsoidHeightToMslM(
      state.gpsEllipsoidAltitudeM,
      state.latitude,
      state.longitude
    );
  } catch (error) {
    if (latestAircraftFixTimestampMs === state.timestampMs && aircraftState?.gpsAltitudeM === null) {
      lastAircraftTerrainReason =
        error instanceof Error ? error.message : 'Unable to convert GPS altitude to MSL.';
      render();
    }
    return;
  }

  if (latestAircraftFixTimestampMs !== state.timestampMs) {
    return;
  }

  const convertedState: AircraftState = {
    ...state,
    gpsAltitudeM: gpsAltitudeMslM,
    aglM: calculateAgl(gpsAltitudeMslM, lastAircraftTerrainElevationM)
  };
  aircraftState = convertedState;
  lastAircraftTerrainReason = lastAircraftTerrainElevationM === null
    ? null
    : 'Using last retrieved terrain elevation while the current lookup completes.';
  render();
  await refreshAircraftAgl(convertedState);
}

async function refreshAircraftAgl(state: AircraftState): Promise<void> {
  if (!terrainMetadata || state.gpsAltitudeM === null) {
    return;
  }

  let sample: TerrainSample;
  try {
    sample = await terrainService.sampleElevation(state.latitude, state.longitude);
  } catch (error) {
    sample = {
      status: 'terrain-unavailable',
      reason: error instanceof Error ? error.message : 'Unable to read aircraft terrain elevation.'
    };
  }
  if (aircraftState?.timestampMs !== state.timestampMs) {
    return;
  }

  const terrainElevationM = resolveTerrainElevationM(sample, lastAircraftTerrainElevationM);
  if (sample.status === 'ok') {
    lastAircraftTerrainElevationM = sample.elevationM;
    lastAircraftTerrainReason = null;
  } else if (lastAircraftTerrainElevationM !== null) {
    lastAircraftTerrainReason = `${sample.reason} Using last retrieved terrain elevation.`;
  } else {
    lastAircraftTerrainReason = sample.reason;
  }

  aircraftState = {
    ...state,
    aglM: calculateAgl(state.gpsAltitudeM, terrainElevationM)
  };
  render();
}

function getReadinessError(): string | null {
  if (!csvResult || csvResult.threats.length === 0) {
    return 'Load a valid threat CSV before activating the emulator.';
  }
  if (!terrainMetadata) {
    return 'Load a valid elevation GeoTIFF before activating the emulator.';
  }
  if (!aircraftState) {
    return 'Grant GNSS permission and wait for an aircraft position before activating the emulator.';
  }
  if (aircraftState.gpsAltitudeM === null) {
    return 'Aircraft GPS altitude is unavailable.';
  }
  return null;
}

function render(): void {
  const primaryWarning = buildPrimaryWarning(lastEvaluation?.primary ?? null, aircraftState);
  setText('primaryWarning', emulatorActive || lastEvaluation?.primary ? primaryWarning : 'EMULATOR STOPPED');
  getElement('primaryWarning').classList.toggle('active', Boolean(lastEvaluation?.primary));
  setText('emulatorState', emulatorActive ? 'ACTIVE' : 'STOPPED');
  getElement('emulatorState').classList.toggle('active', emulatorActive);
  updateEvaluationCountdown();

  const messageElement = getElement('appMessage');
  messageElement.textContent = appMessage;
  messageElement.className = `message${appMessageTone === 'error' ? ' error' : appMessageTone === 'warning' ? ' warning' : ''}`;

  csvImportStatus.innerHTML = renderCsvImportStatus();
  terrainImportStatus.innerHTML = renderTerrainImportStatus();
  setText('gnssStatus', `${geolocationStatus.toUpperCase()} - ${geolocationMessage}`);

  setText('latValue', aircraftState ? aircraftState.latitude.toFixed(6) : '--');
  setText('lonValue', aircraftState ? aircraftState.longitude.toFixed(6) : '--');
  setText('altValue', aircraftState?.gpsAltitudeM !== null && aircraftState?.gpsAltitudeM !== undefined ? `${metersToFeet(aircraftState.gpsAltitudeM)} ft` : '--');
  setText('aglValue', renderAgl());
  setText('precisionValue', aircraftState?.gpsAccuracyM !== null && aircraftState?.gpsAccuracyM !== undefined ? `${aircraftState.gpsAccuracyM.toFixed(0)} m` : '--');
  setText('trackValue', renderTrack());

  renderThreatRows();
  renderEvaluationRows();

  startStopButton.textContent = emulatorActive ? 'Stop' : 'Start';
  startStopButton.classList.toggle('primary', !emulatorActive);
  startStopButton.classList.toggle('danger', emulatorActive);
  stayAwakeButton.textContent = wakeLock ? 'Allow sleep' : 'Stay awake';
  stayAwakeButton.setAttribute('aria-pressed', String(wakeLock !== null));
  stayAwakeButton.classList.toggle('awake-active', wakeLock !== null);
}

function updateEvaluationCountdown(): void {
  const countdown = getElement('evaluationCountdown');
  const pulse = getElement('evaluationPulse');

  if (!emulatorActive) {
    countdown.textContent = 'Updates stopped';
  } else if (evaluationInFlight) {
    countdown.textContent = 'Calculating threats...';
  } else {
    const remainingMs = Math.max(0, (nextEvaluationAtMs ?? Date.now()) - Date.now());
    countdown.textContent = `Next threat check in ${(remainingMs / 1000).toFixed(1)} s`;
  }

  pulse.classList.toggle('calculating', emulatorActive && evaluationInFlight);
}

function highlightNewEvaluation(): void {
  const warningBand = getElement('warningBand');
  const evaluationPanel = getElement('evaluationPanel');

  if (highlightTimer !== null) {
    window.clearTimeout(highlightTimer);
  }
  warningBand.classList.remove('evaluation-updated');
  evaluationPanel.classList.remove('evaluation-updated');
  void warningBand.offsetWidth;
  warningBand.classList.add('evaluation-updated');
  evaluationPanel.classList.add('evaluation-updated');
  highlightTimer = window.setTimeout(() => {
    warningBand.classList.remove('evaluation-updated');
    evaluationPanel.classList.remove('evaluation-updated');
    highlightTimer = null;
  }, 900);
}

function renderCsvImportStatus(): string {
  const rows: string[] = [];

  if (!csvResult) {
    rows.push(`<div class="summary-row"><span>CSV</span><strong class="muted">${escapeHtml(csvInput.files?.[0]?.name ?? 'No file selected')}</strong></div>`);
    return rows.join('');
  }

  rows.push(`<div class="summary-row"><span>CSV file</span><strong>${escapeHtml(csvResult.fileName)}</strong></div>`);
  for (const error of csvResult.errors) {
    rows.push(`<div class="summary-row"><span>File error</span><strong class="bad">${escapeHtml(error)}</strong></div>`);
  }
  for (const invalid of csvResult.invalidRows.slice(0, 8)) {
    rows.push(`<div class="summary-row"><span>Row ${invalid.rowNumber}</span><strong class="bad">${escapeHtml(invalid.errors.join(' '))}</strong></div>`);
  }

  return rows.join('');
}

function renderTerrainImportStatus(): string {
  const rows: string[] = [];

  if (!terrainMetadata) {
    rows.push(`<div class="summary-row"><span>GeoTIFF</span><strong class="muted">${escapeHtml(terrainInput.files?.[0]?.name ?? 'No file selected')}</strong></div>`);
  } else {
    rows.push(`<div class="summary-row"><span>GeoTIFF file</span><strong>${escapeHtml(terrainMetadata.fileName)}</strong></div>`);
    rows.push(`<div class="summary-row"><span>Coverage</span><strong>${terrainMetadata.bbox.map((value) => value.toFixed(4)).join(', ')}</strong></div>`);
    for (const warning of terrainMetadata.warnings) {
      rows.push(`<div class="summary-row"><span>GeoTIFF warning</span><strong class="warn">${escapeHtml(warning)}</strong></div>`);
    }
  }

  if (persistentTerrainSupported && rememberedTerrainFileName) {
    rows.push(`<div class="summary-row"><span>Remembered GeoTIFF</span><strong>${escapeHtml(rememberedTerrainFileName)}</strong></div>`);
  }

  return rows.join('');
}

function renderAgl(): string {
  if (aircraftState?.aglM !== null && aircraftState?.aglM !== undefined) {
    const fallback = lastAircraftTerrainReason ? ' (last terrain)' : '';
    return `${metersToFeet(aircraftState.aglM)} ft${fallback}`;
  }
  return lastAircraftTerrainReason ? `-- (${lastAircraftTerrainReason})` : '--';
}

function renderTrack(): string {
  if (!aircraftState || aircraftState.trackDegrees === null) {
    return 'Unavailable';
  }
  const age = aircraftState.trackAgeMs !== null ? `, ${Math.round(aircraftState.trackAgeMs / 1000)} s` : '';
  return `${aircraftState.trackDegrees.toFixed(0)} deg (${aircraftState.trackSource}${age})`;
}

function renderThreatRows(): void {
  const tbody = getElement<HTMLTableSectionElement>('threatRows');
  const threats = csvResult?.threats ?? [];
  if (threats.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No valid threats loaded.</td></tr>';
    return;
  }

  tbody.innerHTML = threats
    .slice(0, 10)
    .map(
      (threat) => `
        <tr>
          <td>${escapeHtml(threat.id)}</td>
          <td>${escapeHtml(threat.name)}</td>
          <td>${threat.latitude.toFixed(5)}, ${threat.longitude.toFixed(5)}</td>
          <td>${formatThreatRange(threat.rangeKm)}</td>
        </tr>
      `
    )
    .join('');
}

function renderEvaluationRows(): void {
  const tbody = getElement<HTMLTableSectionElement>('evaluationRows');
  const results = lastEvaluation?.results ?? [];
  if (results.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No evaluation results.</td></tr>';
    return;
  }

  tbody.innerHTML = results
    .map((result) => {
      const className =
        result.state === 'active'
          ? 'bad'
          : result.state === 'terrain unavailable' || result.state === 'aircraft state unavailable'
            ? 'warn'
            : 'good';
      return `
        <tr>
          <td>${escapeHtml(result.threat.name)}</td>
          <td class="${className}">${result.state.toUpperCase()}</td>
          <td>${result.distanceKm === null ? '--' : formatThreatRange(result.distanceKm)}</td>
          <td>${escapeHtml(result.reason)}</td>
        </tr>
      `;
    })
    .join('');
}

function setMessage(message: string, tone: 'normal' | 'warning' | 'error'): void {
  appMessage = message;
  appMessageTone = tone;
}

function metersToFeet(meters: number): string {
  return (meters * FEET_PER_METER).toFixed(0);
}

function setText(id: string, value: string): void {
  getElement(id).textContent = value;
}

function getElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return element as T;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

render();
geolocationTracker.start();
void restoreRememberedTerrain({ requestPermission: false, startup: true });
