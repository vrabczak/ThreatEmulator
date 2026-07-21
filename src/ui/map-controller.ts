/**
 * Owns Leaflet map lifecycle, base-map selection, aircraft-following controls,
 * threat-position gestures, and connectivity state.
 * It defers map creation until the collapsed map panel is opened to avoid hidden-size issues.
 */

import type { AircraftState, Threat } from '../domain/types';
import { ThreatMap, type BaseMapId } from '../services/threat-map';
import { getElement } from './dom';

/** State accessors and interaction callbacks required by the Map panel. */
export interface MapControllerOptions {
  getAircraftState: () => AircraftState | null;
  getThreats: () => Threat[];
  onCoordinateSelected: (latitude: number, longitude: number) => void;
}

/**
 * Coordinates the situational map and its provider controls for the mounted page lifecycle.
 */
export class MapController {
  private readonly map: ThreatMap;
  private readonly panel = getElement<HTMLDetailsElement>('mapPanel');
  private readonly baseLayer = getElement<HTMLSelectElement>('mapBaseLayer');
  private readonly centerOnAircraft = getElement<HTMLInputElement>('centerMapOnAircraft');

  /**
   * Creates the controller and binds panel, provider, and connectivity events.
   * @param options - Accessors for the latest aircraft and threat state.
   */
  public constructor(private readonly options: MapControllerOptions) {
    this.map = new ThreatMap({
      onCoordinateSelected: (latitude, longitude) => {
        this.options.onCoordinateSelected(latitude, longitude);
      },
      onManualMove: () => {
        this.centerOnAircraft.checked = false;
        this.map.setCenterOnAircraft(false, this.options.getAircraftState());
      }
    });
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
    this.centerOnAircraft.addEventListener('change', () => {
      this.map.setCenterOnAircraft(
        this.centerOnAircraft.checked,
        this.options.getAircraftState()
      );
    });
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
    try {
      await this.map.setBaseMap(this.selectedBaseMap(), navigator.onLine);
    } catch (error) {
      // Provider failures remain diagnostic-only because the toolbar no longer displays transient status text.
      console.error('Unable to load the selected base map.', error);
    }
  }

  private selectedBaseMap(): BaseMapId {
    const value = this.baseLayer.value;
    return value === 'topographic' || value === 'google-satellite' ? value : 'street';
  }
}
