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

> **Note:** the flow is a *stylized illustration*, not live data. The Loop
> Current is always shifting; this field is hand-composed to give a vivid,
> readable sense of the circulation rather than a forecast. (See "Tuning the
> flow" to swap in real data if you ever want to.)

## What's in here

| Path | Purpose |
| --- | --- |
| `index.html` | The standalone, embeddable page |
| `js/app.js` | Sets up the Leaflet map, basemap, and animated current layer |
| `js/current-field.js` | Generates the synthetic Loop Current velocity field |
| `css/style.css` | Title, legend, and embed styling |
| `vendor/` | Vendored Leaflet + leaflet-velocity (no CDN needed at runtime) |
| `tools/render-preview.js` | Renders `poster.png`, a static streamline snapshot |

The libraries are vendored locally, so the **only** thing fetched at runtime is
the satellite basemap tiles (from Esri). If those tiles are ever unreachable,
the page falls back to a dark ocean background and the animation still plays.

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

**The current pattern — `js/current-field.js`:**

- `CENTERLINE` — the Loop Current / Gulf Stream path, as `[lon, lat, speed]`
  waypoints. Edit these to move the loop or change how far north it intrudes.
- `EDDIES` — the rotating rings (`spin: 1` = clockwise/anticyclonic, `-1` =
  cyclonic). Add, remove, or relocate them.
- `JET_WIDTH`, `BACKGROUND` — jet breadth and the gentle ambient drift.

Re-render the poster after changing the field:

```bash
node tools/render-preview.js > preview.svg   # static streamline snapshot
```

### Swapping in real data (optional)

`leaflet-velocity` consumes the same `u`/`v` grid JSON that the GCOOS map and
[earth.nullschool](https://earth.nullschool.net/) use. To drive this with real
[HYCOM](https://www.hycom.org/) surface currents, replace the
`window.GulfCurrentField.build()` call in `js/app.js` with a `fetch()` of a
HYCOM-derived velocity JSON (two records: `parameterNumber` 2 for eastward U,
3 for northward V). The rest of the page stays the same.

## Credits

- Basemap imagery © [Esri](https://www.esri.com/), Maxar, Earthstar Geographics
- Particle engine: [leaflet-velocity](https://github.com/onaci/leaflet-velocity)
  (a Leaflet port of the earth.nullschool / Windy wind-particle renderer)
- Mapping: [Leaflet](https://leafletjs.com/)
- Inspired by the [GCOOS](https://geo.gcoos.org/data/maps/gcoos-region/) Gulf
  region ocean-current map.
