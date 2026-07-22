# Threat Emulator Specification

## Purpose

Threat Emulator is a single-page offline web application written in TypeScript using Vite. It evaluates whether an aircraft is inside the effective envelope of terrain-based threats and displays a text message threat warning when the aircraft is within both threat range and line of sight.

The application runs entirely in the browser, uses user-selected local files and manually entered threat data, and is deployed as static production assets to GitHub Pages through GitHub Actions.

## Confirmed V1 Requirements

- Target device is iPad mini.
- Aircraft position comes from the iPad's built-in GNSS sensor through browser geolocation.
- Browser GPS ellipsoid altitude is converted to EGM96 orthometric MSL altitude. Aircraft AGL is calculated when an elevation model is loaded and is unavailable otherwise.
- Aircraft track is used for clock-code calculation. Heading is not used.
- Threats may be imported from a local semicolon-delimited CSV file or created manually without a CSV.
- The user can add, edit, and delete threats in the Threats panel.
- A non-empty working threat list can be exported as a local semicolon-delimited CSV file.
- Manual threats may be positioned by WGS84 decimal-degree coordinates, MGRS, or true bearing and distance from the latest aircraft position.
- Elevation data may optionally be loaded from a local GeoTIFF file.
- When loaded, GeoTIFF coordinates are WGS84 and elevation values are meters MSL.
- Threat height is sensor height above local terrain.
- Threat range uses horizontal ground distance.
- With a loaded elevation model, line of sight uses a flat-earth terrain obstruction check. Without one, all threats are assumed to have clear line of sight and horizontal range is the only activation factor. Earth curvature and atmospheric refraction are out of scope for V1.
- The emulator evaluates threats every 3 seconds while active.
- Warnings are visual only.
- Every active threat has its own large text warning row.
- Warning rows retain first-appearance order while active; a reactivated threat is appended as a new row.
- Distance is displayed using standard threat range buckets: 100m through 900m in
  100m steps, then 1km, 1.5km, 2km, and whole-kilometer buckets from 3km upward.
- V1 includes a collapsible Leaflet map showing the latest aircraft position, all threat positions, and each threat's effective-range circle.
- The map uses Leaflet's collapsed in-map layer control to choose OpenStreetMap, OpenTopoMap, configured Mapy.com outdoor/aerial tiles, or configured Google satellite imagery when online. Leaflet controls and all aircraft/threat overlays remain available without tiles when offline.
- Mapy.com outdoor is the initial base layer when `VITE_MAPY_API_KEY` is configured; otherwise OpenStreetMap is the initial base layer.
- The user can switch between a light white/black/grey/blue/red theme and a dark black/grey/white/green/red theme. Light is the first-visit default, and an explicit selection persists locally across launches.
- Header actions remain in the same row as the brand and aligned to the right edge on narrow displays.
- The app should be installable as a PWA for offline launch.
- CSV files are expected to be no larger than 1 MB.
- GeoTIFF files are expected to be large, approximately 1-3 GB.
- The repository should include a sample CSV fixture, but not a sample GeoTIFF fixture.

## Technology Stack

- TypeScript.
- Vite.
- Browser-only single-page application.
- Native HTML `<template>` elements for declarative UI markup and repeated dynamic rows. Vite imports the application shell from a dedicated HTML source file; TypeScript must not contain large HTML string literals.
- Leaflet for the interactive situational map.
- OpenStreetMap and OpenTopoMap raster tiles as keyless online background layers.
- Mapy.com outdoor and aerial raster tiles through the REST Map Tiles API when a Mapy.com API key is configured.
- Google satellite imagery through the official Google Maps JavaScript API and Leaflet GoogleMutant adapter when a Google browser API key is configured.
- PWA support for offline launch.
- Static production build deployed to GitHub Pages.
- GitHub Actions workflow for build and deploy.

Candidate browser libraries may be used for:

- CSV parsing.
- GeoTIFF parsing with local `File` / `Blob` input.
- Geospatial distance, bearing, and interpolation calculations.
- Web worker processing if required for large GeoTIFF performance.

Final library selection should be confirmed during implementation, especially for 1-3 GB GeoTIFF handling on iPad mini.

## User Flow

1. User opens the installed PWA or GitHub Pages URL.
2. User imports a local threat scenery CSV, creates one or more threats manually, or does both sequentially.
3. App validates imported or manually entered threats and displays the editable working threat list.
4. For manual placement, the user enters WGS84 decimal-degree coordinates, MGRS, or a true bearing and distance from the aircraft.
5. User may optionally select a local elevation GeoTIFF file. When no elevation file is loaded or remembered, the app offers a link to download one.
6. If selected, the app validates GeoTIFF metadata, coordinate system, elevation units, and coverage.
7. User grants geolocation permission, which is required for relative threat placement and emulator operation.
8. App starts receiving aircraft GNSS fixes from the iPad.
9. User activates the emulator after at least one valid threat exists.
10. Every 3 seconds, the app evaluates the latest aircraft state against the current working threat list.
11. If one or more threats are active, the app displays one large visual warning row per active threat in first-appearance order.
12. User can stop the emulator, import a replacement CSV, add/edit/delete individual threats, or export the current non-empty list.
13. User can see aircraft latitude/longitude, GPS altitude, height above ground level, GPS precision, and track status.
14. User can expand the Map panel to view the aircraft, threats, and threat effective ranges, select OpenStreetMap, OpenTopoMap, configured Mapy.com outdoor/aerial tiles, or configured Google satellite imagery through Leaflet's in-map layer button, and optionally keep the map centered on the latest aircraft position through a separate in-map Leaflet button. The app shows the selected tiles while online and an overlay-only grid while offline.
15. User can long press a map location on a touch device, or right-click it with a mouse, to open a new-threat form populated with that location and scroll the application to the editor. If a threat form is already visible, the gesture updates only its position, switches it to decimal-coordinate placement without resetting the other form values or current edit target, and scrolls back to the editor.
16. User can switch between light and dark themes from the header; the app remembers the choice on the current device.

## Threat CSV Format

CSV files use a semicolon delimiter only.

CSV latitude and longitude remain WGS84 decimal degrees. MGRS is supported only by the interactive threat editor and does not add or replace CSV columns.

CSV columns (`name` and `height_agl_m` are optional; all others are required):

```csv
id;name;latitude;longitude;height_agl_m;range_km
T001;Example Threat;50.0755;14.4378;12;25
```

Column definitions:

- `id`: Stable threat identifier.
- `name`: Optional human-readable threat description. A blank value or missing column is accepted.
- `latitude`: Threat latitude in decimal degrees, WGS84.
- `longitude`: Threat longitude in decimal degrees, WGS84.
- `height_agl_m`: Optional threat sensor height above local terrain, in meters. A blank value or missing column defines a magic threat with permanently clear line of sight.
- `range_km`: Threat effective range, in kilometers, measured as horizontal ground distance.

Validation rules:

- Required columns `id`, `latitude`, `longitude`, and `range_km` must be present.
- Only semicolon-delimited CSV is supported.
- Latitude must be between `-90` and `90`.
- Longitude must be between `-180` and `180`.
- When supplied, height must be greater than or equal to `0`.
- Range must be greater than or equal to `0`; zero-range threats display as `100 m`.
- Invalid rows should be reported without crashing the app.
- CSV file size is expected to be at most 1 MB.

## Threat Management And Manual Placement

The Threats panel owns the working threat list used by evaluation. A CSV import initializes or replaces this list; after import, its rows can be edited or deleted and manual threats can be added to it. If the list contains local changes, importing another CSV requires confirmation before those changes are replaced.

When the working list is non-empty, the panel displays an Export CSV action. Export serializes the current list rather than the original imported file, so it includes manual threats and all edits and deletions. It uses the documented semicolon-delimited columns and WGS84 decimal-degree coordinates; MGRS and aircraft-relative entries export their resolved coordinates. Optional descriptions and magic-threat heights export as blank cells. Text containing delimiters, quotes, or line breaks is CSV-escaped. The action triggers a local browser download and does not upload data.

The threat editor includes:

- Unique threat ID.
- Optional human-readable description.
- Optional sensor height AGL in meters, greater than or equal to `0` when supplied. A blank value creates a magic threat.
- Effective range in kilometers, greater than or equal to `0`.
- One of the following position methods:
  - WGS84 decimal-degree latitude and longitude.
  - MGRS grid reference at any precision accepted by the converter.
  - True bearing from the aircraft in degrees, from `0` through `360`, and horizontal distance from the aircraft in kilometers.

Coordinate and MGRS placement work without a CSV or aircraft position. MGRS input is case-insensitive, may contain spaces, and resolves to the center point of the referenced grid square. Relative placement requires a current GNSS aircraft position. When an MGRS or relative threat is saved, the app converts it to fixed WGS84 decimal-degree coordinates; the threat does not subsequently move with the aircraft. Editing an existing threat fills both its resolved decimal-degree coordinates and its one-meter MGRS grid reference. Positions in the polar regions unsupported by MGRS remain editable through decimal-degree coordinates.

The editor accepts either a dot or comma decimal separator. It rejects missing required values, invalid MGRS references, coordinates outside WGS84 bounds, negative height/range/distance, invalid bearings, and IDs already used by another threat in the working list. Adding the first manual threat enables the same evaluation workflow as importing a CSV. Deleting the final threat while the emulator is active stops the emulator.

## Elevation GeoTIFF Requirements

An optional GeoTIFF supplies terrain elevation for aircraft AGL calculation and terrain-aware line-of-sight checks. The emulator can start without it; in that mode, aircraft AGL is unavailable and all threats are treated as having clear line of sight.

Requirements:

- Coordinate system: WGS84.
- Elevation units: meters MSL.
- File source: user-selected local drive file.
- Expected size: 1-3 GB.
- NoData values must be detected and handled.
- The loaded GeoTIFF must cover the aircraft and threat positions being evaluated.

If a threat or aircraft position is outside GeoTIFF coverage, that threat evaluation must produce a clear "terrain unavailable" state instead of a false warning.

Large-file handling is a core V1 design constraint:

- The app must not load the full GeoTIFF into memory.
- Terrain reads should use metadata, windows, tiles, downsampling, and caching where possible.
- Line-of-sight evaluation should avoid blocking the UI thread.
- A web worker should be considered for GeoTIFF parsing and terrain sampling.
- The chosen GeoTIFF library must be validated against local 1-3 GB files on iPad mini.

## Aircraft State

The aircraft state comes from the iPad mini GNSS sensor through browser geolocation.

Required aircraft state:

- Latitude.
- Longitude.
- GPS altitude.
- GPS track.

Derived aircraft state:

- Terrain elevation at aircraft position from the GeoTIFF, when an elevation model is loaded.
- Orthometric aircraft altitude calculated as WGS84 ellipsoid altitude minus EGM96 geoid height.
- Aircraft AGL altitude calculated as orthometric aircraft altitude minus terrain elevation; unavailable without an elevation model.
- A calculated AGL below 15 meters is replaced with 50 feet.
- If the current aircraft terrain sample is unavailable, reuse the last successfully retrieved aircraft terrain elevation. This fallback does not apply to line-of-sight terrain samples.

Clock-code calculation uses GPS track only. Heading, compass bearing, and aircraft nose direction are not used.

The emulator uses the latest fully converted aircraft state every 3 seconds. A new GNSS fix replaces the evaluable state only after its EGM96 conversion finishes; until then, the previous converted state remains available for LOS and threat evaluation. GNSS update frequency is controlled by the browser and device; the evaluation interval does not guarantee a new GNSS fix every cycle.

## Threat Evaluation

The emulator evaluates all valid threats in the current editable working list every 3 seconds while active. A threat change invalidates prior results; while active, the app evaluates the updated list without waiting for a page reload.

For each threat:

1. Calculate horizontal ground distance from aircraft to threat.
2. If distance is greater than `range_km`, mark threat as inactive.
3. If distance is within range, assume line of sight is clear for a magic threat. For other threats, calculate line of sight when an elevation model is loaded; otherwise assume it is clear.
4. If line of sight is clear, mark threat as active.
5. Generate a threat call using description, GPS-track-relative clock code, and distance, in that order.

Threat states:

- `inactive`: Aircraft is outside threat range or line of sight is blocked.
- `active`: Aircraft is inside threat range and line of sight is clear.
- `terrain unavailable`: An elevation model is loaded, but required terrain data is missing or outside its coverage. A completely unloaded elevation model does not produce this state.
- `aircraft state unavailable`: Current GNSS position, altitude, or track is unavailable.
- `invalid`: Threat row failed validation.

If multiple threats are active, all of their calls are displayed. Existing active calls keep their first-appearance order. A threat removed from the active set loses its position; if it becomes active again, its call is appended after the calls that remained active. When multiple threats are first detected during the same evaluation, configured threat-list order is the deterministic tie-breaker.

## Line-Of-Sight Calculation

When an elevation model is loaded, V1 uses a flat-earth terrain obstruction check for threats with a numeric AGL. Magic threats (blank or missing AGL) are always reported as clear/VLOS without terrain sampling. When no model is loaded, LOS is reported as clear/VLOS for every threat and no terrain sampling is performed; threat activation depends only on horizontal range.

Algorithm:

1. Get terrain elevation at the threat location.
2. Threat sensor altitude is `threatTerrainMsl + height_agl_m`.
3. Use the EGM96-converted orthometric aircraft altitude as the aircraft altitude reference for LOS.
4. Sample points between threat and aircraft along the ground path.
5. Interpolate the sight-line altitude between threat sensor altitude and aircraft altitude.
6. Read terrain elevation at each sample point.
7. Line of sight is blocked if terrain is at or above the sight line at any sample.

GPS altitude accuracy is not added as a line-of-sight margin, and sight-line elevations are compared without integer rounding.

Out of scope for V1:

- Earth curvature.
- Atmospheric refraction.
- Buildings.
- Vegetation.
- Other non-terrain obstructions.

Sampling distance should be derived from GeoTIFF resolution where possible. A fixed maximum step size may be used initially if it is documented and performs acceptably on iPad mini.

## Warning Call

When a threat is active, the app displays a large visual warning text message.

Example:

```text
ALPHA 3 O'CLOCK 12 KM
```

Warning calls use the structure `DESCRIPTION CLOCK CODE DISTANCE`. The threat's
ID replaces the description when its description is blank. The clock-code
component is omitted when aircraft track is unavailable.

Clock-code calculation:

- Calculate bearing from aircraft to threat.
- Compare that bearing to aircraft GPS track.
- Convert relative bearing into a 12-hour clock position.

Distance formatting:

- Show one standard range bucket.
- Use 100m through 900m in 100m steps, then 1km, 1.5km, 2km, and
  whole-kilometer buckets from 3km upward.
- The lowest displayed bucket is 100m, including for a raw distance or threat
  range of 0.
- Round to the nearest bucket; if exactly between two buckets, use the larger bucket.

Multiple active threats:

- Show one equally prominent warning row for every active threat.
- Keep rows in first-appearance order while threats remain continuously active.
- Remove an inactive threat's row immediately; append its row at the bottom if it later reactivates.
- Use configured threat-list order when multiple threats first activate in the same evaluation.

## User Interface

V1 uses a text/status warning interface with a secondary situational map. The map supplements the warning and evaluation table; it does not participate in threat activation or line-of-sight calculations.

Required controls and displays:

- Threat CSV file picker; importing CSV is optional when threats are entered manually.
- Add-threat action available when no CSV is loaded.
- Edit and delete actions for every imported or manual threat.
- Export CSV action visible only when at least one threat exists.
- Threat editor for ID, description, height AGL, effective range, and decimal-degree, MGRS, or aircraft-relative placement.
- Optional elevation GeoTIFF file picker.
- Elevation GeoTIFF download link shown only while no elevation file is loaded or remembered.
- Loaded data status and validation summary.
- Geolocation permission/status indicator.
- Current aircraft latitude, longitude, GPS altitude, calculated AGL, and GPS track.
- Start / stop emulator control.
- Current evaluation status. The button label, warning area, and evaluation countdown convey whether the emulator is running; the header does not repeat that state in a separate status element.
- Header-level toggle with a sun on the light side, a moon on the dark side, and a high-contrast thumb and track that indicate the active theme. Its tooltip and accessible label describe the theme that selecting it will activate, and its pressed state exposes whether dark mode is active.
- Large warning text row for every active threat.
- Threat validation/status summary.
- Separate collapsible aircraft status and threat table panels, collapsed by default. The threat table uses two-line ID/description, distance/range, LOS/state, and actions columns. Activation conditions use the theme accent (blue in light mode and green in dark mode); out-of-range, BLOS, inactive, unavailable, warning, and error states use red. Values not yet evaluated use neutral grey placeholders.
- On viewport widths above 900 px, Controls, Aircraft Status, and Threats are stacked in an independently vertically scrollable left column. The Map panel occupies the right column and, while expanded, stretches into the explicit remaining-height layout row so its map stays visible and fits below the header and warning area without creating page-level vertical overflow. At 900 px and below, the panels return to a single-column flow with the Map after the other panels. Map actions remain compact Leaflet controls inside the map at every viewport width.
- A separate collapsible Map panel, collapsed by default, containing:
  - A theme-accented top-down airplane marker at the latest GNSS position: blue in light mode and green in dark mode. Its nose follows GPS track when track is available and points north when track is unavailable.
  - A red marker and identifier for every threat in the working list.
  - A red metric circle centered on each threat with radius equal to `range_km`.
  - Tooltips containing aircraft coordinates or threat description and effective range.
  - Leaflet's native collapsed layer control, displayed as an icon button in the map's upper-right corner, for OpenStreetMap, OpenTopoMap, Mapy.com outdoor, Mapy.com aerial, and Google satellite. The Mapy.com choices remain visible but disabled when `VITE_MAPY_API_KEY` is not configured; Google satellite behaves the same when `VITE_GOOGLE_MAPS_API_KEY` is not configured.
  - Mapy.com copyright attribution and a clickable Mapy.com logo while either Mapy.com layer is displayed.
  - A legend with the map-placement gesture hint displayed beside it, plus a visible header-level connectivity state: `Online - map tiles available` or `Offline - overlays only`.
  - Long-press placement on touch devices and right-click placement with a mouse. The selected WGS84 coordinates open and populate a new-threat form, or replace only the position in an already-visible add/edit form, then scroll the application to that editor.
  - Automatic framing when the displayed aircraft/threat set changes, while preserving user pan and zoom during ordinary aircraft position updates.
  - An unpressed-by-default custom Leaflet target-icon button below the zoom control. While pressed, every aircraft-position update recenters the map without changing its zoom level. Its accent background and accessible pressed state expose following status. Manual map navigation automatically releases the button so the map remains at the user's chosen view.

The UI must be designed for iPad mini screen size and touch interaction.

Theme colors are implemented through semantic tokens so native controls, panels, status text, the offline map grid, Leaflet controls, and existing map overlays update immediately without recreating application state. Only the theme identifier is stored in local storage; theme switching must continue for the current page when storage is unavailable.

UI implementation responsibilities are separated by feature: the entry module only registers the service worker, mounts the shell, and starts a page-lifetime `ThreatEmulatorApp` instance. That class owns remaining mutable application state and top-level workflow orchestration. `TerrainController` owns terrain selection, persistent file restoration, and GeoTIFF loading, while `AircraftAltitudeController` owns EGM96 conversion, aircraft terrain sampling, AGL fallback state, and stale asynchronous-result protection. Dedicated UI modules own shell mounting, state rendering, threat editing, map lifecycle, and wake-lock lifecycle. Stateless altitude, parsing, geospatial, line-of-sight, evaluation, and warning rules remain domain functions. Dynamic user/file content is assigned as text rather than interpolated into HTML.

## Offline And PWA Behavior

- The app must not require a backend after initial load.
- The app should be installable as a PWA.
- Static app assets should be cached for offline launch.
- Leaflet code and styles are bundled with the app and remain available offline.
- The selected OpenStreetMap, OpenTopoMap, configured Mapy.com outdoor/aerial, or configured Google satellite layer is added only while `navigator.onLine` reports online. The base layer is removed when the browser goes offline, leaving aircraft markers, threat markers, range circles, zoom/pan controls, and a neutral grid background available.
- Returning online restores the selected base layer without requiring a page reload.
- Mapy.com tiles use a browser-visible API key supplied through `VITE_MAPY_API_KEY`; production builds receive it through the `MAPY_API_KEY` GitHub Actions secret. The key must be restricted by HTTP referrer and to the Map Tiles API service.
- Google satellite uses the official Google Maps JavaScript API, requires billing and an HTTP-referrer-restricted browser API key, and is not loaded until selected. Production builds receive the optional key through the `GOOGLE_MAPS_API_KEY` GitHub Actions secret.
- User-selected CSV and GeoTIFF files remain local to the device.
- Manually entered and locally edited threats remain in browser memory for the current page session; they are not uploaded or written back to the source CSV.
- Exported CSV files are generated locally from the in-memory working list.
- No loaded file contents should be uploaded.
- The app should clearly indicate whether required local files, and any optional remembered GeoTIFF, need to be reselected after a fresh launch.

Because the GeoTIFF may be 1-3 GB, the application should not try to cache the elevation file as a PWA asset.

## Deployment

Production deployment target:

- GitHub Pages.

CI/CD:

- GitHub Actions installs dependencies.
- GitHub Actions runs type checks and build.
- GitHub Actions publishes the Vite production output to GitHub Pages.

## Error Handling

The app should show actionable errors for:

- Emulator activation when the working threat list is empty.
- Malformed CSV.
- Wrong CSV delimiter.
- Missing CSV columns.
- Invalid threat rows.
- Missing or invalid manual threat fields.
- Missing or invalid MGRS coordinate.
- Duplicate manual threat ID.
- Relative placement requested before an aircraft GNSS position is available.
- Unsupported or unreadable GeoTIFF.
- GeoTIFF not in WGS84.
- GeoTIFF elevation values unavailable.
- GeoTIFF missing required georeferencing metadata.
- GeoTIFF file too large or unsupported by the browser/library.
- Aircraft GNSS permission denied.
- Aircraft position unavailable.
- Aircraft GPS altitude unavailable.
- Aircraft GPS track unavailable.
- Aircraft or threat outside GeoTIFF coverage.
- Emulator activated before required threat or aircraft inputs are ready. An elevation model is not a required input.

## Performance Considerations

- Threat evaluation runs every 3 seconds.
- CSV files are small, at most 1 MB.
- GeoTIFF files are large, approximately 1-3 GB.
- The app must avoid full-raster reads.
- GeoTIFF metadata and raster windows should be cached where useful.
- Terrain sampling should be bounded to prevent long UI stalls.
- Expensive GeoTIFF reads and LOS calculations should be candidates for a web worker.
- Map overlay updates should reuse one Leaflet map and overlay layer rather than recreate the map for every GNSS fix. The map should initialize only when its collapsed panel is first opened.
- The target performance device is iPad mini, so memory pressure and browser file handling limits are important risks.

## Testing Strategy

Automated tests should cover:

- Theme preference restoration, accessible toggle state, and persistence after switching.
- Semicolon CSV parsing and validation.
- Manual coordinate threat creation and validation.
- MGRS-to-WGS84 threat creation and invalid-MGRS validation.
- Aircraft-relative placement by true bearing and distance.
- Relative-placement behavior when aircraft position is unavailable.
- Duplicate threat ID rejection.
- Current-list CSV serialization, including escaping and blank optional fields.
- Distance calculation.
- Bearing calculation.
- GPS-track-relative clock code conversion.
- GeoTIFF coordinate-to-pixel conversion.
- Terrain sampling.
- Aircraft AGL calculation.
- Line-of-sight blocked and clear cases.
- No-elevation-model behavior where LOS is assumed clear and range is the only activation factor.
- Threat activation logic.
- Multiple-active-threat warning count and first-appearance ordering, including reactivation at the end.

Manual test fixtures should include:

- A small sample CSV.
- Mocked or synthetic terrain grid data for LOS tests.
- Known aircraft positions for out-of-range, in-range blocked, and in-range clear cases.
- Online and offline Map panel checks confirming that Leaflet's layer icon selects OpenStreetMap, OpenTopoMap, configured Mapy.com outdoor/aerial tiles, and configured Google satellite imagery according to connectivity while aircraft markers, threat markers, range circles, tooltips, and controls remain available in both modes. Confirm that Mapy.com layers show the required logo and copyright. Also confirm that the target-icon aircraft-follow button follows GNSS position updates at the current zoom, exposes its pressed state, and releases after manual pan or zoom.

The repository should include the sample CSV fixture only. Large GeoTIFF fixtures should not be committed.
