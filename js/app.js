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

  var data = window.GulfCurrentField.build();

  var velocityLayer = L.velocityLayer({
    displayValues: false,
    data: data,
    minVelocity: 0.0,
    maxVelocity: 1.8,        // aligns the color scale with our current speeds
    velocityScale: 0.012,    // particle step per frame (lively but not frantic)
    particleAge: 100,        // frames before a streak is reborn
    particleMultiplier: 1 / 260, // streak density
    lineWidth: 1.3,
    frameRate: 24,
    opacity: 0.92,
    colorScale: colorScale
  });

  velocityLayer.addTo(map);
})();
