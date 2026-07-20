/**
 * Boots the Threat Emulator and coordinates top-level imports, GNSS, terrain, and evaluation state.
 * Dedicated UI and browser-service controllers own rendering and feature-specific event lifecycles.
 */

import { registerSW } from 'virtual:pwa-register';
import { parseThreatCsvFile, serializeThreatCsv } from './domain/csv';
import { calculateAgl, evaluateThreats, resolveTerrainElevationM } from './domain/evaluation';
import { reconcileActiveThreatOrder } from './domain/warning';
import { Egm96GeoidModel } from './domain/geoid';
import { GeolocationTracker, type GeolocationStatus } from './services/geolocation';
import {
  forgetPersistentTerrainFile,
  pickPersistentTerrainFile,
  restorePersistentTerrainFile,
  supportsPersistentFilePicker
} from './services/persistent-file';
import { WorkerTerrainService } from './services/terrain-service';
import { WakeLockController } from './services/wake-lock';
import { highlightNewEvaluation, renderApp, updateEvaluationCountdown, type MessageTone } from './ui/app-view';
import { getElement, mountAppShell } from './ui/dom';
import { MapController } from './ui/map-controller';
import { ThreatEditorController } from './ui/threat-editor-controller';
import type {
  AircraftState,
  TerrainMetadata,
  TerrainSample,
  Threat,
  ThreatCsvResult,
  ThreatEvaluationSummary
} from './domain/types';
import './styles.css';

const EVALUATION_INTERVAL_MS = 3000;

registerSW({ immediate: true });

const terrainService = new WorkerTerrainService();
const geoidModel = new Egm96GeoidModel();
const persistentTerrainSupported = supportsPersistentFilePicker();

let csvResult: ThreatCsvResult | null = null;
let threats: Threat[] = [];
let threatsModified = false;
let threatRevision = 0;
let terrainMetadata: TerrainMetadata | null = null;
let rememberedTerrainFileName: string | null = null;
let aircraftState: AircraftState | null = null;
let latestAircraftFixTimestampMs: number | null = null;
let lastAircraftTerrainElevationM: number | null = null;
let lastAircraftTerrainReason: string | null = null;
let geolocationStatus: GeolocationStatus = 'idle';
let geolocationMessage = 'GNSS watch starting.';
let appMessage = 'Import threats from CSV or add them manually, optionally import an elevation GeoTIFF, grant GNSS permission, then start the emulator.';
let appMessageTone: MessageTone = 'normal';
let emulatorActive = false;
let evaluationTimer: number | null = null;
let countdownTimer: number | null = null;
let nextEvaluationAtMs: number | null = null;
let evaluationInFlight = false;
let lastEvaluation: ThreatEvaluationSummary | null = null;
let activeThreatOrder: string[] = [];

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

mountAppShell();

const csvInput = getElement<HTMLInputElement>('csvInput');
const terrainInput = getElement<HTMLInputElement>('terrainInput');
const csvImportButton = getElement<HTMLButtonElement>('csvImportButton');
const startStopButton = getElement<HTMLButtonElement>('startStopButton');
const terrainImportButton = getElement<HTMLButtonElement>('terrainImportButton');
const stayAwakeButton = getElement<HTMLButtonElement>('stayAwakeButton');
const exportThreatsButton = getElement<HTMLButtonElement>('exportThreatsButton');
const mapController = new MapController({
  getAircraftState: () => aircraftState,
  getThreats: () => threats
});
const threatEditorController = new ThreatEditorController({
  getThreats: () => threats,
  getAircraftState: () => aircraftState,
  onThreatsChanged: (nextThreats, message) => {
    threats = nextThreats;
    commitThreatChange(message);
  }
});
const wakeLockController = new WakeLockController({
  onStateChanged: () => render(),
  onMessage: (message, tone) => setMessage(message, tone)
});

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
  void wakeLockController.toggle();
});

exportThreatsButton.addEventListener('click', () => {
  exportThreats();
});

function exportThreats(): void {
  if (threats.length === 0) {
    return;
  }

  try {
    const csv = serializeThreatCsv(threats);
    // The UTF-8 BOM keeps non-ASCII threat names intact in spreadsheet applications.
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

function commitThreatChange(message: string): void {
  threatsModified = true;
  threatRevision += 1;
  lastEvaluation = null;
  const currentThreatIds = new Set(threats.map((threat) => threat.id));
  activeThreatOrder = activeThreatOrder.filter((id) => currentThreatIds.has(id));

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
  activeThreatOrder = [];
  threatEditorController.close();

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
  activeThreatOrder = [];
  setMessage('Emulator active. Threats evaluate every 3 seconds.', 'normal');
  nextEvaluationAtMs = Date.now() + EVALUATION_INTERVAL_MS;
  void evaluateNow();
  evaluationTimer = window.setInterval(() => {
    nextEvaluationAtMs = Date.now() + EVALUATION_INTERVAL_MS;
    void evaluateNow();
  }, EVALUATION_INTERVAL_MS);
  countdownTimer = window.setInterval(renderCountdown, 200);
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
    // Ignore stale async results after an edit, then schedule a fresh evaluation in `finally`.
    if (evaluatedRevision !== threatRevision) {
      return;
    }
    lastEvaluation = evaluation;
    activeThreatOrder = reconcileActiveThreatOrder(activeThreatOrder, evaluation.results);
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

  // Geoid loading/conversion is asynchronous; a newer GNSS fix must always win this race.
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
  // Terrain sampling can finish out of order, so never apply AGL to a newer aircraft fix.
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
  renderApp({
    csvResult,
    threats,
    threatsModified,
    terrainMetadata,
    persistentTerrainSupported,
    rememberedTerrainFileName,
    aircraftState,
    lastAircraftTerrainReason,
    geolocationStatus,
    geolocationMessage,
    appMessage,
    appMessageTone,
    emulatorActive,
    evaluationInFlight,
    nextEvaluationAtMs,
    lastEvaluation,
    activeThreatOrder,
    wakeLockActive: wakeLockController.active
  });
  threatEditorController.refreshPositionFields();
  mapController.update(aircraftState, threats);
}

function renderCountdown(): void {
  updateEvaluationCountdown({ emulatorActive, evaluationInFlight, nextEvaluationAtMs });
}

function setMessage(message: string, tone: MessageTone): void {
  appMessage = message;
  appMessageTone = tone;
}

render();
geolocationTracker.start();
void restoreRememberedTerrain({ requestPermission: false, startup: true });
