/*
 * app.js — wires the Gulf of Mexico basemap and the animated current layer.
 */
(function () {
  "use strict";

  // ----- Map ---------------------------------------------------------------
  // The velocity data is a finite rectangular grid (lon -99.04..-58.0, lat
  // 8.0..41.84 — the global HYCOM GOFS 3.1 GLBy0.08 surface frame, 2024-08-28).
  // It now spans the Gulf of Mexico *and* the SE US Atlantic, so the Gulf Stream
  // is visible turning the corner at Florida and running NE past Cape Hatteras.
  // Two rectangles frame the view:
  //
  //   SAFE_BOUNDS   a rectangle inset ~1deg from every data edge, used as a hard
  //                 maxBounds wall so panning can't drag the rectangular grid
  //                 edge (and its faint particle fringe) into view. Unlike the
  //                 old Gulf-only frame, the east and north edges are now open
  //                 Atlantic (no land to mask the edge), so the inset matters.
  //   DEFAULT_VIEW  the editorial frame shown on load: the Gulf basin plus the
  //                 Gulf Stream's path up the Atlantic seaboard — the Texas/
  //                 Mexico shelf and western eddies on the left, the Yucatán
  //                 inflow and Loop Current in the middle, Florida and the
  //                 Straits exit, and the Gulf Stream running NE past Cape
  //                 Hatteras toward the open Atlantic on the right.
  var SAFE_BOUNDS = L.latLngBounds([13.0, -98.5], [41.0, -59.0]);
  var DEFAULT_VIEW = L.latLngBounds([20.0, -94.5], [33.0, -75.0]);

  var map = L.map("map", {
    maxZoom: 9,
    zoomControl: false,
    // No attribution control: the basemap is now public-domain Natural Earth
    // land (see below), which requires no credit, and nothing else on the map
    // is OSM/ODbL-derived. This also suppresses Leaflet's default "Leaflet"
    // prefix, which the prefix setter would otherwise still show.
    attributionControl: false,
    dragging: false,          // no drag-panning: the view is a fixed editorial frame
    // Zoom is fully locked: the user can never change the zoom level, so the
    // edge-safe framing computed in reframe() can't be zoomed out of (which
    // would re-expose the rectangular data edge) or zoomed into. Every zoom
    // entry point is disabled here:
    scrollWheelZoom: false,   // mouse wheel / trackpad scroll
    doubleClickZoom: false,   // double-click / double-tap
    touchZoom: false,         // pinch-zoom on touch devices
    boxZoom: false,           // shift-drag zoom box
    keyboard: false,          // +/- and arrow keys (also blocks keyboard pan)
    maxBounds: SAFE_BOUNDS,
    maxBoundsViscosity: 1.0   // hard wall: the view can't slip past the inset
  });

  // Belt-and-suspenders: ensure the drag handler is off even if some other code
  // path re-enables it. In Leaflet the single `dragging` handler covers both
  // mouse drag and touch drag-pan, so this disables panning on every device.
  // The animation, zoom controls, and the speed of the current layer are all
  // independent of dragging and keep running.
  map.dragging.disable();

  // Re-frame the editorial view whenever the map's size changes, not just at
  // load, so the basin stays centered at any frame size or aspect ratio.
  //
  // Two zooms drive the framing:
  //
  //   coverZoom = getBoundsZoom(SAFE_BOUNDS, true)  — the *minimum* zoom at which
  //     the viewport fits entirely *inside* SAFE_BOUNDS ("cover"). At this zoom
  //     or higher the visible rectangle can never reach a data edge, on any
  //     aspect ratio. We use it as the minZoom floor so neither the initial
  //     frame nor any later zoom-out can re-expose the rectangular grid edge /
  //     particle fringe.
  //
  //   fitZoom = getBoundsZoom(DEFAULT_VIEW, false)  — the largest zoom at which
  //     the whole editorial frame still fits ("contain"). This is the nice Gulf
  //     framing on ordinary screens.
  //
  // We show max(coverZoom, fitZoom - ZOOM_OUT): on normal aspect ratios the
  // (zoomed-out) editorial frame wins; on extreme aspect ratios (very wide, or
  // tall/narrow phones) coverZoom wins and the view zooms in just enough to keep
  // every data edge out of frame, staying centered on the Gulf. fitBounds alone
  // (the previous approach) "contained" DEFAULT_VIEW and therefore over-showed
  // the unconstrained dimension on those extreme frames, revealing the edge.
  //
  // ZOOM_OUT pulls the editorial frame back a half zoom interval from the exact
  // DEFAULT_VIEW fit so a touch more basin is in frame (the Yucatán Channel, the
  // western Gulf, and part of the Gulf Stream all visible at once) without
  // exposing the data edges: coverZoom is still the hard floor, and DEFAULT_VIEW
  // is roughly half the linear size of SAFE_BOUNDS (coverZoom ~= fitZoom - 1), so
  // fitZoom - 0.5 stays comfortably above the edge-safe floor on normal screens.
  var ZOOM_OUT = 0.5;
  function reframe() {
    var coverZoom = map.getBoundsZoom(SAFE_BOUNDS, true);
    var fitZoom = map.getBoundsZoom(DEFAULT_VIEW, false);
    map.setMinZoom(coverZoom);
    map.setView(DEFAULT_VIEW.getCenter(), Math.max(coverZoom, fitZoom - ZOOM_OUT), { animate: false });
  }
  reframe();
  map.on("resize", reframe);

  // ----- Basemap: Natural Earth land polygons (public domain) --------------
  // Replaces the former OpenFreeMap (OSM-derived) vector-tile basemap. Only the
  // coastline / land geometry was ever used from that tile stack — no roads,
  // labels, or POIs — and OSM data is ODbL, which legally requires an on-map
  // attribution line. Natural Earth is public domain and needs no credit, and
  // vector land renders crisply with a fill color we control directly instead
  // of fighting a tile style.
  //
  // data/land.geojson is Natural Earth 1:10m "land" merged with 1:10m
  // "minor_islands" (physical vector), clipped to this map's frame and
  // simplified — see scripts/build_land_geojson.sh for the exact source URLs
  // and build steps. The 1:50m land was too blocky along Florida / Cuba /
  // Yucatán at our zoom, and the small Caribbean islands that frame the current
  // (the Florida Keys, the Bahamas and Cuba cays lining the Straits) only appear
  // once minor_islands is merged in. It is WGS84 (EPSG:4326) lon/lat; Leaflet's
  // GeoJSON layer projects it to Web Mercator itself.
  //
  // There is no ocean polygon: the ocean is the map container's CSS background
  // (#FFFFFF, white, see css/style.css) which keeps the blue→red current
  // ramp readable. Land is a grayish-blue fill for contrast.

  // A dedicated low pane guarantees the land always renders *under* the animated
  // current canvas, which lives in Leaflet's overlayPane (z-index 400),
  // regardless of the async order in which the two layers finish loading.
  map.createPane("land");
  map.getPane("land").style.zIndex = 250;

  var landLayer = L.geoJSON(null, {
    pane: "land",
    interactive: false,
    style: {
      color: "#c3ccd6",     // faint coastline stroke
      weight: 0.5,
      fillColor: "#DBE2EA", // grayish-blue land (reference-map palette)
      fillOpacity: 1,
      opacity: 1
    }
  }).addTo(map);

  // If land.geojson is missing or won't parse, the CSS background still paints
  // an all-ocean canvas, so the current animation always plays.
  fetch("data/land.geojson", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error("no land file"); return r.json(); })
    .then(function (geo) { landLayer.addData(geo); })
    .catch(function () { /* ocean-only fallback */ });

  // Zoom is locked (see the map options above), so there is no click-to-enable
  // scroll-zoom behavior — the editorial frame stays fixed.

  // ----- Animated current layer -------------------------------------------
  // Cool->hot ramp tuned for the LIGHT water/land basemap: it starts at a
  // saturated deep blue and ramps through teal/green to amber and a deep red at
  // the Loop Current core. (The old ramp saturated to white, which was built for
  // the near-black canvas and washes out on light water.)
  var colorScale = [
    "#1d4e89", "#1f7fb0", "#1aa0a0", "#3fb56b", "#9ccb3b",
    "#e8d52f", "#f5a623", "#f2682c", "#e03131", "#9e1b1b"
  ];

  var velocityLayer = L.velocityLayer({
    displayValues: false,
    data: [],
    minVelocity: 0.0,
    maxVelocity: 1.4,        // speeds at/above this (Loop Current core) saturate to white
    velocityScale: 0.100,    // particle step per frame — longer, more visible streaks
    particleAge: 120,        // frames a particle lives before it is recycled to a
                             // fresh random spot. Keep this modest: large values
                             // let particles drain out of the fast Loop Current jet
                             // and pile up forever in the closed eddy loops, which
                             // makes the current die out and the eddies clump.
    particleMultiplier: 1 / 75, // streak density: particles per canvas pixel
                                // (numParticles = canvasW * canvasH * this).
                                // Raised from 1/150 for a denser, fuller flow;
                                // 1/75 fills the field richly and still renders
                                // smoothly at frameRate 24 without clutter.
    lineWidth: 3,
    frameRate: 24,
    opacity: 0.92,
    colorScale: colorScale
  });
  velocityLayer.addTo(map);

  // Prefer REAL HYCOM data (data/gulf-currents.json — a fixed HYCOM GOFS 3.1
  // GLBy0.08 surface snapshot, 2024-08-28; see scripts/convert_hycom.py for
  // provenance). Fall back to the procedural field if it isn't there or won't
  // load, so the animation always plays.
  function useProcedural() {
    velocityLayer.setData(window.GulfCurrentField.build());
  }

  fetch("data/gulf-currents.json", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error("no data file"); return r.json(); })
    .then(function (data) {
      if (!Array.isArray(data) || data.length < 2) throw new Error("bad data");
      velocityLayer.setData(data);
    })
    .catch(useProcedural);
})();
