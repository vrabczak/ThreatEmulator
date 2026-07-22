/**
 * Adds Vite, PWA, Leaflet plugin, and application environment types to the client build.
 * Optional Google Maps and Mapy.com API keys are injected by Vite at build time.
 */

/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="leaflet.gridlayer.googlemutant" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  readonly VITE_MAPY_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
