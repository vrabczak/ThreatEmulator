/**
 * Owns Leaflet map lifecycle, base-map selection, and online/offline provider status.
 * It defers map creation until the collapsed map panel is opened to avoid hidden-size issues.
 */

import type { AircraftState, Threat } from '../domain/types';
import { ThreatMap, type BaseMapId } from '../services/threat-map';
import { getElement } from './dom';

export interface MapControllerOptions {
  getAircraftState: () => AircraftState | null;
  getThreats: () => Threat[];
}

/**
 * Coordinates the situational map and its provider controls for the mounted page lifecycle.
 */
export class MapController {
  private readonly map = new ThreatMap();
  private readonly panel = getElement<HTMLDetailsElement>('mapPanel');
  private readonly baseLayer = getElement<HTMLSelectElement>('mapBaseLayer');
  private baseLayerRequest = 0;

  /**
   * Creates the controller and binds panel, provider, and connectivity events.
   * @param options - Accessors for the latest aircraft and threat state.
   */
  public constructor(private readonly options: MapControllerOptions) {
    const googleSatelliteOption = getElement<HTMLOptionElement>('googleSatelliteOption');
    googleSatelliteOption.disabled = !this.map.hasGoogleImagery();
    if (googleSatelliteOption.disabled) {
      googleSatelliteOption.textContent = 'Google satellite (API key required)';
    }

    this.panel.addEventListener('toggle', () => {
      if (!this.panel.open) {
        return;
      }
      this.map.initialize(getElement('threatMap'), navigator.onLine);
      void this.applyBaseLayer();
      this.update(this.options.getAircraftState(), this.options.getThreats());
      window.requestAnimationFrame(() => this.map.invalidateSize());
    });
    this.baseLayer.addEventListener('change', () => void this.applyBaseLayer());
    window.addEventListener('online', () => this.handleConnectivityChange());
    window.addEventListener('offline', () => this.handleConnectivityChange());
    this.renderConnectivity();
  }

  /**
   * Updates the aircraft and threat overlays from current application state.
   * @param aircraftState - Latest fully converted aircraft state, if available.
   * @param threats - Current editable threat list.
   * @returns Nothing.
   */
  public update(aircraftState: AircraftState | null, threats: Threat[]): void {
    this.map.update(aircraftState, threats);
  }

  private handleConnectivityChange(): void {
    this.renderConnectivity();
    void this.applyBaseLayer();
  }

  private renderConnectivity(): void {
    const online = navigator.onLine;
    const status = getElement('mapConnectivity');
    status.textContent = online ? 'Online - map tiles available' : 'Offline - overlays only';
    status.classList.toggle('offline', !online);
  }

  private async applyBaseLayer(): Promise<void> {
    const request = ++this.baseLayerRequest;
    const status = getElement('mapProviderStatus');
    const baseMap = this.selectedBaseMap();
    status.classList.remove('error');
    status.textContent = navigator.onLine
      ? baseMap === 'google-satellite' ? 'Loading Google imagery...' : 'Loading map tiles...'
      : 'Selected base map will return when online.';

    try {
      await this.map.setBaseMap(baseMap, navigator.onLine);
      if (request !== this.baseLayerRequest) {
        return;
      }
      status.textContent = navigator.onLine
        ? baseMap === 'street'
          ? 'OpenStreetMap selected.'
          : baseMap === 'topographic' ? 'OpenTopoMap selected.' : 'Google satellite selected.'
        : 'Selected base map will return when online.';
    } catch (error) {
      if (request !== this.baseLayerRequest) {
        return;
      }
      status.textContent = error instanceof Error ? error.message : 'Unable to load the selected base map.';
      status.classList.add('error');
    }
  }

  private selectedBaseMap(): BaseMapId {
    const value = this.baseLayer.value;
    return value === 'topographic' || value === 'google-satellite' ? value : 'street';
  }
}
