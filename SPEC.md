# Threat Emulator Specification

## Purpose

Threat Emulator is a single-page offline web application written in TypeScript using Vite. It evaluates whether an aircraft is inside the effective envelope of terrain-based threats and displays a text message threat warning when the aircraft is within both threat range and line of sight.

The application runs entirely in the browser, uses user-selected local files, and is deployed as static production assets to GitHub Pages through GitHub Actions.

## Confirmed V1 Requirements

- Target device is iPad mini.
- Aircraft position comes from the iPad's built-in GNSS sensor through browser geolocation.
- Browser GPS ellipsoid altitude is converted to EGM96 orthometric MSL altitude, and aircraft AGL is calculated from the loaded elevation model.
- Aircraft track is used for clock-code calculation. Heading is not used.
- Threat scenery is loaded from a local semicolon-delimited CSV file.
- Elevation data is loaded from a local GeoTIFF file.
- GeoTIFF coordinates are WGS84.
- GeoTIFF elevation values are meters MSL.
- Threat height is sensor height above local terrain.
- Threat range uses horizontal ground distance.
- Line of sight uses a flat-earth terrain obstruction check. Earth curvature and atmospheric refraction are out of scope for V1.
- The emulator evaluates threats every 3 seconds while active.
- Warnings are visual only.
- The primary warning is a large text message.
- If multiple threats are active, the closest threat has priority.
- Distance is displayed using standard threat range buckets: 100m through 900m in
  100m steps, then 1km, 1.5km, 2km, and whole-kilometer buckets from 3km upward.
- V1 does not include a map. The user-facing output is text/status only.
- The app should be installable as a PWA for offline launch.
- CSV files are expected to be no larger than 1 MB.
- GeoTIFF files are expected to be large, approximately 1-3 GB.
- The repository should include a sample CSV fixture, but not a sample GeoTIFF fixture.

## Technology Stack

- TypeScript.
- Vite.
- Browser-only single-page application.
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
2. User selects a local threat scenery CSV file.
3. App validates and previews the loaded threats.
4. User selects a local elevation GeoTIFF file.
5. App validates GeoTIFF metadata, coordinate system, elevation units, and coverage.
6. User grants geolocation permission.
7. App starts receiving aircraft GNSS fixes from the iPad.
8. User activates the emulator.
9. Every 3 seconds, the app evaluates the latest aircraft state against all valid threats.
10. If one or more threats are active, the app displays a large visual warning for the closest active threat.
11. User can stop the emulator, clear loaded files, or load replacement files.
12. User can see status bar with gps location (lat,lon), gps altitude (feet), heigh above ground lavel (feet), gps precision

## Threat CSV Format

CSV files use a semicolon delimiter only.

Required columns:

```csv
id;name;latitude;longitude;height_agl_m;range_km
T001;Example Threat;50.0755;14.4378;12;25
```

Column definitions:

- `id`: Stable threat identifier.
- `name`: Human-readable threat name.
- `latitude`: Threat latitude in decimal degrees, WGS84.
- `longitude`: Threat longitude in decimal degrees, WGS84.
- `height_agl_m`: Threat sensor height above local terrain, in meters.
- `range_km`: Threat effective range, in kilometers, measured as horizontal ground distance.

Validation rules:

- Required columns must be present.
- Only semicolon-delimited CSV is supported.
- Latitude must be between `-90` and `90`.
- Longitude must be between `-180` and `180`.
- Height must be greater than or equal to `0`.
- Range must be greater than or equal to `0`; zero-range threats display as `100 m`.
- Invalid rows should be reported without crashing the app.
- CSV file size is expected to be at most 1 MB.

## Elevation GeoTIFF Requirements

The GeoTIFF supplies terrain elevation for aircraft AGL calculation and line-of-sight checks.

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

- Terrain elevation at aircraft position from the GeoTIFF.
- Orthometric aircraft altitude calculated as WGS84 ellipsoid altitude minus EGM96 geoid height.
- Aircraft AGL altitude calculated as orthometric aircraft altitude minus terrain elevation.
- A calculated AGL below 15 meters is replaced with 50 feet.
- If the current aircraft terrain sample is unavailable, reuse the last successfully retrieved aircraft terrain elevation. This fallback does not apply to line-of-sight terrain samples.

Clock-code calculation uses GPS track only. Heading, compass bearing, and aircraft nose direction are not used.

The emulator uses the latest fully converted aircraft state every 3 seconds. A new GNSS fix replaces the evaluable state only after its EGM96 conversion finishes; until then, the previous converted state remains available for LOS and threat evaluation. GNSS update frequency is controlled by the browser and device; the evaluation interval does not guarantee a new GNSS fix every cycle.

## Threat Evaluation

The emulator evaluates all valid threats every 3 seconds while active.

For each threat:

1. Calculate horizontal ground distance from aircraft to threat.
2. If distance is greater than `range_km`, mark threat as inactive.
3. If distance is within range, calculate line of sight.
4. If line of sight is clear, mark threat as active.
5. Generate a threat call using GPS-track-relative clock code and distance.

Threat states:

- `inactive`: Aircraft is outside threat range or line of sight is blocked.
- `active`: Aircraft is inside threat range and line of sight is clear.
- `terrain unavailable`: Required terrain data is missing or outside GeoTIFF coverage.
- `aircraft state unavailable`: Current GNSS position, altitude, or track is unavailable.
- `invalid`: Threat row failed validation.

If multiple threats are active, the closest active threat has display priority.

## Line-Of-Sight Calculation

V1 uses a flat-earth terrain obstruction check.

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
THREAT 3 O'CLOCK 12.4 KM
```

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

- Closest active threat is shown as the primary warning.
- Secondary active threats may be shown in a smaller status list if the UI remains clear on iPad mini.

## User Interface

V1 is a text/status interface, not a map interface.

Required controls and displays:

- Threat CSV file picker.
- Elevation GeoTIFF file picker.
- Loaded data status and validation summary.
- Geolocation permission/status indicator.
- Current aircraft latitude, longitude, GPS altitude, calculated AGL, and GPS track.
- Start / stop emulator control.
- Current evaluation status.
- Large primary warning text.
- Threat validation/status summary.
- Separate collapsible aircraft status and threat table panels, collapsed by default. The threat table uses two-line ID/description, distance/range, and LOS/state columns. Clear LOS is displayed as VLOS and terrain-blocked LOS as BLOS; values not yet evaluated use placeholders.

The UI must be designed for iPad mini screen size and touch interaction.

## Offline And PWA Behavior

- The app must not require a backend after initial load.
- The app should be installable as a PWA.
- Static app assets should be cached for offline launch.
- User-selected CSV and GeoTIFF files remain local to the device.
- No loaded file contents should be uploaded.
- The app should clearly indicate whether required local files need to be reselected after a fresh launch.

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

- Missing CSV file.
- Malformed CSV.
- Wrong CSV delimiter.
- Missing CSV columns.
- Invalid threat rows.
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
- Emulator activated before required inputs are ready.

## Performance Considerations

- Threat evaluation runs every 3 seconds.
- CSV files are small, at most 1 MB.
- GeoTIFF files are large, approximately 1-3 GB.
- The app must avoid full-raster reads.
- GeoTIFF metadata and raster windows should be cached where useful.
- Terrain sampling should be bounded to prevent long UI stalls.
- Expensive GeoTIFF reads and LOS calculations should be candidates for a web worker.
- The target performance device is iPad mini, so memory pressure and browser file handling limits are important risks.

## Testing Strategy

Automated tests should cover:

- Semicolon CSV parsing and validation.
- Distance calculation.
- Bearing calculation.
- GPS-track-relative clock code conversion.
- GeoTIFF coordinate-to-pixel conversion.
- Terrain sampling.
- Aircraft AGL calculation.
- Line-of-sight blocked and clear cases.
- Threat activation logic.
- Closest-threat prioritization.

Manual test fixtures should include:

- A small sample CSV.
- Mocked or synthetic terrain grid data for LOS tests.
- Known aircraft positions for out-of-range, in-range blocked, and in-range clear cases.

The repository should include the sample CSV fixture only. Large GeoTIFF fixtures should not be committed.

## Remaining Questions Before Implementation

1. Which iPad mini generation and iPadOS/Safari version must be supported?
2. Should CSV decimal values use a dot only, or should comma decimals also be accepted because the delimiter is semicolon?
3. Should GPS track come directly from browser geolocation `coords.heading`, be calculated from successive position fixes, or use both with fallback logic?
4. What should the warning display when GPS track is temporarily unavailable or the aircraft is moving too slowly for a reliable track?
5. Should there be a manual GPS altitude offset or calibration option if iPad altitude and GeoTIFF MSL elevations do not align well enough?
6. What maximum acceptable line-of-sight error is acceptable for V1?
7. Are the large elevation files standard GeoTIFF, BigTIFF, Cloud Optimized GeoTIFF, or unknown?
