/**
 * Owns the Threat Emulator's page-lifetime state and coordinates imports, GNSS, terrain, evaluation, and rendering.
 * The mounted application shell is assumed to exist before construction; domain calculations and browser resources
 * remain delegated to focused functions, services, and UI controllers.
 */

import { parseThreatCsvFile, serializeThreatCsv } from './domain/csv';
import { evaluateThreats } from './domain/evaluation';
import type {
  Threat,
  ThreatCsvResult,
  ThreatEvaluationSummary
} from './domain/types';
import { reconcileActiveThreatOrder } from './domain/warning';
import { GeolocationTracker, type GeolocationStatus } from './services/geolocation';
import { AircraftAltitudeController } from './services/aircraft-altitude';
import { WorkerTerrainService } from './services/terrain-service';
import { WakeLockController } from './services/wake-lock';
import { highlightNewEvaluation, renderApp, updateEvaluationCountdown, type MessageTone } from './ui/app-view';
import { getElement } from './ui/dom';
import { MapController } from './ui/map-controller';
import { TerrainController } from './ui/terrain-controller';
import { ThreatEditorController } from './ui/threat-editor-controller';

const EVALUATION_INTERVAL_MS = 3000;

/**
 * Coordinates application state and feature controllers for the lifetime of the mounted page.
 * Construction binds UI events, while `start` performs initial rendering and starts asynchronous browser services.
 */
export class ThreatEmulatorApp {
  private readonly terrainService = new WorkerTerrainService();

  private csvResult: ThreatCsvResult | null = null;
  private threats: Threat[] = [];
  private threatsModified = false;
  private threatRevision = 0;
  private geolocationStatus: GeolocationStatus = 'idle';
  private geolocationMessage = 'GNSS watch starting.';
  private appMessage =
    'Import threats from CSV or add them manually, optionally import an elevation GeoTIFF, grant GNSS permission, then start the emulator.';
  private appMessageTone: MessageTone = 'normal';
  private emulatorActive = false;
  private evaluationTimer: number | null = null;
  private countdownTimer: number | null = null;
  private nextEvaluationAtMs: number | null = null;
  private evaluationInFlight = false;
  private lastEvaluation: ThreatEvaluationSummary | null = null;
  private activeThreatOrder: string[] = [];
  private started = false;

  private readonly csvInput: HTMLInputElement;
  private readonly aircraftAltitudeController: AircraftAltitudeController;
  private readonly terrainController: TerrainController;
  private readonly mapController: MapController;
  private readonly threatEditorController: ThreatEditorController;
  private readonly wakeLockController: WakeLockController;
  private readonly geolocationTracker: GeolocationTracker;

  /**
   * Creates the page controller and binds controls from the already-mounted application shell.
   * Browser services remain idle until `start` is called.
   */
  public constructor() {
    this.csvInput = getElement<HTMLInputElement>('csvInput');
    this.aircraftAltitudeController = new AircraftAltitudeController({
      terrainService: this.terrainService,
      onStateChanged: () => this.render()
    });
    this.terrainController = new TerrainController({
      terrainService: this.terrainService,
      onBeforeTerrainLoad: () => {
        this.stopEmulator('Loading replacement terrain.');
        this.lastEvaluation = null;
      },
      onTerrainChanged: (metadata) => this.aircraftAltitudeController.setTerrainMetadata(metadata),
      onMessage: (message, tone) => this.setMessage(message, tone),
      onStateChanged: () => this.render()
    });
    this.threatEditorController = new ThreatEditorController({
      getThreats: () => this.threats,
      getAircraftState: () => this.aircraftAltitudeController.aircraftState,
      onThreatsChanged: (nextThreats, message) => {
        this.threats = nextThreats;
        this.commitThreatChange(message);
      }
    });
    this.mapController = new MapController({
      getAircraftState: () => this.aircraftAltitudeController.aircraftState,
      getThreats: () => this.threats,
      onCoordinateSelected: (latitude, longitude) => {
        this.threatEditorController.placeAtCoordinates(latitude, longitude);
      }
    });
    this.wakeLockController = new WakeLockController({
      onStateChanged: () => this.render(),
      onMessage: (message, tone) => this.setMessage(message, tone)
    });
    this.geolocationTracker = new GeolocationTracker(
      (state) => this.aircraftAltitudeController.acceptFix(state),
      (status, message) => this.handleGeolocationStatus(status, message)
    );
    this.bindControls();
  }

  /**
   * Renders the initial state, starts GNSS tracking, and attempts a non-interactive terrain restore.
   * Repeated calls are ignored because the controller represents one page lifecycle.
   * @returns Nothing.
   */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.render();
    this.geolocationTracker.start();
    this.terrainController.start();
  }

  private bindControls(): void {
    const csvImportButton = getElement<HTMLButtonElement>('csvImportButton');
    const startStopButton = getElement<HTMLButtonElement>('startStopButton');
    const stayAwakeButton = getElement<HTMLButtonElement>('stayAwakeButton');
    const exportThreatsButton = getElement<HTMLButtonElement>('exportThreatsButton');

    this.csvInput.addEventListener('change', () => {
      const file = this.csvInput.files?.[0];
      if (file) {
        void this.loadCsv(file);
      }
    });
    csvImportButton.addEventListener('click', () => this.csvInput.click());
    startStopButton.addEventListener('click', () => {
      if (this.emulatorActive) {
        this.stopEmulator('Emulator stopped.');
      } else {
        this.startEmulator();
      }
    });
    stayAwakeButton.addEventListener('click', () => void this.wakeLockController.toggle());
    exportThreatsButton.addEventListener('click', () => this.exportThreats());
  }

  private handleGeolocationStatus(status: GeolocationStatus, message: string): void {
    this.geolocationStatus = status;
    this.geolocationMessage = message;
    if (status === 'denied' || status === 'unavailable' || status === 'error') {
      this.setMessage(message, 'error');
    }
    this.render();
  }

  private exportThreats(): void {
    if (this.threats.length === 0) {
      return;
    }

    try {
      const csv = serializeThreatCsv(this.threats);
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
      this.setMessage(
        `${this.threats.length} threat${this.threats.length === 1 ? '' : 's'} exported to CSV.`,
        'normal'
      );
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : 'Unable to export threats.', 'error');
    }
    this.render();
  }

  private commitThreatChange(message: string): void {
    this.threatsModified = true;
    this.threatRevision += 1;
    this.lastEvaluation = null;
    const currentThreatIds = new Set(this.threats.map((threat) => threat.id));
    this.activeThreatOrder = this.activeThreatOrder.filter((id) => currentThreatIds.has(id));

    if (this.emulatorActive && this.threats.length === 0) {
      this.stopEmulator(`${message} Emulator stopped because no threats remain.`);
      return;
    }

    this.setMessage(message, 'normal');
    this.render();
    if (this.emulatorActive) {
      void this.evaluateNow();
    }
  }

  private async loadCsv(file: File): Promise<void> {
    if (
      this.threatsModified &&
      this.threats.length > 0 &&
      !window.confirm('Replace the locally edited threat list with this CSV?')
    ) {
      this.csvInput.value = '';
      return;
    }

    this.csvResult = await parseThreatCsvFile(file);
    this.threats = [...this.csvResult.threats];
    this.threatsModified = false;
    this.threatRevision += 1;
    this.lastEvaluation = null;
    this.activeThreatOrder = [];
    this.threatEditorController.close();

    if (this.csvResult.errors.length > 0) {
      this.setMessage(this.csvResult.errors.join(' '), 'error');
    } else if (this.csvResult.invalidRows.length > 0) {
      this.setMessage(
        `${this.csvResult.threats.length} valid threats loaded; ${this.csvResult.invalidRows.length} rows need correction.`,
        'warning'
      );
    } else {
      this.setMessage(`${this.csvResult.threats.length} valid threats loaded from ${file.name}.`, 'normal');
    }
    this.render();
    if (this.emulatorActive && this.threats.length === 0) {
      const loadMessage = this.appMessage;
      const loadTone = this.appMessageTone;
      this.stopEmulator('Emulator stopped because no threats remain.');
      this.setMessage(`${loadMessage} Emulator stopped because no threats remain.`, loadTone);
      this.render();
    } else if (this.emulatorActive) {
      void this.evaluateNow();
    }
  }

  private startEmulator(): void {
    const readinessError = this.getReadinessError();
    if (readinessError) {
      this.setMessage(readinessError, 'error');
      this.render();
      return;
    }
    if (this.emulatorActive) {
      return;
    }

    this.emulatorActive = true;
    this.activeThreatOrder = [];
    this.setMessage('Emulator active. Threats evaluate every 3 seconds.', 'normal');
    this.nextEvaluationAtMs = Date.now() + EVALUATION_INTERVAL_MS;
    void this.evaluateNow();
    this.evaluationTimer = window.setInterval(() => {
      this.nextEvaluationAtMs = Date.now() + EVALUATION_INTERVAL_MS;
      void this.evaluateNow();
    }, EVALUATION_INTERVAL_MS);
    this.countdownTimer = window.setInterval(() => this.renderCountdown(), 200);
    this.render();
  }

  private stopEmulator(message: string): void {
    if (this.evaluationTimer !== null) {
      window.clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.nextEvaluationAtMs = null;
    this.emulatorActive = false;
    this.terrainService.cancelPending();
    this.setMessage(message, 'normal');
    this.render();
  }

  private async evaluateNow(): Promise<void> {
    if (this.evaluationInFlight) {
      return;
    }
    const readinessError = this.getReadinessError();
    if (readinessError) {
      this.setMessage(readinessError, 'error');
      this.render();
      return;
    }

    this.evaluationInFlight = true;
    const evaluatedRevision = this.threatRevision;
    this.render();
    let evaluationCompleted = false;
    try {
      const evaluation = await evaluateThreats(
        [...this.threats],
        this.aircraftAltitudeController.aircraftState,
        this.terrainService
      );
      // Ignore stale async results after an edit, then schedule a fresh evaluation in `finally`.
      if (evaluatedRevision !== this.threatRevision) {
        return;
      }
      this.lastEvaluation = evaluation;
      this.activeThreatOrder = reconcileActiveThreatOrder(this.activeThreatOrder, evaluation.results);
      evaluationCompleted = true;
      const activeCount = this.lastEvaluation.results.filter((result) => result.state === 'active').length;
      const evaluationMessage =
        activeCount > 0
          ? `${activeCount} active threat${activeCount === 1 ? '' : 's'} detected.`
          : 'No active threats detected.';
      const terrainMessage = this.terrainController.metadata
        ? ''
        : ' No elevation model is loaded; line of sight is assumed clear.';
      this.setMessage(
        `${evaluationMessage}${terrainMessage}`,
        activeCount > 0 || !this.terrainController.metadata ? 'warning' : 'normal'
      );
    } catch (error) {
      if (evaluatedRevision === this.threatRevision) {
        this.setMessage(error instanceof Error ? error.message : 'Threat evaluation failed.', 'error');
      }
    } finally {
      this.evaluationInFlight = false;
      this.render();
      if (evaluationCompleted) {
        highlightNewEvaluation();
      }
      if (evaluatedRevision !== this.threatRevision && this.emulatorActive && this.threats.length > 0) {
        void this.evaluateNow();
      }
    }
  }

  private getReadinessError(): string | null {
    if (this.threats.length === 0) {
      return 'Import a valid threat CSV or add a threat before activating the emulator.';
    }
    const aircraftState = this.aircraftAltitudeController.aircraftState;
    if (!aircraftState) {
      return 'Grant GNSS permission and wait for an aircraft position before activating the emulator.';
    }
    if (
      aircraftState.gpsAltitudeM === null &&
      this.threats.every((threat) => threat.heightAglM !== null)
    ) {
      return 'Aircraft GPS altitude is unavailable.';
    }
    return null;
  }

  private render(): void {
    renderApp({
      csvResult: this.csvResult,
      threats: this.threats,
      threatsModified: this.threatsModified,
      terrainMetadata: this.terrainController.metadata,
      persistentTerrainSupported: this.terrainController.persistentSupported,
      rememberedTerrainFileName: this.terrainController.rememberedTerrainFileName,
      aircraftState: this.aircraftAltitudeController.aircraftState,
      lastAircraftTerrainReason: this.aircraftAltitudeController.terrainReason,
      geolocationStatus: this.geolocationStatus,
      geolocationMessage: this.geolocationMessage,
      appMessage: this.appMessage,
      appMessageTone: this.appMessageTone,
      emulatorActive: this.emulatorActive,
      evaluationInFlight: this.evaluationInFlight,
      nextEvaluationAtMs: this.nextEvaluationAtMs,
      lastEvaluation: this.lastEvaluation,
      activeThreatOrder: this.activeThreatOrder,
      wakeLockActive: this.wakeLockController.active
    });
    this.threatEditorController.refreshPositionFields();
    this.mapController.update(this.aircraftAltitudeController.aircraftState, this.threats);
  }

  private renderCountdown(): void {
    updateEvaluationCountdown({
      emulatorActive: this.emulatorActive,
      evaluationInFlight: this.evaluationInFlight,
      nextEvaluationAtMs: this.nextEvaluationAtMs
    });
  }

  private setMessage(message: string, tone: MessageTone): void {
    this.appMessage = message;
    this.appMessageTone = tone;
  }
}
