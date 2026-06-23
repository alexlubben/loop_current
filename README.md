# Loop Current — Gulf of Mexico flow animation

An embeddable, animated map that shows how water moves through the Gulf of
Mexico: surging up through the **Yucatán Channel**, looping clockwise into the
eastern Gulf as the **Loop Current**, pinching off **anticyclonic eddies** that
drift west, and bending back through the **Straits of Florida** to feed the
**Gulf Stream**.

It reproduces the look of the
[GCOOS HYCOM ocean-current map](https://geo.gcoos.org/data/maps/gcoos-region/):
luminous "Firefly" satellite imagery with flowing particle streaklines colored
by current speed.

![Poster preview](poster.png)

> **Data:** the animation is driven by **real HYCOM surface currents** for the
> Gulf — a **fixed HYCOM-TSIS reanalysis snapshot from 2010-06-15**, the Loop
> Current Eddy "Franklin" period (see "Current data snapshot" below). If the data
> file is ever unavailable, the page automatically falls back to a hand-composed
> *illustrative* field so the animation always plays. The on-map credit line
> shows which one is displayed and the snapshot date.

## What's in here

| Path | Purpose |
| --- | --- |
| `index.html` | The standalone, embeddable page |
| `js/app.js` | Sets up the Leaflet map, basemap, and animated current layer |
| `tools/fetch-currents.js` | Pulls real HYCOM currents from NOAA ERDDAP → `data/gulf-currents.json` |
| `tools/fetch-hycom-tsis.py` | Pulls a fixed HYCOM-TSIS 2010 Gulf reanalysis snapshot → `data/gulf-currents.json` (see provenance below) |
| `tools/test_convert_synthetic.py` | Offline test of the NetCDF→JSON conversion schema |
| `js/current-field.js` | Generates the fallback (illustrative) velocity field |
| `css/style.css` | Title, legend, and embed styling |
| `vendor/` | Vendored Leaflet + leaflet-velocity (no CDN needed at runtime) |
| `tools/render-preview.js` | Renders `poster.png`, a static streamline snapshot |
| `.github/workflows/pages.yml` | Renders the poster and deploys the static site to Pages |

The libraries are vendored locally, so at runtime the page only fetches the
current-data JSON (same-origin) and the satellite basemap tiles (from Esri). If
the tiles are ever unreachable, the page falls back to a dark ocean background
and the animation still plays.

## How the data works

The map shows a **fixed real snapshot** of the Loop Current rather than a
hand-drawn cartoon. The current field in `data/gulf-currents.json` is the
HYCOM-TSIS 2010-06-15 reanalysis snapshot documented under
"Current data snapshot" below.

1. `data/gulf-currents.json` is committed to the repo (a leaflet-velocity u/v
   grid). The Pages workflow deploys it as-is, so the browser loads it
   **same-origin** — no CORS headaches in a CMS embed. It is **not** refreshed
   on a schedule, so the snapshot is stable.
2. `js/app.js` loads the JSON; if it's missing, it uses the procedural fallback.

Two tools can (re)generate the data file:

```bash
# Fixed HYCOM-TSIS reanalysis snapshot (this is what currently ships):
pip install numpy netCDF4
python3 tools/fetch-hycom-tsis.py run --date 2010-06-15T00:00:00Z

# Legacy: a live daily HYCOM/RTOFS field from NOAA/IOOS ERDDAP (basin-wide).
# Self-discovering across ERDDAP servers; run anywhere with open internet:
node tools/fetch-currents.js
```

## Current data snapshot — provenance

`data/gulf-currents.json` currently holds a **fixed historical snapshot** of the
**Loop Current Eddy "Franklin"** summer (it is *not* the daily ERDDAP feed above).
The values come straight from the HYCOM-TSIS Gulf of Mexico reanalysis, converted
into the leaflet-velocity u/v grid the page already renders.

| Field | Value |
| --- | --- |
| Dataset | HYCOM-TSIS 1/25° Gulf of Mexico Reanalysis — `GOMb0.04/reanalysis`, dataset id `GOMb0.04-reanalysis-2010-3z`, experiment 01.0 |
| Provider | COAPS / Florida State University, served via the HYCOM THREDDS Data Server |
| Catalog | https://tds.hycom.org/thredds/catalogs/GOMb0.04/reanalysis.html |
| OPeNDAP | https://tds.hycom.org/thredds/dodsC/GOMb0.04/reanalysis/2010/3z |
| NCSS | https://ncss.hycom.org/thredds/ncss/grid/GOMb0.04/reanalysis/2010/3z |
| Variables | `u` (eastward) / `v` (northward) sea-water velocity, surface (Depth = 0), m/s |
| Snapshot date | **2010-06-15 00:00:00Z** (time axis `MT`, days since 1900-12-31) |
| Bounding box | 98.0°W–77.04°W, 18.09°N–31.96°N (the model's native Gulf domain) |
| Native grid | 525 × 385, 0.04° lon (even), Mercator lat (~0.034–0.038°) |
| Access date | 2026-06-23 |

Why 2010-06-15: Eddy Franklin shed from the Loop Current around 24 May 2010 and
the Loop stayed strongly extended through that summer (full separation came in
September). On this date the field shows the classic configuration — Yucatán
Channel inflow, a tall clockwise (anticyclonic) Loop intrusion, an anticyclonic
ring in the central Gulf (~88–89°W, 25–26°N), and a fast Florida-Straits exit.

Processing notes (`tools/fetch-hycom-tsis.py`):
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

- Current data: HYCOM-TSIS 1/25° Gulf of Mexico Reanalysis
  ([HYCOM](https://www.hycom.org/), COAPS / Florida State University), snapshot
  2010-06-15 — see "Current data snapshot" for full provenance
- Basemap imagery © [Esri](https://www.esri.com/), Maxar, Earthstar Geographics
- Particle engine: [leaflet-velocity](https://github.com/onaci/leaflet-velocity)
  (a Leaflet port of the earth.nullschool / Windy wind-particle renderer)
- Mapping: [Leaflet](https://leafletjs.com/)
- Inspired by the [GCOOS](https://geo.gcoos.org/data/maps/gcoos-region/) Gulf
  region ocean-current map.
