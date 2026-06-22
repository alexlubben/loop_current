/*
 * current-field.js
 * -----------------
 * Builds a synthetic ocean-current velocity field for the Gulf of Mexico and
 * returns it in the JSON grid format consumed by leaflet-velocity (the same
 * u/v grid format used by earth.nullschool / windy-style particle layers).
 *
 * The field is ILLUSTRATIVE, not real data. It is hand-composed from two
 * ingredients so that it tells the Loop Current story convincingly:
 *
 *   1. A "jet" that follows a centerline polyline. The polyline traces water
 *      coming up through the Yucatan Channel, looping clockwise into the
 *      eastern Gulf, curving back down to the Florida Straits, and then heading
 *      north as the Gulf Stream.
 *
 *   2. A train of rotating "eddies" (vortices) in the central/western Gulf,
 *      representing the warm-core anticyclonic rings the Loop Current
 *      periodically pinches off and sends west.
 *
 * Velocities are expressed in m/s so they map naturally onto a current speed
 * color scale (the Loop Current core runs ~1.5-1.8 m/s in reality).
 */

(function (global) {
  "use strict";

  // ----- Domain (bounding box of the generated grid) -----------------------
  // West/East longitude and South/North latitude. Covers the whole Gulf plus a
  // slice of the Atlantic so the Gulf Stream has somewhere to flow.
  var DOMAIN = {
    west: -98.5,
    east: -76.0,
    south: 17.5,
    north: 31.0,
    step: 0.1 // grid resolution in degrees (smaller = smoother but heavier)
  };

  // ----- Loop Current + Gulf Stream centerline -----------------------------
  // Ordered downstream: each point is [lon, lat, speed(m/s)]. Particles flow
  // from the first point toward the last. Speed lets the core run fast (bright)
  // and lets the flow ease in/out at the domain edges.
  var CENTERLINE = [
    [-85.9, 17.8, 0.7],  // entering the Yucatan Channel from the Caribbean
    [-85.7, 19.6, 1.3],
    [-85.5, 21.4, 1.7],  // racing north through the channel
    [-85.6, 23.2, 1.7],
    [-86.2, 24.9, 1.6],
    [-87.0, 26.2, 1.5],
    [-87.6, 27.0, 1.4],  // northern apex of the loop intrusion
    [-86.8, 27.4, 1.4],
    [-85.6, 27.2, 1.5],
    [-84.6, 26.5, 1.6],  // curving clockwise back to the south-east
    [-83.8, 25.5, 1.6],
    [-83.0, 24.5, 1.6],
    [-82.1, 23.9, 1.7],  // squeezing south of Florida toward the straits
    [-81.0, 24.1, 1.8],
    [-80.2, 24.9, 1.8],  // through the Straits of Florida
    [-79.8, 26.2, 1.7],
    [-79.6, 27.8, 1.6],  // turning north as the Gulf Stream
    [-79.2, 29.4, 1.5],
    [-78.4, 30.9, 1.3]   // exiting the domain up the Atlantic seaboard
  ];

  // Cross-stream half-width of the jet, in degrees. Larger = broader river.
  var JET_WIDTH = 0.85;

  // ----- Eddies (vortices) -------------------------------------------------
  // center lon/lat, radius (deg), and spin. Positive spin = clockwise
  // (anticyclonic, the warm-core rings the Loop Current sheds). Negative spin =
  // counter-clockwise (cyclonic). strength is peak speed in m/s.
  var EDDIES = [
    { lon: -89.6, lat: 25.4, radius: 1.7, spin: 1, strength: 1.05 }, // freshly shed, central Gulf
    { lon: -92.6, lat: 24.7, radius: 1.6, spin: 1, strength: 0.9 },  // older ring, marching west
    { lon: -95.4, lat: 24.0, radius: 1.4, spin: 1, strength: 0.75 }, // oldest ring, near Mexican shelf
    { lon: -91.6, lat: 26.6, radius: 0.9, spin: -1, strength: 0.5 }, // small cyclonic eddy between rings
    { lon: -94.4, lat: 21.8, radius: 1.1, spin: -1, strength: 0.45 } // Campeche cyclonic gyre (SW Gulf)
  ];

  // Gentle ambient drift so the slow interior never looks frozen (m/s).
  var BACKGROUND = { u: -0.03, v: 0.01 };

  // -------------------------------------------------------------------------
  // Math helpers
  // -------------------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Velocity contribution of the path-following jet at (lon, lat).
  // xs scales longitude into "distance-like" units so bends look natural.
  function jetVelocity(lon, lat, xs) {
    var bestW = 0, bu = 0, bv = 0;
    for (var i = 0; i < CENTERLINE.length - 1; i++) {
      var a = CENTERLINE[i], b = CENTERLINE[i + 1];
      var ax = a[0] * xs, ay = a[1], bx = b[0] * xs, by = b[1];
      var px = lon * xs, py = lat;
      var dx = bx - ax, dy = by - ay;
      var segLen2 = dx * dx + dy * dy || 1e-9;
      // projection parameter of P onto segment AB, clamped to the segment
      var t = clamp(((px - ax) * dx + (py - ay) * dy) / segLen2, 0, 1);
      var qx = ax + t * dx, qy = ay + t * dy;        // nearest point on segment
      var ddx = px - qx, ddy = py - qy;
      var dist = Math.sqrt(ddx * ddx + ddy * ddy);   // cross-stream distance
      var w = Math.exp(-(dist * dist) / (JET_WIDTH * JET_WIDTH)); // Gaussian profile
      if (w > bestW) {
        bestW = w;
        var len = Math.sqrt(segLen2);
        var tx = dx / len, ty = dy / len;            // downstream unit tangent
        var speed = a[2] + (b[2] - a[2]) * t;        // interpolate core speed
        // convert tangent back from scaled-x space into true u (east) component
        bu = (tx / xs) * speed;
        bv = ty * speed;
      }
    }
    return [bu * bestW, bv * bestW];
  }

  // Velocity contribution of all eddies at (lon, lat).
  function eddyVelocity(lon, lat, xs) {
    var u = 0, v = 0;
    for (var k = 0; k < EDDIES.length; k++) {
      var e = EDDIES[k];
      var rx = (lon - e.lon) * xs;   // east offset (scaled)
      var ry = lat - e.lat;          // north offset
      var r2 = rx * rx + ry * ry;
      var env = Math.exp(-r2 / (e.radius * e.radius)); // localized envelope
      // Clockwise (spin>0): tangent (ry, -rx). Scale so it grows from 0 at the
      // center (solid-body core) and decays outside -> no central singularity.
      var amp = e.strength * env * e.spin / e.radius;
      u += amp * (ry) / xs; // back to true east component
      v += amp * (-rx);
    }
    return [u, v];
  }

  // -------------------------------------------------------------------------
  // Grid builder -> leaflet-velocity data array
  // -------------------------------------------------------------------------
  function build(opts) {
    opts = opts || {};
    var d = {
      west: opts.west != null ? opts.west : DOMAIN.west,
      east: opts.east != null ? opts.east : DOMAIN.east,
      south: opts.south != null ? opts.south : DOMAIN.south,
      north: opts.north != null ? opts.north : DOMAIN.north,
      step: opts.step != null ? opts.step : DOMAIN.step
    };

    var nx = Math.round((d.east - d.west) / d.step) + 1;
    var ny = Math.round((d.north - d.south) / d.step) + 1;
    var midLat = (d.north + d.south) / 2;
    var xs = Math.cos(midLat * Math.PI / 180); // longitude->distance scale

    var uData = new Array(nx * ny);
    var vData = new Array(nx * ny);

    // leaflet-velocity scans rows from north (la1) down to south, west to east.
    var p = 0;
    for (var j = 0; j < ny; j++) {
      var lat = d.north - j * d.step;
      for (var i = 0; i < nx; i++, p++) {
        var lon = d.west + i * d.step;
        var jet = jetVelocity(lon, lat, xs);
        var edd = eddyVelocity(lon, lat, xs);
        uData[p] = jet[0] + edd[0] + BACKGROUND.u;
        vData[p] = jet[1] + edd[1] + BACKGROUND.v;
      }
    }

    function header(parameterNumber) {
      return {
        parameterCategory: 2,      // momentum
        parameterNumber: parameterNumber, // 2 = U (eastward), 3 = V (northward)
        lo1: d.west,
        la1: d.north,              // origin is the NW corner
        dx: d.step,
        dy: d.step,
        nx: nx,
        ny: ny,
        refTime: new Date().toISOString(),
        forecastTime: 0
      };
    }

    return [
      { header: header(2), data: uData },
      { header: header(3), data: vData }
    ];
  }

  global.GulfCurrentField = {
    build: build,
    DOMAIN: DOMAIN,
    CENTERLINE: CENTERLINE,
    EDDIES: EDDIES
  };
})(typeof window !== "undefined" ? window : this);
