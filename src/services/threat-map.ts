/**
 * Renders aircraft and threat overlays on a Leaflet map with selectable online base layers.
 * It supports aircraft-following and threat-position gestures; Google imagery is loaded lazily
 * and requires a Vite-provided API key plus network connectivity. Overlay colors use the
 * semantic CSS variables defined by the application stylesheet.
 */

import L, { type Layer, type LayerGroup, type Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import googleMutantScriptUrl from 'leaflet.gridlayer.googlemutant/dist/Leaflet.GoogleMutant.js?url';
import type { AircraftState, Threat } from '../domain/types';

const DEFAULT_CENTER: L.LatLngExpression = [20, 0];
const DEFAULT_ZOOM = 2;
const GOOGLE_MAPS_SCRIPT_ID = 'google-maps-javascript-api';
const GOOGLE_MUTANT_SCRIPT_ID = 'leaflet-google-mutant';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export type BaseMapId = 'street' | 'topographic' | 'google-satellite';

/** Callbacks used to pass map interactions back to the UI layer. */
export interface ThreatMapOptions {
  onCoordinateSelected: (latitude: number, longitude: number) => void;
  onManualMove: () => void;
}

/**
 * Owns the Leaflet map, overlays, base-layer cache, aircraft-following state, and data fitting.
 * Initialization is idempotent; layer revisions prevent stale asynchronous loads from becoming active.
 */
export class ThreatMap {
  private map: LeafletMap | null = null;
  private overlays: LayerGroup | null = null;
  private readonly baseLayers = new Map<BaseMapId, Layer>();
  private activeBaseLayer: Layer | null = null;
  private selectedBaseMap: BaseMapId = 'street';
  private online = false;
  private baseLayerRevision = 0;
  private lastFittedDataSignature = '';
  private centerOnAircraft = false;
  private isProgrammaticMove = false;
  private readonly googleMapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim() ?? '';

  /**
   * Creates the map service with a callback for user-selected threat positions.
   * @param options - Map interaction callbacks supplied by the UI controller.
   */
  public constructor(private readonly options: ThreatMapOptions) {}

  /**
   * Initializes the map once or refreshes an already initialized map's connectivity and size.
   * @param container - DOM element that hosts Leaflet.
   * @param online - Whether online base-layer requests are currently allowed.
   */
  initialize(container: HTMLElement, online: boolean): void {
    if (this.map) {
      this.online = online;
      this.invalidateSize();
      return;
    }

    this.map = L.map(container, {
      zoomControl: true,
      attributionControl: true,
      // Leaflet translates a stationary touch hold into the same event as a desktop right-click.
      tapHold: true
    }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    this.map.on('contextmenu', (event) => {
      // Repeated map worlds can report longitudes beyond WGS84's validation range.
      const coordinate = event.latlng.wrap();
      this.options.onCoordinateSelected(coordinate.lat, coordinate.lng);
    });
    this.map.on('movestart', () => {
      // Leaflet emits the same event for API-driven and user-driven navigation.
      if (this.centerOnAircraft && !this.isProgrammaticMove) {
        this.centerOnAircraft = false;
        this.options.onManualMove();
      }
    });
    this.overlays = L.layerGroup().addTo(this.map);
    this.online = online;
  }

  /**
   * Enables or disables keeping the map centered on the latest aircraft position.
   * @param enabled - Whether aircraft-following mode is active.
   * @param aircraft - Latest aircraft state, or `null` before a fix is available.
   * @returns Nothing.
   */
  setCenterOnAircraft(enabled: boolean, aircraft: AircraftState | null): void {
    this.centerOnAircraft = enabled;
    if (enabled && aircraft) {
      this.centerMapOnAircraft(aircraft);
    }
  }

  /**
   * Reports whether Google satellite imagery is configured.
   * @returns Whether a non-empty Google Maps API key is available.
   */
  hasGoogleImagery(): boolean {
    return this.googleMapsApiKey.length > 0;
  }

  /**
   * Selects the desired base map and applies it when the browser is online.
   * @param baseMap - Base-map provider to select.
   * @param online - Whether online tile/script loading is currently allowed.
   * @returns A promise that settles after the layer is loaded, applied, or superseded.
   * @throws {Error} When Google imagery lacks an API key or a provider script cannot load.
   */
  async setBaseMap(baseMap: BaseMapId, online: boolean): Promise<void> {
    if (baseMap === 'google-satellite' && !this.hasGoogleImagery()) {
      throw new Error('Google satellite requires VITE_GOOGLE_MAPS_API_KEY.');
    }

    this.selectedBaseMap = baseMap;
    this.online = online;
    // Later selections invalidate slow provider loads so an obsolete layer cannot win the race.
    const revision = ++this.baseLayerRevision;

    if (!this.map) {
      return;
    }

    if (this.activeBaseLayer) {
      this.activeBaseLayer.removeFrom(this.map);
      this.activeBaseLayer = null;
    }
    if (!online) {
      return;
    }

    const layer = await this.getBaseLayer(baseMap);
    if (
      revision !== this.baseLayerRevision ||
      !this.map ||
      !this.online ||
      this.selectedBaseMap !== baseMap
    ) {
      return;
    }
    layer.addTo(this.map);
    this.activeBaseLayer = layer;
  }

  /**
   * Rebuilds map overlays from current aircraft and threat state.
   * @param aircraft - Current aircraft state, or `null` before a fix is available.
   * @param threats - Threats to draw with markers and effective-range circles.
   */
  update(aircraft: AircraftState | null, threats: Threat[]): void {
    if (!this.map || !this.overlays) {
      return;
    }

    this.overlays.clearLayers();
    const bounds = L.latLngBounds([]);

    for (const threat of threats) {
      const position = L.latLng(threat.latitude, threat.longitude);
      const range = L.circle(position, {
        radius: threat.rangeKm * 1000,
        // CSS variables keep existing Leaflet SVG overlays synchronized with theme changes.
        color: 'var(--color-danger-strong)',
        weight: 2,
        opacity: 0.85,
        fillColor: 'var(--color-danger-strong)',
        fillOpacity: 0.1
      }).addTo(this.overlays);
      range.bindTooltip(buildThreatDetails(threat), { sticky: true });
      bounds.extend(range.getBounds());

      L.marker(position, {
        icon: buildThreatIcon(threat.id),
        title: `Threat ${threat.id}`,
        zIndexOffset: 500
      })
        .bindTooltip(buildThreatDetails(threat), { direction: 'top', offset: [0, -10] })
        .addTo(this.overlays);
    }

    if (aircraft) {
      const position = L.latLng(aircraft.latitude, aircraft.longitude);
      L.marker(position, {
        icon: buildAircraftIcon(aircraft.trackDegrees),
        title: 'Aircraft position',
        zIndexOffset: 1000
      })
        .bindTooltip(buildAircraftDetails(aircraft), { direction: 'top', offset: [0, -13] })
        .addTo(this.overlays);
      bounds.extend(position);
    }

    // Refit only when source data changes so periodic redraws do not override user map navigation.
    const dataSignature = `${aircraft ? 'aircraft' : 'no-aircraft'}|${threats
      .map((threat) => `${threat.id}:${threat.latitude}:${threat.longitude}:${threat.rangeKm}`)
      .join('|')}`;
    if (dataSignature !== this.lastFittedDataSignature) {
      if (bounds.isValid()) {
        this.moveProgrammatically(() => {
          this.map?.fitBounds(bounds.pad(0.12), { maxZoom: 13, animate: false });
        });
      }
      this.lastFittedDataSignature = dataSignature;
    }

    if (this.centerOnAircraft && aircraft) {
      this.centerMapOnAircraft(aircraft);
    }
  }

  /** Invalidates Leaflet's cached container size without panning the map. */
  invalidateSize(): void {
    this.map?.invalidateSize({ pan: false });
  }

  private centerMapOnAircraft(aircraft: AircraftState): void {
    if (!this.map) {
      return;
    }
    const position = L.latLng(aircraft.latitude, aircraft.longitude);
    this.moveProgrammatically(() => {
      this.map?.setView(position, this.map.getZoom(), { animate: false });
    });
  }

  private moveProgrammatically(move: () => void): void {
    this.isProgrammaticMove = true;
    try {
      move();
    } finally {
      this.isProgrammaticMove = false;
    }
  }

  private async getBaseLayer(baseMap: BaseMapId): Promise<Layer> {
    const existing = this.baseLayers.get(baseMap);
    if (existing) {
      return existing;
    }

    let layer: Layer;
    if (baseMap === 'street') {
      layer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      });
    } else if (baseMap === 'topographic') {
      layer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17,
        attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
      });
    } else {
      await loadGoogleMaps(this.googleMapsApiKey);
      await loadGoogleMutant();
      layer = L.gridLayer.googleMutant({ type: 'satellite', maxZoom: 21 });
    }

    this.baseLayers.set(baseMap, layer);
    return layer;
  }
}

let googleMapsPromise: Promise<void> | null = null;
let googleMutantPromise: Promise<void> | null = null;

function loadGoogleMaps(apiKey: string): Promise<void> {
  const googleWindow = window as Window & { google?: { maps?: unknown } };
  if (googleWindow.google?.maps) {
    return Promise.resolve();
  }
  googleMapsPromise ??= loadScript(
    GOOGLE_MAPS_SCRIPT_ID,
    `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async`,
    () => Boolean(googleWindow.google?.maps),
    'Unable to load the Google Maps JavaScript API.'
  );
  return googleMapsPromise;
}

function loadGoogleMutant(): Promise<void> {
  if (typeof L.gridLayer.googleMutant === 'function') {
    return Promise.resolve();
  }
  (window as Window & { L?: typeof L }).L = L;
  googleMutantPromise ??= loadScript(
    GOOGLE_MUTANT_SCRIPT_ID,
    googleMutantScriptUrl,
    () => typeof L.gridLayer.googleMutant === 'function',
    'Unable to initialize the Google imagery layer.'
  );
  return googleMutantPromise;
}

function loadScript(
  id: string,
  src: string,
  isReady: () => boolean,
  errorMessage: string
): Promise<void> {
  if (isReady()) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existing = document.getElementById(id);
    const script = existing instanceof HTMLScriptElement ? existing : document.createElement('script');

    const loaded = (): void => {
      cleanup();
      if (isReady()) {
        resolve();
      } else {
        reject(new Error(errorMessage));
      }
    };
    const failed = (): void => {
      cleanup();
      reject(new Error(errorMessage));
    };
    const cleanup = (): void => {
      script.removeEventListener('load', loaded);
      script.removeEventListener('error', failed);
    };

    script.addEventListener('load', loaded);
    script.addEventListener('error', failed);
    if (!existing) {
      script.id = id;
      script.src = src;
      script.async = true;
      document.head.append(script);
    }
  });
}

function buildThreatIcon(id: string): L.DivIcon {
  const icon = document.createElement('div');
  icon.className = 'threat-map-marker';

  const dot = document.createElement('span');
  dot.className = 'threat-map-marker-dot';
  dot.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'threat-map-marker-label';
  label.textContent = id;

  icon.append(dot, label);
  return L.divIcon({
    className: 'threat-map-div-icon',
    html: icon,
    iconSize: [90, 30],
    iconAnchor: [15, 15]
  });
}

function buildAircraftIcon(trackDegrees: number | null): L.DivIcon {
  const icon = document.createElement('div');
  icon.className = 'aircraft-map-marker';
  icon.setAttribute('aria-hidden', 'true');
  icon.style.setProperty('--aircraft-track', `${trackDegrees ?? 0}deg`);

  const airplane = document.createElementNS(SVG_NAMESPACE, 'svg');
  airplane.setAttribute('class', 'aircraft-map-marker-symbol');
  airplane.setAttribute('viewBox', '0 0 32 32');
  airplane.setAttribute('focusable', 'false');

  const silhouette = document.createElementNS(SVG_NAMESPACE, 'path');
  // The silhouette faces up in its local coordinates, so zero degrees is true north on the map.
  silhouette.setAttribute(
    'd',
    'M16 2.5c-1.2 0-2 1-2 2.2v7.2L5 17v3l9-2.6v5.3l-3 2V27l5-1.5 5 1.5v-2.3l-3-2v-5.3l9 2.6v-3l-9-5.1V4.7c0-1.2-.8-2.2-2-2.2Z'
  );
  airplane.append(silhouette);
  icon.append(airplane);

  return L.divIcon({
    className: 'aircraft-map-div-icon',
    html: icon,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

function buildThreatDetails(threat: Threat): HTMLElement {
  const details = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = threat.name ? `${threat.id} - ${threat.name}` : threat.id;
  const range = document.createElement('div');
  range.textContent = `Effective range: ${threat.rangeKm.toFixed(2)} km`;
  details.append(title, range);
  return details;
}

function buildAircraftDetails(aircraft: AircraftState): HTMLElement {
  const details = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = 'Aircraft';
  const position = document.createElement('div');
  position.textContent = `${aircraft.latitude.toFixed(6)}, ${aircraft.longitude.toFixed(6)}`;
  details.append(title, position);
  return details;
}
