/*
 * app.js — wires the Gulf of Mexico basemap and the animated current layer.
 */
(function () {
  "use strict";

  // ----- Map ---------------------------------------------------------------
  var map = L.map("map", {
    center: [25.0, -87.0],    // heart of the Gulf / Loop Current core
    zoom: 6,                  // close enough that the data's rectangular edge
                              // (esp. over the open Atlantic) stays off-screen
    minZoom: 3,               // zoom out far enough to take in the whole basin
    maxZoom: 9,
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: false,   // don't hijack page scroll inside an article
    maxBounds: [[4.0, -103.0], [45.0, -54.0]],
    maxBoundsViscosity: 0.9
  });

  // Move the +/- zoom control to the top-right so it doesn't sit on top of the
  // "Loop Current" title card in the top-left corner.
  map.zoomControl.setPosition("topright");

  // ----- Basemap (licensed, commercially safe) -----------------------------
  // OpenFreeMap (https://openfreemap.org) — a fully open-source tile service
  // built on OpenStreetMap data, free for commercial/editorial use, no API key.
  // It serves *vector* tiles, so we render them with MapLibre GL (vendored) via
  // the leaflet-maplibre-gl plugin rather than a raster L.tileLayer.
  //
  // The "positron" style is the clean, light water/land look (pale land, light
  // water) that replaces the old CARTO Voyager basemap. Swap `style` to
  // ".../styles/bright" for a more colored look. No subdomains or API key are
  // required; if you later move to a keyed provider, add the key to this block
  // (it is public on GitHub Pages — restrict it to your domain in the provider
  // dashboard; do not treat it as a secret).
  var BASEMAP = {
    style: "https://tiles.openfreemap.org/styles/positron",
    attribution:
      '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> ' +
      '&copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ' +
      'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 9   // enforced by the Leaflet map's own maxZoom above
  };

  // Single licensed base layer. customAttribution guarantees the required
  // OpenFreeMap / OpenMapTiles / OpenStreetMap credit renders in Leaflet's
  // attribution control regardless of the style's internal source metadata.
  var baseLayer = L.maplibreGL({
    style: BASEMAP.style,
    attributionControl: { customAttribution: BASEMAP.attribution }
  }).addTo(map);

  // Strip place-name labels and roads for a clean cartographic canvas under the
  // current animation, leaving only the landmass/water geometry. The positron
  // vector style renders all of its text as MapLibre "symbol" layers, and its
  // roads come from the OpenMapTiles "transportation" / "transportation_name"
  // source-layers. Once the style has loaded we remove both, keeping the
  // water/land fills. (OpenFreeMap has no prebuilt "no roads/labels" style, so
  // we do it here.)
  baseLayer.getMaplibreMap().on("load", function () {
    var glMap = baseLayer.getMaplibreMap();
    var ROAD_SOURCE_LAYERS = ["transportation", "transportation_name"];
    glMap.getStyle().layers.forEach(function (layer) {
      var isLabel = layer.type === "symbol";
      var isRoad = ROAD_SOURCE_LAYERS.indexOf(layer["source-layer"]) !== -1;
      if ((isLabel || isRoad) && glMap.getLayer(layer.id)) {
        glMap.removeLayer(layer.id);
      }
    });
  });

  // Only one licensed base layer and no imagery toggle, so no layers control.

  // Let users opt into scroll-zoom by clicking the map first.
  map.on("focus", function () { map.scrollWheelZoom.enable(); });
  map.on("blur", function () { map.scrollWheelZoom.disable(); });

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
    particleMultiplier: 1 / 150, // streak density
    lineWidth: 3,
    frameRate: 24,
    opacity: 0.92,
    colorScale: colorScale
  });
  velocityLayer.addTo(map);

  // Credit line that updates to reflect what's actually on screen.
  var credit = document.getElementById("credit");
  function setCredit(text) { if (credit) credit.textContent = text; }

  // Prefer REAL HYCOM data (data/gulf-currents.json, generated in CI from NOAA
  // ERDDAP). Fall back to the procedural field if it isn't there or won't load,
  // so the animation always plays.
  function useProcedural() {
    velocityLayer.setData(window.GulfCurrentField.build());
    setCredit("Illustrative flow field");
  }

  fetch("data/gulf-currents.json", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error("no data file"); return r.json(); })
    .then(function (data) {
      if (!Array.isArray(data) || data.length < 2) throw new Error("bad data");
      velocityLayer.setData(data);
      // Show the snapshot date in the credit. For a recent (live) feed show the
      // full date; for a historical reanalysis snapshot show month + year (e.g.
      // "Jun 2010") so it's clearly not presented as today's forecast.
      var h = data[0].header || {};
      var when = h.refTime ? new Date(h.refTime) : null;
      var date = "";
      if (when && !isNaN(when)) {
        var fresh = (Date.now() - when.getTime()) < 400 * 864e5;
        date = when.toLocaleDateString(undefined, fresh ?
          { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" } :
          { year: "numeric", month: "short", timeZone: "UTC" });
      }
      setCredit("Surface currents: HYCOM / NOAA" + (date ? " · " + date : ""));
    })
    .catch(useProcedural);
})();
