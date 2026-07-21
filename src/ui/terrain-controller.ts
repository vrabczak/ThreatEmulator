/**
 * Owns terrain file selection, persistent file-handle restoration, and GeoTIFF loading UI workflow.
 * Actual GeoTIFF processing is delegated to a TerrainService, while application effects are reported by callbacks.
 */

import type { TerrainMetadata, TerrainService } from '../domain/types';
import {
  forgetPersistentTerrainFile,
  pickPersistentTerrainFile,
  restorePersistentTerrainFile,
  supportsPersistentFilePicker
} from '../services/persistent-file';
import type { MessageTone } from './app-view';
import { getElement } from './dom';

export interface TerrainControllerOptions {
  terrainService: TerrainService;
  onBeforeTerrainLoad: () => void;
  onTerrainChanged: (metadata: TerrainMetadata | null) => void;
  onMessage: (message: string, tone: MessageTone) => void;
  onStateChanged: () => void;
}

type TerrainSource = 'manual' | 'remembered' | 'restored';

/**
 * Coordinates the terrain picker, remembered file handle, metadata loading, and related UI state.
 * One instance serves the mounted page and performs its startup restore at most once.
 */
export class TerrainController {
  private readonly terrainInput = getElement<HTMLInputElement>('terrainInput');
  private readonly persistentFileSupported = supportsPersistentFilePicker();
  private terrainMetadata: TerrainMetadata | null = null;
  private rememberedFileName: string | null = null;
  private rememberedFileLookupComplete = !this.persistentFileSupported;
  private started = false;

  /**
   * Creates the terrain controller and binds the mounted terrain import controls.
   * @param options - Terrain service and application coordination callbacks.
   */
  public constructor(private readonly options: TerrainControllerOptions) {
    this.bindControls();
  }

  /**
   * Gets metadata for the terrain presented as active by the application.
   * @returns Loaded metadata, or `null` when no terrain is active.
   */
  public get metadata(): TerrainMetadata | null {
    return this.terrainMetadata;
  }

  /**
   * Reports whether this browser supports remembered file handles.
   * @returns `true` when the persistent file picker API is available.
   */
  public get persistentSupported(): boolean {
    return this.persistentFileSupported;
  }

  /**
   * Gets the name of the remembered terrain file, if one is available.
   * @returns The remembered filename or `null`.
   */
  public get rememberedTerrainFileName(): string | null {
    return this.rememberedFileName;
  }

  /**
   * Reports whether the startup check for a remembered terrain file has finished.
   * @returns `true` once remembered-file availability is known.
   */
  public get rememberedTerrainLookupComplete(): boolean {
    return this.rememberedFileLookupComplete;
  }

  /**
   * Attempts the one-time, non-interactive restoration of a remembered terrain file.
   * @returns Nothing.
   */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.restoreRememberedTerrain({ requestPermission: false, startup: true }).finally(() => {
      this.rememberedFileLookupComplete = true;
      this.options.onStateChanged();
    });
  }

  private bindControls(): void {
    const terrainImportButton = getElement<HTMLButtonElement>('terrainImportButton');
    this.terrainInput.addEventListener('change', () => {
      const file = this.terrainInput.files?.[0];
      if (file) {
        void this.loadManualTerrain(file);
      }
    });
    terrainImportButton.addEventListener('click', () => void this.importTerrain());
  }

  private async loadManualTerrain(file: File): Promise<void> {
    this.rememberedFileName = null;
    if (this.persistentFileSupported) {
      void forgetPersistentTerrainFile().catch(() => undefined);
    }
    await this.loadTerrain(file, 'manual');
  }

  private async importTerrain(): Promise<void> {
    if (this.persistentFileSupported && this.rememberedFileName) {
      const shouldRestore = window.confirm(
        `Restore remembered GeoTIFF "${this.rememberedFileName}"? Choose Cancel to import another file.`
      );
      if (shouldRestore) {
        await this.restoreRememberedTerrain({ requestPermission: true, startup: false });
        return;
      }
    }

    await this.pickNewTerrain();
  }

  private async pickNewTerrain(): Promise<void> {
    if (this.persistentFileSupported) {
      await this.pickAndRememberTerrain();
      return;
    }
    this.terrainInput.click();
  }

  private async pickAndRememberTerrain(): Promise<void> {
    try {
      const file = await pickPersistentTerrainFile();
      if (!file) {
        return;
      }
      this.rememberedFileName = file.name;
      await this.loadTerrain(file, 'remembered');
    } catch (error) {
      this.options.onMessage(error instanceof Error ? error.message : 'Unable to remember GeoTIFF.', 'error');
      this.options.onStateChanged();
    }
  }

  private async restoreRememberedTerrain(options: {
    requestPermission: boolean;
    startup: boolean;
  }): Promise<boolean> {
    if (!this.persistentFileSupported) {
      if (!options.startup) {
        this.options.onMessage('Persistent GeoTIFF restore is not supported by this browser.', 'warning');
        this.options.onStateChanged();
      }
      return false;
    }

    const restored = await restorePersistentTerrainFile({ requestPermission: options.requestPermission });
    if (restored.status === 'loaded') {
      this.rememberedFileName = restored.file.name;
      await this.loadTerrain(restored.file, 'restored');
      return true;
    }
    if (restored.status === 'permission-needed') {
      this.rememberedFileName = restored.fileName;
      this.options.onMessage(
        `Previous GeoTIFF ${restored.fileName} is remembered. Use Import to restore it or import another file.`,
        'warning'
      );
      this.options.onStateChanged();
      return false;
    }
    if (restored.status === 'unavailable') {
      this.rememberedFileName = restored.fileName;
      this.options.onMessage(restored.reason, 'error');
      this.options.onStateChanged();
      return false;
    }
    if (!options.startup) {
      this.options.onMessage('No remembered GeoTIFF is available.', 'warning');
      this.options.onStateChanged();
    }
    return false;
  }

  private async loadTerrain(file: File, source: TerrainSource): Promise<void> {
    this.options.onBeforeTerrainLoad();
    this.terrainMetadata = null;
    this.options.onTerrainChanged(null);
    this.options.onMessage(`Loading GeoTIFF metadata from ${file.name}.`, 'normal');
    this.options.onStateChanged();

    try {
      this.terrainMetadata = await this.options.terrainService.loadGeoTiff(file);
      this.options.onTerrainChanged(this.terrainMetadata);
      const warningText =
        this.terrainMetadata.warnings.length > 0 ? ` ${this.terrainMetadata.warnings.join(' ')}` : '';
      const persistenceText =
        source === 'remembered'
          ? ' GeoTIFF will be remembered on future launches.'
          : source === 'restored'
            ? ' Restored from remembered GeoTIFF.'
            : '';
      this.options.onMessage(
        `Terrain loaded: ${this.terrainMetadata.width} x ${this.terrainMetadata.height} cells.${warningText}${persistenceText}`,
        this.terrainMetadata.warnings.length > 0 ? 'warning' : 'normal'
      );
    } catch (error) {
      this.terrainMetadata = null;
      this.options.onTerrainChanged(null);
      this.options.onMessage(error instanceof Error ? error.message : 'Unable to load GeoTIFF.', 'error');
    }
    this.options.onStateChanged();
  }
}
