import { registerSW } from 'virtual:pwa-register';
import { parseThreatCsvFile, serializeThreatCsv } from './domain/csv';
import { calculateAgl, evaluateThreats, resolveTerrainElevationM } from './domain/evaluation';
import { Egm96GeoidModel } from './domain/geoid';
import { formatThreatRange } from './domain/geo';
import { buildThreatFromEditor, type ThreatPositionMode } from './domain/threat-editor';
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
  Threat,
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
let threats: Threat[] = [];
let threatsModified = false;
let threatRevision = 0;
let editingThreatIndex: number | null = null;
let terrainMetadata: TerrainMetadata | null = null;
let terrainLoadedFromPersistentHandle = false;
let rememberedTerrainFileName: string | null = null;
let aircraftState: AircraftState | null = null;
let latestAircraftFixTimestampMs: number | null = null;
let lastAircraftTerrainElevationM: number | null = null;
let lastAircraftTerrainReason: string | null = null;
let geolocationStatus: GeolocationStatus = 'idle';
let geolocationMessage = 'GNSS watch starting.';
let appMessage = 'Import threats from CSV or add them manually, optionally import an elevation GeoTIFF, grant GNSS permission, then start the emulator.';
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

      <details class="panel collapsible-panel">
        <summary class="panel-header">Aircraft Status</summary>
        <div class="panel-body">
          <div class="status-grid">
            <div class="metric"><span class="metric-label">Latitude</span><span id="latValue" class="metric-value">--</span></div>
            <div class="metric"><span class="metric-label">Longitude</span><span id="lonValue" class="metric-value">--</span></div>
            <div class="metric"><span class="metric-label">GPS altitude</span><span id="altValue" class="metric-value">--</span></div>
            <div class="metric"><span class="metric-label">Height above ground</span><span id="aglValue" class="metric-value">--</span></div>
            <div class="metric"><span class="metric-label">GPS precision</span><span id="precisionValue" class="metric-value">--</span></div>
            <div class="metric"><span class="metric-label">Track</span><span id="trackValue" class="metric-value">--</span></div>
          </div>
        </div>
      </details>

      <details id="evaluationPanel" class="panel collapsible-panel threat-panel">
        <summary class="panel-header">Threats</summary>
        <div class="panel-body">
          <div class="threat-toolbar">
            <div class="threat-toolbar-copy">
              <strong>Threat list</strong>
              <span class="muted">Import a CSV or manage threats here.</span>
            </div>
            <div class="threat-toolbar-actions">
              <button id="exportThreatsButton" class="compact-button" type="button" hidden>Export CSV</button>
              <button id="addThreatButton" class="primary compact-button" type="button">Add threat</button>
            </div>
          </div>

          <form id="threatEditor" class="threat-editor" hidden novalidate>
            <div class="editor-heading">
              <div>
                <h2 id="threatEditorTitle">Add threat</h2>
                <p class="muted">Enter WGS84 or MGRS coordinates, or place the threat from the latest aircraft position.</p>
              </div>
            </div>

            <div class="editor-grid">
              <label class="field" for="threatId">ID
                <input id="threatId" name="id" type="text" autocomplete="off" required />
              </label>
              <label class="field" for="threatName">Description
                <input id="threatName" name="name" type="text" autocomplete="off" placeholder="Optional" />
              </label>
              <label class="field" for="threatHeightAglM">Height AGL (m, optional)
                <input id="threatHeightAglM" name="heightAglM" type="text" inputmode="decimal" />
                <span class="field-hint muted">Leave blank for a magic threat that always has clear line of sight.</span>
              </label>
              <label class="field" for="threatRangeKm">Effective range (km)
                <input id="threatRangeKm" name="rangeKm" type="text" inputmode="decimal" required />
              </label>
            </div>

            <fieldset class="position-fieldset">
              <legend>Position</legend>
              <div class="position-options">
                <label><input type="radio" name="positionMode" value="coordinates" checked /> Coordinates</label>
                <label><input type="radio" name="positionMode" value="mgrs" /> MGRS</label>
                <label><input type="radio" name="positionMode" value="relative" /> Relative to aircraft</label>
              </div>

              <div id="coordinatePositionFields" class="editor-grid position-fields">
                <label class="field" for="threatLatitude">Latitude
                  <input id="threatLatitude" name="latitude" type="text" inputmode="decimal" placeholder="50.0755" />
                </label>
                <label class="field" for="threatLongitude">Longitude
                  <input id="threatLongitude" name="longitude" type="text" inputmode="decimal" placeholder="14.4378" />
                </label>
              </div>

              <div id="mgrsPositionFields" class="editor-grid position-fields" hidden>
                <label class="field full-width-field" for="threatMgrs">MGRS coordinate
                  <input id="threatMgrs" name="mgrs" type="text" autocomplete="off" autocapitalize="characters" placeholder="33U VR 59772 47176" />
                  <span class="muted">Spaces are optional. Precision determines the center point used for the threat.</span>
                </label>
              </div>

              <div id="relativePositionFields" class="editor-grid position-fields" hidden>
                <label class="field" for="threatBearing">True bearing from aircraft (deg)
                  <input id="threatBearing" name="bearingDegrees" type="text" inputmode="decimal" placeholder="0-360" />
                </label>
                <label class="field" for="threatDistanceKm">Distance from aircraft (km)
                  <input id="threatDistanceKm" name="distanceKm" type="text" inputmode="decimal" />
                </label>
                <p id="relativePositionHint" class="field-hint muted"></p>
              </div>
            </fieldset>

            <div id="threatEditorErrors" class="editor-errors" role="alert" hidden></div>
            <div class="editor-actions">
              <button id="cancelThreatButton" type="button">Cancel</button>
              <button class="primary" type="submit">Save threat</button>
            </div>
          </form>

          <div class="table-wrap">
            <table class="threat-table">
              <thead>
                <tr>
                  <th><span>ID</span><span>Description</span></th>
                  <th><span>Distance</span><span>Range</span></th>
                  <th><span>LOS</span><span>State</span></th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="threatRows"></tbody>
            </table>
          </div>
        </div>
      </details>

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
const addThreatButton = getElement<HTMLButtonElement>('addThreatButton');
const exportThreatsButton = getElement<HTMLButtonElement>('exportThreatsButton');
const threatEditor = getElement<HTMLFormElement>('threatEditor');
const cancelThreatButton = getElement<HTMLButtonElement>('cancelThreatButton');
const threatRows = getElement<HTMLTableSectionElement>('threatRows');

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

addThreatButton.addEventListener('click', () => {
  openThreatEditor();
});

exportThreatsButton.addEventListener('click', () => {
  exportThreats();
});

cancelThreatButton.addEventListener('click', () => {
  closeThreatEditor();
});

threatEditor.addEventListener('change', (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.name === 'positionMode') {
    updatePositionModeFields();
  }
});

threatEditor.addEventListener('submit', (event) => {
  event.preventDefault();
  saveThreatEditor();
});

threatRows.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-threat-action]');
  if (!button) {
    return;
  }
  const index = Number(button.dataset.threatIndex);
  if (!Number.isInteger(index) || !threats[index]) {
    return;
  }
  if (button.dataset.threatAction === 'edit') {
    openThreatEditor(index);
  } else if (button.dataset.threatAction === 'delete') {
    deleteThreat(index);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stayAwakeRequested && wakeLock === null) {
    void acquireWakeLock();
  }
});

function openThreatEditor(index: number | null = null): void {
  const threat = index === null ? null : threats[index];
  if (index !== null && !threat) {
    return;
  }

  editingThreatIndex = index;
  threatEditor.reset();
  setInputValue('threatId', threat?.id ?? nextThreatId());
  setInputValue('threatName', threat?.name ?? '');
  setInputValue(
    'threatHeightAglM',
    threat?.heightAglM === null || !threat ? '' : String(threat.heightAglM)
  );
  setInputValue('threatRangeKm', threat ? String(threat.rangeKm) : '');
  setInputValue('threatLatitude', threat ? String(threat.latitude) : '');
  setInputValue('threatLongitude', threat ? String(threat.longitude) : '');
  setInputValue('threatMgrs', '');
  setInputValue('threatBearing', '');
  setInputValue('threatDistanceKm', '');
  getElement('threatEditorTitle').textContent = threat ? `Edit ${threat.id}` : 'Add threat';
  getElement('threatEditorErrors').hidden = true;
  threatEditor.hidden = false;
  getElement<HTMLDetailsElement>('evaluationPanel').open = true;
  updatePositionModeFields();
  getElement<HTMLInputElement>('threatId').focus();
}

function exportThreats(): void {
  if (threats.length === 0) {
    return;
  }

  try {
    const csv = serializeThreatCsv(threats);
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `threats-${new Date().toISOString().slice(0, 10)}.csv`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setMessage(`${threats.length} threat${threats.length === 1 ? '' : 's'} exported to CSV.`, 'normal');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Unable to export threats.', 'error');
  }
  render();
}

function closeThreatEditor(): void {
  editingThreatIndex = null;
  threatEditor.hidden = true;
  getElement('threatEditorErrors').hidden = true;
}

function updatePositionModeFields(): void {
  const positionMode = selectedThreatPositionMode();
  getElement('coordinatePositionFields').hidden = positionMode !== 'coordinates';
  getElement('mgrsPositionFields').hidden = positionMode !== 'mgrs';
  getElement('relativePositionFields').hidden = positionMode !== 'relative';
  getElement('relativePositionHint').textContent = aircraftState
    ? `Aircraft reference: ${aircraftState.latitude.toFixed(6)}, ${aircraftState.longitude.toFixed(6)}`
    : 'Waiting for an aircraft GNSS position.';
}

function saveThreatEditor(): void {
  const result = buildThreatFromEditor(
    {
      id: inputValue('threatId'),
      name: inputValue('threatName'),
      heightAglM: inputValue('threatHeightAglM'),
      rangeKm: inputValue('threatRangeKm'),
      positionMode: selectedThreatPositionMode(),
      latitude: inputValue('threatLatitude'),
      longitude: inputValue('threatLongitude'),
      mgrs: inputValue('threatMgrs'),
      bearingDegrees: inputValue('threatBearing'),
      distanceKm: inputValue('threatDistanceKm')
    },
    aircraftState,
    threats.filter((_, index) => index !== editingThreatIndex).map((threat) => threat.id)
  );

  if (!('threat' in result)) {
    const errors = getElement('threatEditorErrors');
    errors.textContent = result.errors.join(' ');
    errors.hidden = false;
    return;
  }

  const previous = editingThreatIndex === null ? null : threats[editingThreatIndex];
  if (editingThreatIndex === null) {
    threats = [...threats, result.threat];
  } else {
    threats = threats.map((threat, index) => index === editingThreatIndex ? result.threat : threat);
  }
  closeThreatEditor();
  commitThreatChange(previous ? `Threat ${previous.id} updated.` : `Threat ${result.threat.id} added.`);
}

function deleteThreat(index: number): void {
  const threat = threats[index];
  const description = threat.name ? ` (${threat.name})` : '';
  if (!window.confirm(`Delete threat ${threat.id}${description}?`)) {
    return;
  }
  threats = threats.filter((_, threatIndex) => threatIndex !== index);
  closeThreatEditor();
  commitThreatChange(`Threat ${threat.id} deleted.`);
}

function commitThreatChange(message: string): void {
  threatsModified = true;
  threatRevision += 1;
  lastEvaluation = null;

  if (emulatorActive && threats.length === 0) {
    stopEmulator(`${message} Emulator stopped because no threats remain.`);
    return;
  }

  setMessage(message, 'normal');
  render();
  if (emulatorActive) {
    void evaluateNow();
  }
}

function selectedThreatPositionMode(): ThreatPositionMode {
  const value = threatEditor.querySelector<HTMLInputElement>('input[name="positionMode"]:checked')?.value;
  return value === 'mgrs' || value === 'relative' ? value : 'coordinates';
}

function inputValue(id: string): string {
  return getElement<HTMLInputElement>(id).value;
}

function setInputValue(id: string, value: string): void {
  getElement<HTMLInputElement>(id).value = value;
}

function nextThreatId(): string {
  const ids = new Set(threats.map((threat) => threat.id));
  let number = 1;
  while (ids.has(`T${String(number).padStart(3, '0')}`)) {
    number += 1;
  }
  return `T${String(number).padStart(3, '0')}`;
}

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
  if (threatsModified && threats.length > 0 && !window.confirm('Replace the locally edited threat list with this CSV?')) {
    csvInput.value = '';
    return;
  }

  csvResult = await parseThreatCsvFile(file);
  threats = [...csvResult.threats];
  threatsModified = false;
  threatRevision += 1;
  lastEvaluation = null;
  closeThreatEditor();

  if (csvResult.errors.length > 0) {
    setMessage(csvResult.errors.join(' '), 'error');
  } else if (csvResult.invalidRows.length > 0) {
    setMessage(`${csvResult.threats.length} valid threats loaded; ${csvResult.invalidRows.length} rows need correction.`, 'warning');
  } else {
    setMessage(`${csvResult.threats.length} valid threats loaded from ${file.name}.`, 'normal');
  }
  render();
  if (emulatorActive && threats.length === 0) {
    const loadMessage = appMessage;
    const loadTone = appMessageTone;
    stopEmulator('Emulator stopped because no threats remain.');
    setMessage(`${loadMessage} Emulator stopped because no threats remain.`, loadTone);
    render();
  } else if (emulatorActive) {
    void evaluateNow();
  }
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
  const evaluatedRevision = threatRevision;
  render();
  let evaluationCompleted = false;
  try {
    const evaluation = await evaluateThreats([...threats], aircraftState, terrainService);
    if (evaluatedRevision !== threatRevision) {
      return;
    }
    lastEvaluation = evaluation;
    evaluationCompleted = true;
    const activeCount = lastEvaluation.results.filter((result) => result.state === 'active').length;
    const evaluationMessage = activeCount > 0
      ? `${activeCount} active threat${activeCount === 1 ? '' : 's'} detected.`
      : 'No active threats detected.';
    const terrainMessage = terrainMetadata
      ? ''
      : ' No elevation model is loaded; line of sight is assumed clear.';
    setMessage(
      `${evaluationMessage}${terrainMessage}`,
      activeCount > 0 || !terrainMetadata ? 'warning' : 'normal'
    );
  } catch (error) {
    if (evaluatedRevision === threatRevision) {
      setMessage(error instanceof Error ? error.message : 'Threat evaluation failed.', 'error');
    }
  } finally {
    evaluationInFlight = false;
    render();
    if (evaluationCompleted) {
      highlightNewEvaluation();
    }
    if (evaluatedRevision !== threatRevision && emulatorActive && threats.length > 0) {
      void evaluateNow();
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
  if (threats.length === 0) {
    return 'Import a valid threat CSV or add a threat before activating the emulator.';
  }
  if (!aircraftState) {
    return 'Grant GNSS permission and wait for an aircraft position before activating the emulator.';
  }
  if (aircraftState.gpsAltitudeM === null && threats.every((threat) => threat.heightAglM !== null)) {
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
  exportThreatsButton.hidden = threats.length === 0;
  if (!threatEditor.hidden) {
    updatePositionModeFields();
  }

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
    if (threats.length > 0) {
      rows.push(`<div class="summary-row"><span>Manual threats</span><strong>${threats.length}</strong></div>`);
    }
    return rows.join('');
  }

  rows.push(`<div class="summary-row"><span>CSV file</span><strong>${escapeHtml(csvResult.fileName)}</strong></div>`);
  if (threatsModified) {
    rows.push('<div class="summary-row"><span>Threat list</span><strong class="warn">Edited locally</strong></div>');
  }
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
    const terrainStatus = terrainInput.files?.[0]?.name ?? 'Not loaded - LOS assumed clear';
    rows.push(`<div class="summary-row"><span>GeoTIFF</span><strong class="muted">${escapeHtml(terrainStatus)}</strong></div>`);
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
  if (threats.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No threats yet. Import a CSV or add one manually.</td></tr>';
    return;
  }

  const evaluationsByThreatId = new Map(
    (lastEvaluation?.results ?? []).map((result) => [result.threat.id, result])
  );

  tbody.innerHTML = threats
    .map((threat, index) => {
      const result = evaluationsByThreatId.get(threat.id);
      const distanceClass =
        result?.distanceKm === null || result?.distanceKm === undefined
          ? ''
          : result.distanceKm <= threat.rangeKm
            ? 'good'
            : 'bad';
      const lineOfSight =
        threat.heightAglM === null
          ? 'ALWAYS'
          : result?.lineOfSight?.status === 'clear'
            ? 'VLOS'
            : result?.lineOfSight?.status === 'blocked'
              ? 'BLOS'
              : '--';
      const lineOfSightClass =
        threat.heightAglM === null || result?.lineOfSight?.status === 'clear'
          ? 'good'
          : result?.lineOfSight?.status === 'blocked'
            ? 'bad'
            : '';
      const stateClass =
        result?.state === 'active'
          ? 'good'
          : result?.state === 'inactive'
            ? 'bad'
            : result
              ? 'warn'
              : '';

      return `
        <tr>
          <td>
            <span class="table-primary">${escapeHtml(threat.id)}</span>
            <span class="table-secondary${threat.name ? '' : ' muted'}">${escapeHtml(threat.name || 'No description')}</span>
          </td>
          <td>
            <span class="table-primary ${distanceClass}">${result?.distanceKm === null || result?.distanceKm === undefined ? '--' : formatThreatRange(result.distanceKm)}</span>
            <span class="table-secondary">${formatThreatRange(threat.rangeKm)}</span>
          </td>
          <td>
            <span class="table-primary ${lineOfSightClass}">${lineOfSight}</span>
            <span class="table-secondary ${stateClass}">${result ? result.state.toUpperCase() : 'NOT EVALUATED'}</span>
          </td>
          <td>
            <div class="table-actions">
              <button type="button" class="table-action" data-threat-action="edit" data-threat-index="${index}" aria-label="Edit threat ${escapeHtml(threat.id)}">Edit</button>
              <button type="button" class="table-action delete-action" data-threat-action="delete" data-threat-index="${index}" aria-label="Delete threat ${escapeHtml(threat.id)}">Delete</button>
            </div>
          </td>
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
