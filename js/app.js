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

  // CARTO "Voyager" (no labels) — a clean, light cartographic canvas with light
  // blue water and pale land, the flat "water / land colors" newsroom look. This
  // is the default basemap. Tiles load in the reader's browser at runtime.
  // {r} resolves to "@2x" on retina displays.
  var lightLand = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 9,
      subdomains: "abcd",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }
  );

  // CARTO "Dark Matter" (no labels) — the original near-black canvas. Kept as a
  // toggle for the high-contrast, glowing-streak look.
  var darkCanvas = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 9,
      subdomains: "abcd",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }
  );

  // Esri "Firefly" world imagery — the dark, luminous satellite look used by the
  // GCOOS reference map. Kept as a toggle for readers who want the imagery view.
  var firefly = L.tileLayer(
    "https://fly.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Firefly/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 9,
      attribution:
        'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics'
    }
  );

  var imagery = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 9,
      attribution:
        'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics'
    }
  );

  lightLand.addTo(map);

  L.control.layers(
    { "Light (water / land)": lightLand, "Dark canvas": darkCanvas, "Imagery (Firefly)": firefly, "Imagery": imagery },
    null,
    { position: "topright", collapsed: true }
  ).addTo(map);

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
