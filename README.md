# Threat Emulator

Threat Emulator is an offline-capable browser application for evaluating terrain-based threat warnings. It loads local threat scenery from CSV, loads local terrain elevation from GeoTIFF, watches the aircraft position through browser geolocation, and displays a large text warning when the aircraft is inside a threat's range with clear line of sight.

The app is built with TypeScript, Vite, Vitest, `geotiff`, `papaparse`, and `vite-plugin-pwa`.

## Features

- Runs entirely in the browser as a static single-page app.
- Supports offline launch as a PWA after installation.
- Loads user-selected local threat CSV files.
- Loads user-selected local WGS84 elevation GeoTIFF files.
- Can remember a local GeoTIFF through a persistent file handle on compatible browsers.
- Calculates aircraft height above ground from GPS altitude and terrain elevation.
- Evaluates threats every 3 seconds while the emulator is active.
- Prioritizes the closest active threat.
- Shows aircraft position, GPS altitude, height above ground, precision, track, validation status, and evaluation results.

## Requirements

- Node.js LTS.
- npm.
- A browser that supports geolocation, web workers, file input, and service workers.
- HTTPS or `localhost` when using geolocation in the browser.
- A WGS84 elevation GeoTIFF in meters MSL for the operating area.

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
2. Select a semicolon-delimited threat CSV file.
3. Select a local elevation GeoTIFF file, or use `Remember GeoTIFF` on compatible browsers to restore it on future launches.
4. Enable GNSS and grant browser geolocation permission.
5. Wait for an aircraft position with GPS altitude.
6. Start the emulator.
7. Review the primary warning, aircraft status, threat preview, validation output, and evaluation table.

The repository includes `fixtures/sample-threats.csv` as a small CSV example.

## Threat CSV Format

Threat files must use semicolon delimiters and include these columns:

```csv
id;name;latitude;longitude;height_agl_m;range_km
T001;Example Threat;50.0755;14.4378;12;25
```

Columns:

- `id`: Stable threat identifier.
- `name`: Human-readable threat name.
- `latitude`: Threat latitude in decimal degrees, WGS84.
- `longitude`: Threat longitude in decimal degrees, WGS84.
- `height_agl_m`: Threat sensor height above local terrain, in meters.
- `range_km`: Threat effective horizontal ground range, in kilometers.

Validation rules:

- Required columns must be present.
- Latitude must be between `-90` and `90`.
- Longitude must be between `-180` and `180`.
- Height must be greater than or equal to `0`.
- Range must be greater than or equal to `0`; zero-range threats display as `100 m`.
- CSV files are expected to be no larger than 1 MB.

## Terrain GeoTIFF

The GeoTIFF provides terrain elevation for aircraft AGL and line-of-sight checks.

Expected properties:

- WGS84 coordinates.
- Elevation values in meters MSL.
- Coverage for the aircraft and all threats being evaluated.
- NoData values that can be detected and handled.

If terrain is unavailable or outside coverage, the app reports that state instead of producing a false active warning.

## Evaluation Model

For each valid threat, the emulator:

1. Calculates horizontal ground distance from the aircraft to the threat.
2. Marks the threat inactive when the aircraft is outside `range_km`.
3. Runs a flat-earth terrain line-of-sight check when the aircraft is inside range.
4. Marks the threat active when line of sight is clear.
5. Builds the primary warning from the closest active threat.

V1 does not model earth curvature, atmospheric refraction, buildings, or a map display.

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
  services/     Browser-facing geolocation and terrain service wrappers
  workers/      GeoTIFF terrain loading, sampling, and LOS worker code
  main.ts       UI wiring and app state
fixtures/       Sample threat CSV data
public/         PWA icon and static assets
```

## Deployment

GitHub Pages deployment is configured in `.github/workflows/deploy.yml`.

On pushes to `main` or manual workflow dispatch, the workflow:

1. Installs dependencies with `npm ci`.
2. Runs `npm run typecheck`.
3. Runs `npm test`.
4. Runs `npm run build`.
5. Publishes `dist/` to GitHub Pages.

The Vite base path is derived from `GITHUB_REPOSITORY` during the GitHub Actions build.
