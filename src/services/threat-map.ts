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

type BaseMapId = 'street' | 'topographic' | 'google-satellite';

const BASE_MAP_LABELS: Record<BaseMapId, string> = {
  street: 'OpenStreetMap',
  topographic: 'OpenTopoMap',
  'google-satellite': 'Google satellite'
};

/** Callbacks used to pass map interactions back to the UI layer. */
export interface ThreatMapOptions {
  onCoordinateSelected: (latitude: number, longitude: number) => void;
}

/**
 * Owns the Leaflet map, overlays, base-layer cache, aircraft-following state, and data fitting.
 * Initialization is idempotent; layer revisions prevent stale asynchronous loads from becoming active.
 */
export class ThreatMap {
  private map: LeafletMap | null = null;
  private overlays: LayerGroup | null = null;
  private layerControl: L.Control.Layers | null = null;
  private centerControl: CenterOnAircraftControl | null = null;
  private readonly baseLayers = new Map<BaseMapId, Layer>();
  private readonly baseLayerIds = new Map<Layer, BaseMapId>();
  private googlePlaceholderLayer: Layer | null = null;
  private googleLayerPromise: Promise<Layer> | null = null;
  private selectedBaseMap: BaseMapId = 'street';
  private online = false;
  private baseLayerRevision = 0;
  private lastFittedDataSignature = '';
  private centerOnAircraft = false;
  private isProgrammaticMove = false;
  private latestAircraft: AircraftState | null = null;
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
   * @returns Nothing.
   */
  public initialize(container: HTMLElement, online: boolean): void {
    if (this.map) {
      this.setConnectivity(online);
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
        this.centerControl?.setActive(false);
      }
    });
    this.overlays = L.layerGroup().addTo(this.map);
    this.initializeControls();
    this.setConnectivity(online);
  }

  /**
   * Applies browser connectivity to the selected Leaflet base layer.
   * @param online - Whether online base-layer requests are currently allowed.
   * @returns Nothing.
   */
  public setConnectivity(online: boolean): void {
    this.online = online;
    // A connectivity change invalidates an in-flight lazy provider load before layers are restored.
    const revision = ++this.baseLayerRevision;

    if (!this.map) {
      return;
    }

    this.removeBaseLayers();
    if (!online) {
      return;
    }

    void this.activateSelectedBaseLayer(revision);
  }

  /**
   * Rebuilds map overlays from current aircraft and threat state.
   * @param aircraft - Current aircraft state, or `null` before a fix is available.
   * @param threats - Threats to draw with markers and effective-range circles.
   * @returns Nothing.
   */
  public update(aircraft: AircraftState | null, threats: Threat[]): void {
    this.latestAircraft = aircraft;
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

  /**
   * Invalidates Leaflet's cached container size without panning the map.
   * @returns Nothing.
   */
  public invalidateSize(): void {
    this.map?.invalidateSize({ pan: false });
  }

  private initializeControls(): void {
    if (!this.map) {
      return;
    }

    this.registerBaseLayer(
      'street',
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      })
    );
    this.registerBaseLayer(
      'topographic',
      L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17,
        attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
      })
    );

    // The empty layer gives Leaflet a native entry while Google stays lazily loaded until selected.
    this.googlePlaceholderLayer = L.layerGroup();
    if (!this.googleMapsApiKey) {
      // Leaflet natively disables a layer outside its zoom range, so Infinity keeps the
      // unconfigured provider visible but unavailable without custom selector markup.
      const options = this.googlePlaceholderLayer.options as L.LayerOptions & { minZoom?: number };
      options.minZoom = Number.POSITIVE_INFINITY;
    }
    this.registerBaseLayer('google-satellite', this.googlePlaceholderLayer);

    const controlLayers: L.Control.LayersObject = {};
    for (const [id, layer] of this.baseLayers) {
      const label = id === 'google-satellite' && !this.googleMapsApiKey
        ? `${BASE_MAP_LABELS[id]} (API key required)`
        : BASE_MAP_LABELS[id];
      controlLayers[label] = layer;
    }
    this.layerControl = L.control.layers(controlLayers, undefined, {
      collapsed: true,
      position: 'topright'
    }).addTo(this.map);
    this.map.on('baselayerchange', (event) => this.handleBaseLayerChange(event));

    this.centerControl = new CenterOnAircraftControl((enabled) => {
      this.centerOnAircraft = enabled;
      if (enabled && this.latestAircraft) {
        this.centerMapOnAircraft(this.latestAircraft);
      }
    }).addTo(this.map);
  }

  private registerBaseLayer(id: BaseMapId, layer: Layer): void {
    this.baseLayers.set(id, layer);
    this.baseLayerIds.set(layer, id);
  }

  private handleBaseLayerChange(event: L.LayersControlEvent): void {
    const selectedId = this.baseLayerIds.get(event.layer);
    if (!selectedId || !this.map) {
      return;
    }

    this.selectedBaseMap = selectedId;
    // A newer native layer selection must win if Google is still loading asynchronously.
    const revision = ++this.baseLayerRevision;
    if (!this.online) {
      this.map.removeLayer(event.layer);
      return;
    }

    if (selectedId === 'google-satellite' && event.layer === this.googlePlaceholderLayer) {
      this.map.removeLayer(event.layer);
      void this.activateSelectedBaseLayer(revision);
      return;
    }
  }

  private async activateSelectedBaseLayer(revision: number): Promise<void> {
    const selectedId = this.selectedBaseMap;
    try {
      const layer = selectedId === 'google-satellite'
        ? await this.getGoogleBaseLayer()
        : this.baseLayers.get(selectedId);
      if (
        !layer ||
        revision !== this.baseLayerRevision ||
        !this.map ||
        !this.online ||
        this.selectedBaseMap !== selectedId
      ) {
        return;
      }

      this.removeBaseLayers();
      layer.addTo(this.map);
    } catch (error) {
      console.error('Unable to load the selected base map.', error);
      if (
        revision === this.baseLayerRevision &&
        this.map &&
        this.online &&
        this.selectedBaseMap === selectedId
      ) {
        this.selectedBaseMap = 'street';
        const fallback = this.baseLayers.get('street');
        fallback?.addTo(this.map);
      }
    }
  }

  private removeBaseLayers(): void {
    if (!this.map) {
      return;
    }
    for (const layer of this.baseLayers.values()) {
      if (this.map.hasLayer(layer)) {
        this.map.removeLayer(layer);
      }
    }
  }

  private getGoogleBaseLayer(): Promise<Layer> {
    const registeredLayer = this.baseLayers.get('google-satellite');
    if (registeredLayer && registeredLayer !== this.googlePlaceholderLayer) {
      return Promise.resolve(registeredLayer);
    }
    if (!this.googleMapsApiKey) {
      return Promise.reject(new Error('Google satellite requires VITE_GOOGLE_MAPS_API_KEY.'));
    }

    this.googleLayerPromise ??= this.createGoogleBaseLayer()
      .then((layer) => {
        if (this.googlePlaceholderLayer) {
          this.layerControl?.removeLayer(this.googlePlaceholderLayer);
          this.baseLayerIds.delete(this.googlePlaceholderLayer);
        }
        this.googlePlaceholderLayer = null;
        this.registerBaseLayer('google-satellite', layer);
        this.layerControl?.addBaseLayer(layer, BASE_MAP_LABELS['google-satellite']);
        return layer;
      })
      .catch((error: unknown) => {
        this.googleLayerPromise = null;
        throw error;
      });
    return this.googleLayerPromise;
  }

  private async createGoogleBaseLayer(): Promise<Layer> {
    await loadGoogleMaps(this.googleMapsApiKey);
    await loadGoogleMutant();
    return L.gridLayer.googleMutant({ type: 'satellite', maxZoom: 21 });
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
}

/**
 * Adds a Leaflet bar button that toggles continuous aircraft-following state.
 * The control owns only its pressed presentation; ThreatMap applies centering and clears it on manual moves.
 */
class CenterOnAircraftControl extends L.Control {
  private button: HTMLButtonElement | null = null;
  private active = false;

  /**
   * Creates the control with an application callback for pressed-state changes.
   * @param onToggle - Called with the next following state after the user activates the button.
   */
  public constructor(private readonly onToggle: (enabled: boolean) => void) {
    super({ position: 'topleft' });
  }

  /**
   * Builds the control button when Leaflet attaches it to a map.
   * @param _map - Leaflet map receiving the control.
   * @returns The control container managed by Leaflet.
   */
  public onAdd(_map: LeafletMap): HTMLElement {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control-center-aircraft');
    const button = document.createElement('button');
    button.className = 'leaflet-control-center-aircraft-button';
    button.type = 'button';
    button.append(buildCenterAircraftIcon());
    button.addEventListener('click', this.handleClick);
    container.append(button);
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    this.button = button;
    this.render();
    return container;
  }

  /**
   * Releases the DOM listener when Leaflet detaches the control.
   * @param _map - Leaflet map that owned the control.
   * @returns Nothing.
   */
  public onRemove(_map: LeafletMap): void {
    this.button?.removeEventListener('click', this.handleClick);
    this.button = null;
  }

  /**
   * Synchronizes the visible pressed state without invoking the toggle callback.
   * @param active - Whether continuous aircraft following is active.
   * @returns Nothing.
   */
  public setActive(active: boolean): void {
    this.active = active;
    this.render();
  }

  private readonly handleClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.setActive(!this.active);
    this.onToggle(this.active);
  };

  private render(): void {
    if (!this.button) {
      return;
    }
    const description = this.active ? 'Stop centering on aircraft' : 'Center on aircraft';
    this.button.setAttribute('aria-label', description);
    this.button.setAttribute('aria-pressed', String(this.active));
    this.button.title = description;
  }
}

function buildCenterAircraftIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');

  const outerCircle = document.createElementNS(SVG_NAMESPACE, 'circle');
  outerCircle.setAttribute('cx', '12');
  outerCircle.setAttribute('cy', '12');
  outerCircle.setAttribute('r', '5');

  const crosshair = document.createElementNS(SVG_NAMESPACE, 'path');
  crosshair.setAttribute('d', 'M12 2v5M12 17v5M2 12h5M17 12h5');

  const center = document.createElementNS(SVG_NAMESPACE, 'circle');
  center.setAttribute('cx', '12');
  center.setAttribute('cy', '12');
  center.setAttribute('r', '1.5');
  center.setAttribute('class', 'leaflet-control-center-aircraft-icon-center');

  icon.append(outerCircle, crosshair, center);
  return icon;
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
