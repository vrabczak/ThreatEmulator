/**
 * Owns Leaflet map lifecycle, threat-position gestures, and connectivity state.
 * Native Leaflet controls inside the map own base-map selection and aircraft following.
 * It defers map creation until the collapsed map panel is opened to avoid hidden-size issues.
 */

import type { AircraftState, Threat } from '../domain/types';
import { ThreatMap } from '../services/threat-map';
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

  /**
   * Creates the controller and binds panel, provider, and connectivity events.
   * @param options - Accessors for the latest aircraft and threat state.
   */
  public constructor(private readonly options: MapControllerOptions) {
    this.map = new ThreatMap({
      onCoordinateSelected: (latitude, longitude) => {
        this.options.onCoordinateSelected(latitude, longitude);
      }
    });

    this.panel.addEventListener('toggle', () => {
      if (!this.panel.open) {
        return;
      }
      this.map.initialize(getElement('threatMap'), navigator.onLine);
      this.update(this.options.getAircraftState(), this.options.getThreats());
      window.requestAnimationFrame(() => this.map.invalidateSize());
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
    this.map.setConnectivity(navigator.onLine);
  }

  private renderConnectivity(): void {
    const online = navigator.onLine;
    const status = getElement('mapConnectivity');
    status.textContent = online ? 'Online - map tiles available' : 'Offline - overlays only';
    status.classList.toggle('offline', !online);
  }
}
