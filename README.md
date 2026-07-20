# Threat Emulator

Threat Emulator is an offline-capable browser application for evaluating terrain-based threat warnings. It loads local threat scenery from CSV, loads local terrain elevation from GeoTIFF, watches the aircraft position through browser geolocation, and displays a large text warning when the aircraft is inside a threat's range with clear line of sight. A collapsible Leaflet map shows the aircraft, threats, and their effective-range circles.

The app is built with TypeScript, Vite, Vitest, Leaflet, `geotiff`, `papaparse`, and `vite-plugin-pwa`.

## Features

- Runs entirely in the browser as a static single-page app.
- Supports offline launch as a PWA after installation.
- Loads user-selected local threat CSV files and supports adding, editing, or deleting threats in the Threats panel.
- Exports the current non-empty threat list as a semicolon-delimited CSV file.
- Places manual threats by WGS84 decimal-degree coordinates, MGRS, or true bearing and distance from the latest aircraft position.
- Optionally loads a user-selected local WGS84 elevation GeoTIFF for terrain-aware line-of-sight checks.
- Can remember a local GeoTIFF through a persistent file handle on compatible browsers.
- Converts browser WGS84 ellipsoid altitude to EGM96 orthometric MSL altitude, then calculates height above ground from local terrain elevation.
- Evaluates threats every 3 seconds while the emulator is active.
- Prioritizes the closest active threat.
- Shows aircraft position, GPS altitude, height above ground, precision, track, validation status, and evaluation results.
- Shows aircraft and threat positions with effective-range circles in a collapsible Leaflet map.
- Lets the user choose OpenStreetMap, OpenTopoMap, or optionally Google satellite imagery while online, and keeps the map overlays available over a neutral grid when offline.

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
2. Select a semicolon-delimited threat CSV file, or expand Threats and choose `Add threat`.
3. Optionally select a local elevation GeoTIFF file, or use `Remember GeoTIFF` on compatible browsers to restore it on future launches.
4. Grant browser geolocation permission when prompted.
5. Wait for an aircraft position with GPS altitude.
6. Start the emulator.
7. Expand the collapsed Aircraft Status, Threats, and Map panels as needed. The threat table is available before the emulator starts and shows each threat's ID/description, distance/range, LOS/state, and edit/delete actions.
8. In the Map panel, choose OpenStreetMap, OpenTopoMap, or Google satellite as the base map. Red markers identify threats, red circles show their effective ranges, and the blue directional marker identifies the latest aircraft position. Online tiles disappear while offline, but the same overlays remain usable over a neutral grid.

### Google satellite configuration

Google satellite imagery is optional and uses the official Google Maps JavaScript API. Copy `.env.example` to `.env.local`, set `VITE_GOOGLE_MAPS_API_KEY`, and restart the development server or rebuild the app. The Google Cloud project must have billing and the Maps JavaScript API enabled. Restrict the browser key to the app's HTTP referrers before deployment.

For GitHub Pages, create a repository Actions secret named `GOOGLE_MAPS_API_KEY`. The deployment workflow exposes it to Vite only during the static build. Like all browser map keys, the built value is visible to clients, so HTTP-referrer and API restrictions are required. If no key is configured, the Google satellite option remains visible but disabled; OpenStreetMap and OpenTopoMap continue to work.

The threat editor works without a CSV. Coordinate placement accepts decimal WGS84 latitude and longitude or an MGRS grid reference. MGRS input is converted to the center of its grid square in fixed WGS84 coordinates when saved. Relative placement similarly converts a true bearing and distance from the latest GNSS aircraft position into fixed WGS84 coordinates. The CSV schema remains decimal degrees only. Importing a CSV replaces the current threat list; the app asks for confirmation first when that list has local edits. When at least one threat exists, `Export CSV` downloads the current list, including all imported and manual edits, in the same decimal-degree schema.

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
5. Builds the primary warning from the closest active threat.

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
  domain/       Core CSV parsing, geospatial math, warning, LOS, and evaluation logic
  services/     Browser-facing geolocation, Leaflet map, and terrain service wrappers
  ui/           Declarative HTML shell, native DOM templates, rendering, and UI controllers
  workers/      GeoTIFF terrain loading, sampling, and LOS worker code
  main.ts       Application bootstrap and top-level state orchestration
fixtures/       Sample threat CSV data
public/         PWA icon and static assets
```

The UI shell is authored as normal HTML in `src/ui/app.html` and imported by Vite. Repeated
summary and threat-table rows use native `<template>` elements, while TypeScript controllers
clone those templates and assign dynamic values with `textContent`. This keeps HTML out of
long TypeScript strings without adding a client framework or runtime templating dependency.

## Deployment

GitHub Pages deployment is configured in `.github/workflows/deploy.yml`.

On pushes to `main` or manual workflow dispatch, the workflow:

1. Installs dependencies with `npm ci`.
2. Runs `npm run typecheck`.
3. Runs `npm test`.
4. Runs `npm run build`.
5. Publishes `dist/` to GitHub Pages.

The Vite base path is derived from `GITHUB_REPOSITORY` during the GitHub Actions build.
