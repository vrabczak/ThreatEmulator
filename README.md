# Threat Emulator

Threat Emulator is an offline-capable browser application for evaluating terrain-based threat warnings. It loads local threat scenery from CSV, loads local terrain elevation from GeoTIFF, watches the aircraft position through browser geolocation, and displays a large text warning when the aircraft is inside a threat's range with clear line of sight. A collapsible Leaflet map shows the aircraft, threats, and their effective-range circles.

The app is built with TypeScript, Vite, Vitest, Leaflet, `geotiff`, `papaparse`, and `vite-plugin-pwa`.

## Features

- Runs entirely in the browser as a static single-page app.
- Supports offline launch as a PWA after installation.
- Switches between a light white/black/grey/blue/red theme and a dark black/grey/white/green/red theme, remembering the selection on the device.
- Keeps header actions in the same row as the brand and aligned to the right edge on narrow screens.
- Loads user-selected local threat CSV files and supports adding, editing, or deleting threats in the Threats panel.
- Exports the current non-empty threat list as a semicolon-delimited CSV file.
- Places manual threats by WGS84 decimal-degree coordinates, MGRS, or true bearing and distance from the latest aircraft position.
- Optionally loads a user-selected local WGS84 elevation GeoTIFF for terrain-aware line-of-sight checks.
- Can remember a local GeoTIFF through a persistent file handle on compatible browsers.
- Offers a download link for the elevation GeoTIFF when no terrain file is loaded or remembered.
- Converts browser WGS84 ellipsoid altitude to EGM96 orthometric MSL altitude, then calculates height above ground from local terrain elevation.
- Evaluates threats every 3 seconds while the emulator is active.
- Shows whether evaluation is running through the Start/Stop button, warning area, and evaluation countdown without a redundant header status badge.
- Shows one equally prominent `DESCRIPTION CLOCK CODE DISTANCE` warning call for every active threat in first-appearance order.
- Shows aircraft position, GPS altitude, height above ground, precision, track, validation status, and evaluation results.
- Shows aircraft and threat positions with effective-range circles in a collapsible Leaflet map, with an in-map Leaflet button for center-on-aircraft mode that disengages when the map is moved manually.
- Opens and scrolls to a coordinate-populated threat form by long pressing a map location, or right-clicking it with a mouse; repeating the gesture while a form is open updates only its position and scrolls back to it.
- Uses Leaflet's collapsed in-map layer button to choose OpenStreetMap, OpenTopoMap, optionally configured Mapy.com outdoor/aerial tiles, or optionally configured Google satellite imagery while online, and keeps the map overlays available over a neutral grid when offline.
- Uses Mapy.com outdoor as the initial base layer when its API key is configured, with OpenStreetMap as the no-key fallback.

## Requirements

- Node.js LTS.
- npm.
- A browser that supports geolocation, web workers, file input, and service workers.
- HTTPS or `localhost` when using geolocation in the browser.
- After the PWA assets have been cached, a network connection is optional for app operation. The Map panel uses it for the selected background tiles; the map controls and aircraft/threat overlays remain available offline.
- Optionally, a WGS84 elevation GeoTIFF in meters MSL for terrain-aware line-of-sight checks.

Large GeoTIFF files are expected to be local user files and are not included in this repository.
Remembering a GeoTIFF requires browser support for persistent local file handles. The app stores the file handle, not a copy of the multi-GB GeoTIFF; browsers without that API require selecting the file again after reload.

## Getting Started

Install dependencies:

```sh
npm ci
```

Run the development server:

```sh
npm run dev
```

Build production assets:

```sh
npm run build
```

Preview the production build:

```sh
npm run preview
```

## Usage

1. Open the app in a browser.
2. Select the sun–moon toggle in the header to change appearance. Its high-contrast thumb moves toward the active theme. Light is the first-visit default, and the browser remembers an explicit selection for future launches.
3. Select a semicolon-delimited threat CSV file, or expand Threats and choose `Add threat`.
4. Optionally select a local elevation GeoTIFF file, use the offered download link when no file is available locally, or restore a remembered file on compatible browsers.
5. Grant browser geolocation permission when prompted.
6. Wait for an aircraft position with GPS altitude.
7. Start the emulator. Its running state is visible from the Stop button, warning area, and evaluation countdown; the header has no separate state badge.
8. Read each active `DESCRIPTION CLOCK CODE DISTANCE` threat call in the warning area. Calls retain activation order while active; a threat that becomes inactive and later reactivates returns at the bottom. Threats first detected together use threat-list order.
9. Expand the collapsed Aircraft Status, Threats, and Map panels as needed. On widescreen displays, Controls, Aircraft Status, and Threats form a separately scrollable left column while the Map panel fills the available screen height in the right column. Narrower displays use a single-column layout. The threat table is available before the emulator starts and shows each threat's ID/description, distance/range, LOS/state, and edit/delete actions.
10. In the Map panel, use Leaflet's layers icon in the upper-right corner to choose OpenStreetMap, OpenTopoMap, configured Mapy.com outdoor/aerial tiles, or configured Google satellite imagery. Red markers identify threats and their effective ranges. The top-down aircraft marker uses blue in the light theme and green in the dark theme. Its nose follows the available GPS track and points north when track is unavailable. Press the target icon below the zoom buttons to keep the map centered as the aircraft position changes; its accent background indicates that following is active. Manually panning or zooming releases following. The panel header reports online/offline connectivity. Online tiles disappear while offline, but the same overlays and controls remain usable over a neutral grid.
11. Use the placement hint displayed beside the map legend: long press a desired map location on a touch device, or right-click it with a mouse, to open the Threats panel with a new-threat form in coordinate mode and scroll to it. When an add or edit form is already open, the gesture replaces its latitude and longitude without clearing any other values, then scrolls back to the form.

### Google satellite configuration

Google satellite imagery is optional and uses the official Google Maps JavaScript API. Copy `.env.example` to `.env.local`, set `VITE_GOOGLE_MAPS_API_KEY`, and restart the development server or rebuild the app. The Google Cloud project must have billing and the Maps JavaScript API enabled. Restrict the browser key to the app's HTTP referrers before deployment.

For GitHub Pages, create a repository Actions secret named `GOOGLE_MAPS_API_KEY`. The deployment workflow exposes it to Vite only during the static build. Like all browser map keys, the built value is visible to clients, so HTTP-referrer and API restrictions are required. If no key is configured, Google satellite remains visible but disabled in Leaflet's layer list with an API-key-required label; OpenStreetMap and OpenTopoMap continue to work.

### Mapy.com layer configuration

The Mapy.com outdoor and aerial layers use the Mapy.com REST Map Tiles API. Create an API project and browser key in the Mapy.com account portal, copy `.env.example` to `.env.local`, set `VITE_MAPY_API_KEY`, and restart the development server or rebuild the app. Restrict the key to the application's HTTP referrers and the Map Tiles service. The aerial set has regional zoom limits defined by Mapy.com; outside its detailed-coverage regions it is available only through zoom 13.

For GitHub Pages, create a repository or `github-pages` environment Actions secret named `MAPY_API_KEY`. The deployment workflow passes it to Vite as `VITE_MAPY_API_KEY` during the static build. Because Vite embeds the key into browser assets, the deployed value is visible to clients despite being stored as a GitHub secret; provider-side referrer and service restrictions remain required. Without the key, both Mapy.com choices remain visible but disabled with an API-key-required label.

The threat editor works without a CSV. Coordinate placement accepts decimal WGS84 latitude and longitude or an MGRS grid reference. MGRS input is converted to the center of its grid square in fixed WGS84 coordinates when saved. When an existing threat is edited, the form derives and fills its one-meter MGRS reference from the stored position while retaining the decimal-degree values. Relative placement similarly converts a true bearing and distance from the latest GNSS aircraft position into fixed WGS84 coordinates. The CSV schema remains decimal degrees only. Importing a CSV replaces the current threat list; the app asks for confirmation first when that list has local edits. When at least one threat exists, `Export CSV` downloads the current list, including all imported and manual edits, in the same decimal-degree schema.

The repository includes `fixtures/sample-threats.csv` as a small CSV example.

## Threat CSV Format

Threat files must use semicolon delimiters. `name` and `height_agl_m` are optional; the other shown columns are required:

```csv
id;name;latitude;longitude;height_agl_m;range_km
T001;Example Threat;50.0755;14.4378;12;25
```

Columns:

- `id`: Stable threat identifier.
- `name`: Optional human-readable threat description. A blank value or missing column is accepted.
- `latitude`: Threat latitude in decimal degrees, WGS84.
- `longitude`: Threat longitude in decimal degrees, WGS84.
- `height_agl_m`: Optional threat sensor height above local terrain, in meters. A blank value or missing column creates a magic threat whose line of sight is always clear.
- `range_km`: Threat effective horizontal ground range, in kilometers.

Validation rules:

- Required columns `id`, `latitude`, `longitude`, and `range_km` must be present.
- Latitude must be between `-90` and `90`.
- Longitude must be between `-180` and `180`.
- When supplied, height must be greater than or equal to `0`.
- Range must be greater than or equal to `0`; zero-range threats display as `100 m`.
- CSV files are expected to be no larger than 1 MB.

## Terrain GeoTIFF

The GeoTIFF provides terrain elevation for aircraft AGL and line-of-sight checks.

The emulator can run without a GeoTIFF. In that mode, every threat is assumed to have clear line of sight, so horizontal range is the only activation factor. Aircraft height above ground remains unavailable.

Browser altitude is converted from WGS84 ellipsoid height to orthometric MSL height with the bundled offline EGM96 15-minute geoid grid. Aircraft AGL is then calculated from the converted altitude and the current terrain sample. Calculated AGL below 15 m is reported as 50 ft. If a new aircraft terrain lookup fails after at least one successful lookup, the AGL display uses the last retrieved aircraft terrain elevation and marks the value as `(last terrain)`.

Expected properties:

- WGS84 coordinates.
- Elevation values in meters MSL.
- Coverage for the aircraft and all threats being evaluated.
- NoData values that can be detected and handled.

Missing terrain along a threat line-of-sight still produces a terrain-unavailable result instead of a false active warning; the last-aircraft-terrain fallback applies only to the aircraft AGL display.

## Evaluation Model

For each valid threat, the emulator:

1. Calculates horizontal ground distance from the aircraft to the threat.
2. Marks the threat inactive when the aircraft is outside `range_km`.
3. Treats magic threats as always having clear line of sight. For other in-range threats, runs a flat-earth terrain line-of-sight check when an elevation model is loaded; otherwise assumes line of sight is clear.
4. Marks the threat active when line of sight is clear.
5. Builds one `DESCRIPTION CLOCK CODE DISTANCE` warning call for every active threat, using its ID when the description is blank and omitting the clock code when aircraft track is unavailable. Continuously active calls retain first-appearance order, while a reactivated threat is appended after them.

GNSS fixes are published to threat evaluation atomically after their EGM96 conversion finishes. While a newer fix is being converted, the previous fully converted aircraft state remains available, so the 3-second evaluation does not skip LOS merely because conversion is in progress.

V1 does not model earth curvature, atmospheric refraction, or buildings. The map is a situational display and does not alter threat evaluation.

## Scripts

- `npm run dev`: Start the Vite development server.
- `npm run build`: Build production assets into `dist/`.
- `npm run preview`: Preview the production build locally.
- `npm test`: Run the Vitest test suite once.
- `npm run test:watch`: Run Vitest in watch mode.
- `npm run typecheck`: Run TypeScript type checking without emitting files.

## Project Structure

```text
src/
  domain/       Core altitude, CSV, geospatial, warning, LOS, and evaluation functions
  services/     Browser-facing geolocation, aircraft-altitude, map, and terrain services
  ui/           Declarative HTML shell, rendering, and feature UI controllers
  workers/      GeoTIFF terrain loading, sampling, and LOS worker code
  main.ts       Minimal application bootstrap
  threat-emulator-app.ts  Page-lifetime state and top-level workflow orchestration
fixtures/       Sample threat CSV data
public/         PWA icon and static assets
```

`ThreatEmulatorApp` owns the remaining mutable application state and coordinates the feature
controllers and browser services. `TerrainController` owns terrain selection, remembered-file
restore, and GeoTIFF loading. `AircraftAltitudeController` owns EGM96 conversion, terrain
sampling, AGL state, and stale asynchronous-result protection. Domain altitude, parsing,
geospatial, line-of-sight, evaluation, and warning rules remain stateless TypeScript functions.

The UI shell is authored as normal HTML in `src/ui/app.html` and imported by Vite. Repeated
summary and threat-table rows use native `<template>` elements, while TypeScript controllers
clone those templates and assign dynamic values with `textContent`. This keeps HTML out of
long TypeScript strings without adding a client framework or runtime templating dependency.
The theme initializer applies semantic CSS color tokens to native controls, status displays,
map overlays, and Leaflet controls, and stores only the selected theme name in local storage.

## Deployment

GitHub Pages deployment is configured in `.github/workflows/deploy.yml`.

On pushes to `main` or manual workflow dispatch, the workflow:

1. Installs dependencies with `npm ci`.
2. Runs `npm run typecheck`.
3. Runs `npm test`.
4. Runs `npm run build`.
5. Publishes `dist/` to GitHub Pages.

The Vite base path is derived from `GITHUB_REPOSITORY` during the GitHub Actions build.
