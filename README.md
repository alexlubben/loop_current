# Loop Current — Gulf of Mexico flow animation

An embeddable, animated map that shows how water moves through the Gulf of
Mexico: surging up through the **Yucatán Channel**, looping clockwise into the
eastern Gulf as the **Loop Current**, pinching off **anticyclonic eddies** that
drift west, and bending back through the **Straits of Florida** to feed the
**Gulf Stream**.

It echoes the
[GCOOS HYCOM ocean-current map](https://geo.gcoos.org/data/maps/gcoos-region/):
a clean light water/land basemap with flowing particle streaklines colored by
current speed.

![Poster preview](poster.png)

> **Data:** the animation is driven by **real HYCOM surface currents** — a
> **fixed HYCOM GOFS 3.1 GLBy0.08 snapshot from 2024-08-28**, which spans the
> Gulf of Mexico *and* the SE US Atlantic so the Gulf Stream is visible turning
> the corner at Florida and running northeast past Cape Hatteras (the central
> Gulf holds the anticyclonic ring **Eddy Denali**). See "Current data snapshot"
> below. If the data file is ever unavailable, the page automatically falls back
> to a hand-composed *illustrative* field so the animation always plays. The
> on-map credit line shows which one is displayed and the snapshot date.

## What's in here

| Path | Purpose |
| --- | --- |
| `index.html` | The standalone, embeddable page |
| `js/app.js` | Sets up the Leaflet map, basemap, and animated current layer |
| `scripts/convert_hycom.py` | Converts a HYCOM GOFS 3.1 GLBy0.08 surface NetCDF → `data/gulf-currents.json` (the snapshot that currently ships; see provenance below) |
| `tools/fetch-currents.js` | Legacy: pulls real HYCOM currents from NOAA ERDDAP → `data/gulf-currents.json` |
| `tools/fetch-hycom-tsis.py` | Legacy: pulls a fixed HYCOM-TSIS 2010 Gulf-only reanalysis snapshot → `data/gulf-currents.json` |
| `tools/test_convert_synthetic.py` | Offline test of the NetCDF→JSON conversion schema |
| `js/current-field.js` | Generates the fallback (illustrative) velocity field |
| `css/style.css` | Title, legend, and embed styling |
| `vendor/` | Vendored Leaflet, MapLibre GL + leaflet-maplibre-gl, leaflet-velocity (no CDN needed at runtime) |
| `tools/render-preview.js` | Renders `poster.png`, a static streamline snapshot |
| `.github/workflows/pages.yml` | Renders the poster and deploys the static site to Pages |

The libraries are vendored locally, so at runtime the page only fetches the
current-data JSON (same-origin) and the basemap vector tiles from
[OpenFreeMap](https://openfreemap.org) (open OpenStreetMap data, no API key). If
the tiles are ever unreachable, the page falls back to a plain background and the
animation still plays.

## How the data works

The map shows a **fixed real snapshot** of the Gulf and the Gulf Stream rather
than a hand-drawn cartoon. The current field in `data/gulf-currents.json` is the
HYCOM GOFS 3.1 GLBy0.08 2024-08-28 surface snapshot documented under
"Current data snapshot" below.

1. `data/gulf-currents.json` is committed to the repo (a leaflet-velocity u/v
   grid). The Pages workflow deploys it as-is, so the browser loads it
   **same-origin** — no CORS headaches in a CMS embed. It is **not** refreshed
   on a schedule, so the snapshot is stable.
2. `js/app.js` loads the JSON; if it's missing, it uses the procedural fallback.

Two tools can (re)generate the data file:

```bash
# Fixed HYCOM GOFS 3.1 GLBy0.08 snapshot (this is what currently ships).
# Download the NetCDF from the NCSS URL in "Current data snapshot" below to
# tmp/glb2024.nc, then convert:
pip install numpy netCDF4
python3 scripts/convert_hycom.py tmp/glb2024.nc data/gulf-currents.json

# Legacy: a fixed HYCOM-TSIS 2010 Gulf-only reanalysis snapshot:
python3 tools/fetch-hycom-tsis.py run --date 2010-06-15T00:00:00Z

# Legacy: a live daily HYCOM/RTOFS field from NOAA/IOOS ERDDAP (basin-wide).
# Self-discovering across ERDDAP servers; run anywhere with open internet:
node tools/fetch-currents.js
```

## Current data snapshot — provenance

`data/gulf-currents.json` currently holds a **fixed snapshot** of the global
HYCOM GOFS 3.1 product, cropped to the Gulf of Mexico and the SE US Atlantic so
the Gulf Stream is in frame. The values come straight from the HYCOM GLBy0.08
surface field, converted by `scripts/convert_hycom.py` into the leaflet-velocity
u/v grid the page already renders.

| Field | Value |
| --- | --- |
| Dataset | HYCOM GOFS 3.1 — `GLBy0.08/expt_93.0` (global, 1/12°) |
| Provider | HYCOM Consortium / U.S. Naval Oceanographic Office, served via the HYCOM THREDDS Data Server |
| NCSS | `https://ncss.hycom.org/thredds/ncss/GLBy0.08/expt_93.0?var=water_u&var=water_v&north=42&south=8&west=261&east=302&horizStride=1&time=2024-08-28T00:00:00Z&vertCoord=0&addLatLon=true&accept=netcdf4` |
| Variables | `water_u` (eastward) / `water_v` (northward) sea-water velocity, surface (Depth = 0), m/s |
| Snapshot date | **2024-08-28 00:00:00Z** (time axis: hours since 2000-01-01) |
| Bounding box | 99.04°W–58.0°W, 8.0°N–42.0°N (lon 261–302°E in the source 0–360° frame) |
| Native grid | 514 × 851, 0.08° lon / 0.04° lat; subsampled to 172 × 142 at ~0.24° (lon every 3rd point, lat every 6th) |
| Access date | 2026-06-23 |

Why 2024-08-28: this frame shows the anticyclonic ring **Eddy Denali** in the
central Gulf alongside the classic configuration — Yucatán Channel inflow, the
Loop Current, a fast Florida-Straits exit, and the Gulf Stream running northeast
along the SE US coast and past Cape Hatteras into the open Atlantic.

Processing notes (`scripts/convert_hycom.py`):
- Source longitudes are 0–360°E and are converted to signed −180…180°.
- HYCOM's land/fill values (`> 1e4`) and NaNs are mapped to JSON `null`.
- Rows are written **N→S**, columns **W→E**, with the NW corner as the origin
  (`lo1`/`la1`).

Legacy provenance (`tools/fetch-hycom-tsis.py`, the prior 2010 Gulf-only file
preserved as `data/gulf-currents.2010.json`):
- Only the surface level and single timestep are kept; HYCOM's land sentinel
  (`2^126 ≈ 1.27e30`, which doesn't exactly equal the file's `_FillValue`
  attribute) is mapped to JSON `null`, matching the original file's land coding.
- Longitudes are already signed (−180…180); rows are written **N→S**, columns
  **W→E**, with the NW corner as the origin (`lo1`/`la1`), exactly as the
  renderer expects.
- The native latitude axis is Mercator (non-uniform); because leaflet-velocity
  assumes a uniform `dy`, u/v are resampled onto a uniform latitude axis
  (nearest native row, which preserves the coastline mask and avoids the
  several-cell drift a mean `dy` would introduce). Longitude is left untouched.

Reproduce / re-point to another date:

```bash
pip install numpy netCDF4
python3 tools/fetch-hycom-tsis.py introspect              # confirm vars/axes (needs network)
python3 tools/fetch-hycom-tsis.py run --date 2010-07-15T00:00:00Z   # download + convert
# or convert a NetCDF you already downloaded (e.g. an NCSS subset):
python3 tools/fetch-hycom-tsis.py convert-file --file reanalysis_2010.nc4
python3 tools/test_convert_synthetic.py                   # offline schema test
```

> The HYCOM THREDDS hosts (`tds.hycom.org`, `ncss.hycom.org`) must be reachable
> for the live download stages; the `convert-file` and test stages run offline.

## Run / preview locally

It's all static files — serve the folder with any web server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

(Open it through a server rather than `file://` so the browser can load the
local scripts.)

## Embed it in a CMS

Host this folder somewhere (any static host: S3 + CloudFront, Netlify, GitHub
Pages, your own server) and drop an `<iframe>` into the article:

```html
<iframe
  src="https://YOUR-HOST/path/to/loop-current/index.html"
  width="100%"
  height="520"
  style="border:0; aspect-ratio: 16 / 9; max-width: 960px;"
  loading="lazy"
  title="The Loop Current — Gulf of Mexico"
  allowfullscreen></iframe>
```

Tips for newsroom embeds:
- The map **does not** grab the page's scroll wheel. A reader has to click the
  map first to zoom — so it won't hijack scrolling in a long article.
- It's fully responsive; it fills whatever box the iframe gives it.
- `poster.png` works as a social-card / `og:image` and as a lightweight preview.

## Tuning the flow

Everything visual lives in two places and is easy to adjust.

**Look & feel — `js/app.js`:**

| Option | Effect |
| --- | --- |
| `velocityScale` | How fast particles move |
| `particleMultiplier` | Streak density (smaller denominator = more streaks) |
| `particleAge` | How long a streak lives before it's reborn |
| `lineWidth` | Streak thickness |
| `maxVelocity` | Speed mapped to the brightest end of the color scale |
| `colorScale` | The blue→cyan→gold→white speed ramp |

**The data source — `tools/fetch-currents.js`:**

- `SERVERS` / `SEARCH_TERMS` — which ERDDAP servers and models to search.
- `BBOX` — the geographic box pulled from the dataset.
- `STRIDE` — grid downsampling (1 = native ~0.08° resolution).

**The fallback pattern — `js/current-field.js`** (only shown if the data feed
fails):

- `CENTERLINE` — the Loop Current / Gulf Stream path, as `[lon, lat, speed]`
  waypoints.
- `EDDIES` — the rotating rings (`spin: 1` = clockwise/anticyclonic, `-1` =
  cyclonic).
- `JET_WIDTH`, `BACKGROUND` — jet breadth and the gentle ambient drift.

Re-render the poster after changing anything:

```bash
node tools/render-preview.js > preview.svg   # uses real data if present
```

## Credits

- Current data: HYCOM GOFS 3.1 `GLBy0.08/expt_93.0`
  ([HYCOM](https://www.hycom.org/), HYCOM Consortium / U.S. Naval Oceanographic
  Office), snapshot 2024-08-28 — see "Current data snapshot" for full provenance
- Basemap: © [OpenFreeMap](https://openfreemap.org) ©
  [OpenMapTiles](https://www.openmaptiles.org/), data from
  [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Particle engine: [leaflet-velocity](https://github.com/onaci/leaflet-velocity)
  (a Leaflet port of the earth.nullschool / Windy wind-particle renderer)
- Mapping: [Leaflet](https://leafletjs.com/) +
  [MapLibre GL JS](https://maplibre.org/) (via
  [leaflet-maplibre-gl](https://github.com/maplibre/maplibre-gl-leaflet))
- Inspired by the [GCOOS](https://geo.gcoos.org/data/maps/gcoos-region/) Gulf
  region ocean-current map.
