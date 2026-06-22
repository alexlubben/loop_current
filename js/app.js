/*
 * app.js — wires the Gulf of Mexico basemap and the animated current layer.
 */
(function () {
  "use strict";

  // ----- Map ---------------------------------------------------------------
  var map = L.map("map", {
    center: [24.4, -88.5],
    zoom: 6,
    minZoom: 5,
    maxZoom: 9,
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: false,   // don't hijack page scroll inside an article
    maxBounds: [[14.0, -101.5], [33.5, -73.0]],
    maxBoundsViscosity: 0.9
  });

  // Esri "Firefly" world imagery — the dark, luminous satellite look used by
  // the GCOOS reference map. Falls back to standard World Imagery if Firefly
  // tiles are unavailable. Tiles load in the reader's browser at runtime.
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

  firefly.addTo(map);
  // If Firefly tiles error out, swap to the standard imagery service.
  var fireflyErrors = 0;
  firefly.on("tileerror", function () {
    if (++fireflyErrors === 4 && map.hasLayer(firefly)) {
      map.removeLayer(firefly);
      imagery.addTo(map);
    }
  });

  L.control.layers(
    { "Imagery (Firefly)": firefly, "Imagery": imagery },
    null,
    { position: "topright", collapsed: true }
  ).addTo(map);

  // Let users opt into scroll-zoom by clicking the map first.
  map.on("focus", function () { map.scrollWheelZoom.enable(); });
  map.on("blur", function () { map.scrollWheelZoom.disable(); });

  // ----- Animated current layer -------------------------------------------
  var colorScale = [
    "#3a4f9a", "#2e6fb7", "#1f9ed1", "#39c2c9", "#7fe0c0",
    "#bdeeb0", "#f2f1a0", "#f7d774", "#fff4cf", "#ffffff"
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
      // Show the data date only when it's recent (the high-res Gulf archive is
      // historical, so we don't want to imply it's today's forecast).
      var h = data[0].header || {};
      var when = h.refTime ? new Date(h.refTime) : null;
      var fresh = when && !isNaN(when) &&
        (Date.now() - when.getTime()) < 400 * 864e5;
      var date = fresh ?
        when.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
      setCredit("Surface currents: HYCOM / NOAA" + (date ? " · " + date : ""));
    })
    .catch(useProcedural);
})();
