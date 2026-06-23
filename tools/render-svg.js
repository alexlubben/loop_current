/*
 * render-svg.js — exports a STATIC, LAYERED SVG of the Loop Current map for a
 * print graphics editor (Illustrator / Inkscape).
 *
 * The output has three named layers (SVG <g> groups tagged so both Illustrator
 * "Release to Layers" and Inkscape read them as layers):
 *   • "Basemap"       — vector coastlines (Natural Earth 10m), editable line art
 *   • "Current lines" — surface-current streamlines as vector paths, by speed
 *   • "Labels"        — title + credit (delete or restyle freely)
 *
 * Currents come from the real HYCOM/NOAA snapshot in data/gulf-currents.json.
 * The basemap comes from data/coastline.json (run tools/build-coastline.js once).
 * Both layers share one equirectangular projection so they register exactly.
 *
 * Usage: node tools/render-svg.js > loop-current.svg
 */
var fs = require("fs");
var path = require("path");

function read(rel) { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", rel), "utf8")); }

var dataFile = path.join(__dirname, "..", "data", "gulf-currents.json");
if (!fs.existsSync(dataFile)) {
  process.stderr.write("render-svg: data/gulf-currents.json not found. Run tools/fetch-currents.js first.\n");
  process.exit(1);
}
var coastFile = path.join(__dirname, "..", "data", "coastline.json");
if (!fs.existsSync(coastFile)) {
  process.stderr.write("render-svg: data/coastline.json not found. Run tools/build-coastline.js first.\n");
  process.exit(1);
}

var data = read("data/gulf-currents.json");
var coast = read("data/coastline.json");
var H = data[0].header, U = data[0].data, V = data[1].data;

// ----- View / projection ---------------------------------------------------
// Frame the current-data domain with a small margin, then use an equirectangular
// projection with its standard parallel at the view's mid-latitude (so land
// shapes aren't horizontally stretched). Both layers go through px().
var MARGIN = 0.4; // degrees
var lon0 = H.lo1 - MARGIN, lon1 = H.lo1 + (H.nx - 1) * H.dx + MARGIN;
var lat1 = H.la1 + MARGIN, lat0 = H.la1 - (H.ny - 1) * H.dy - MARGIN;
var midLat = (lat0 + lat1) / 2;
var kx = Math.cos(midLat * Math.PI / 180);
var W = 1600;
var Hpx = Math.round(W * (lat1 - lat0) / ((lon1 - lon0) * kx));
function px(lon, lat) {
  return [
    (lon - lon0) / (lon1 - lon0) * W,
    (lat1 - lat) / (lat1 - lat0) * Hpx
  ];
}

// ----- Basemap layer (vector coastlines) -----------------------------------
// Clip polygons to the framed view so the print file carries no off-canvas
// geometry. Sutherland–Hodgman against the rectangle [lon0,lat0,lon1,lat1].
function clipEdge(ring, inside, isect) {
  var out = [];
  for (var i = 0; i < ring.length; i++) {
    var cur = ring[i], prev = ring[(i + ring.length - 1) % ring.length];
    var ci = inside(cur), pi = inside(prev);
    if (ci) { if (!pi) out.push(isect(prev, cur)); out.push(cur); }
    else if (pi) out.push(isect(prev, cur));
  }
  return out;
}
function clipRing(ring) {
  var r = ring;
  r = clipEdge(r, function (p) { return p[0] >= lon0; }, function (a, c) { var t = (lon0 - a[0]) / (c[0] - a[0]); return [lon0, a[1] + t * (c[1] - a[1])]; });
  if (!r.length) return r;
  r = clipEdge(r, function (p) { return p[0] <= lon1; }, function (a, c) { var t = (lon1 - a[0]) / (c[0] - a[0]); return [lon1, a[1] + t * (c[1] - a[1])]; });
  if (!r.length) return r;
  r = clipEdge(r, function (p) { return p[1] >= lat0; }, function (a, c) { var t = (lat0 - a[1]) / (c[1] - a[1]); return [a[0] + t * (c[0] - a[0]), lat0]; });
  if (!r.length) return r;
  return clipEdge(r, function (p) { return p[1] <= lat1; }, function (a, c) { var t = (lat1 - a[1]) / (c[1] - a[1]); return [a[0] + t * (c[0] - a[0]), lat1]; });
}
function clipPolys(polys) {
  var out = [];
  polys.forEach(function (rings) {
    var outer = clipRing(rings[0]);
    if (outer.length < 3) return;
    var kept = [outer];
    for (var h = 1; h < rings.length; h++) { var hole = clipRing(rings[h]); if (hole.length >= 3) kept.push(hole); }
    out.push(kept);
  });
  return out;
}

function ringPath(ring) {
  var d = "M";
  for (var i = 0; i < ring.length; i++) {
    var p = px(ring[i][0], ring[i][1]);
    d += (i ? "L" : "") + p[0].toFixed(1) + "," + p[1].toFixed(1);
  }
  return d + "Z";
}
function polysPath(polys) {
  // even-odd fill renders outer rings + holes correctly
  return polys.map(function (rings) { return rings.map(ringPath).join(""); }).join("");
}

var WATER = "#d7eaf3", LAND = "#f3efe6", COAST = "#9bb7c4";
var landPolys = clipPolys(coast.land);
var lakePolys = clipPolys(coast.lakes || []);

// ----- Current lines layer (streamlines) -----------------------------------
// Same integration as tools/render-preview.js, projected through px().
function sample(lon, lat) {
  var fi = (lon - H.lo1) / H.dx, fj = (H.la1 - lat) / H.dy;
  var i = Math.floor(fi), j = Math.floor(fj);
  if (i < 0 || j < 0 || i >= H.nx - 1 || j >= H.ny - 1) return null;
  var tx = fi - i, ty = fj - j;
  function bilin(arr) {
    var a = arr[j * H.nx + i], b = arr[j * H.nx + i + 1],
        c = arr[(j + 1) * H.nx + i], d = arr[(j + 1) * H.nx + i + 1];
    if (a == null || b == null || c == null || d == null) return null;
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }
  var u = bilin(U), v = bilin(V);
  if (u == null || v == null) return null;
  return [u, v];
}

// On-screen ramp from js/app.js, mapped over speed 0..maxVelocity.
var scale = ["#1d4e89", "#1f7fb0", "#1aa0a0", "#3fb56b", "#9ccb3b",
             "#e8d52f", "#f5a623", "#f2682c", "#e03131", "#9e1b1b"];
var MAXV = 1.4;
function color(speed) {
  var t = Math.max(0, Math.min(1, speed / MAXV));
  return scale[Math.round(t * (scale.length - 1))];
}

// Evenly-spaced streamlines (occupancy-grid placement) — the cartographic way to
// keep a flow map legible: regularly spaced lines that never bunch up or cross,
// with the weak background flow dropped so only the real currents read. Tunables:
var D_SEP = 24;       // target spacing between streamlines (px)
var D_TEST = 12;      // stop a line when it comes this close to another (px)
var STEP = 3;         // integration step length (px)
var MAX_STEPS = 600;  // max steps per direction
var MIN_LEN = 40;     // drop streamlines shorter than this (px)
var SPEED_MIN = 0.10; // ignore flow slower than this — hides the cluttered drift

var sx = W / (lon1 - lon0);     // px per degree lon
var sy = Hpx / (lat1 - lat0);   // px per degree lat

// One integration step of fixed pixel length along the flow; null if too slow /
// off-grid. Returns lon/lat increments and the local speed.
function flowStep(lon, lat, dir) {
  var vel = sample(lon, lat);
  if (!vel) return null;
  var spd = Math.hypot(vel[0], vel[1]);
  if (spd < SPEED_MIN) return null;
  var vx = sx * vel[0] / Math.cos(lat * Math.PI / 180); // velocity in pixel space
  var vy = -sy * vel[1];
  var m = Math.hypot(vx, vy);
  if (m < 1e-6) return null;
  var k = (STEP * dir) / m;            // scale to STEP pixels in flow direction
  return { dlon: (vx * k) / sx, dlat: -(vy * k) / sy, spd: spd };
}

// Occupancy grid for spacing checks (cell size = D_SEP).
var gw = Math.ceil(W / D_SEP) + 1, gh = Math.ceil(Hpx / D_SEP) + 1;
var grid = new Array(gw * gh);
function addPoint(x, y) {
  var idx = Math.floor(y / D_SEP) * gw + Math.floor(x / D_SEP);
  (grid[idx] || (grid[idx] = [])).push([x, y]);
}
function nearOccupied(x, y, minDist) {
  var ci = Math.floor(x / D_SEP), cj = Math.floor(y / D_SEP), md2 = minDist * minDist;
  for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) {
    var gi = ci + a, gj = cj + b;
    if (gi < 0 || gj < 0 || gi >= gw || gj >= gh) continue;
    var cell = grid[gj * gw + gi];
    if (!cell) continue;
    for (var p = 0; p < cell.length; p++) {
      var dx = cell[p][0] - x, dy = cell[p][1] - y;
      if (dx * dx + dy * dy < md2) return true;
    }
  }
  return false;
}

// Grow a streamline through a seed, forward and backward, stopping at other lines.
function grow(seed) {
  function trace(dir) {
    var lon = seed.lon, lat = seed.lat, out = [], spds = [];
    for (var s = 0; s < MAX_STEPS; s++) {
      var st = flowStep(lon, lat, dir);
      if (!st) break;
      lon += st.dlon; lat += st.dlat;
      var p = px(lon, lat);
      if (p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > Hpx) break;
      if (nearOccupied(p[0], p[1], D_TEST)) break;
      out.push(p); spds.push(st.spd);
    }
    return { out: out, spds: spds };
  }
  var f = trace(1), b = trace(-1);
  var sp = px(seed.lon, seed.lat);
  return {
    pts: b.out.slice().reverse().concat([sp], f.out),
    spds: b.spds.slice().reverse().concat([seed.spd], f.spds)
  };
}

// Candidate seeds on a D_SEP grid, strongest flow first so the Loop Current jet
// gets placed as one clean, continuous line before weaker flow fills in around it.
var seeds = [];
for (var gy = D_SEP / 2; gy < Hpx; gy += D_SEP) {
  for (var gx = D_SEP / 2; gx < W; gx += D_SEP) {
    var slon = lon0 + (gx / W) * (lon1 - lon0);
    var slat = lat1 - (gy / Hpx) * (lat1 - lat0);
    var vel = sample(slon, slat);
    if (!vel) continue;
    var spd = Math.hypot(vel[0], vel[1]);
    if (spd < SPEED_MIN) continue;
    seeds.push({ lon: slon, lat: slat, spd: spd, x: gx, y: gy });
  }
}
seeds.sort(function (a, b) { return b.spd - a.spd; });

var lines = [];
seeds.forEach(function (seed) {
  if (nearOccupied(seed.x, seed.y, D_SEP)) return;     // too close to an existing line
  var line = grow(seed);
  var len = 0;
  for (var i = 1; i < line.pts.length; i++) {
    var dx = line.pts[i][0] - line.pts[i - 1][0], dy = line.pts[i][1] - line.pts[i - 1][1];
    len += Math.hypot(dx, dy);
  }
  if (len < MIN_LEN) return;
  line.pts.forEach(function (p) { addPoint(p[0], p[1]); });
  var avg = line.spds.reduce(function (a, b) { return a + b; }, 0) / line.spds.length;
  lines.push({ pts: line.pts, c: color(avg), w: 1.0 + 1.8 * Math.min(1, avg / MAXV) });
});

// ----- Emit SVG ------------------------------------------------------------
var date = H.refTime ? new Date(H.refTime).toISOString().slice(0, 10) : "";
var o = [];
o.push('<?xml version="1.0" encoding="UTF-8"?>');
o.push('<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ' +
       'width="' + W + '" height="' + Hpx + '" viewBox="0 0 ' + W + ' ' + Hpx + '">');

// Basemap layer
o.push('<g inkscape:groupmode="layer" inkscape:label="Basemap" id="basemap">');
o.push('<rect id="water" width="' + W + '" height="' + Hpx + '" fill="' + WATER + '"/>');
o.push('<path id="land" d="' + polysPath(landPolys) + '" fill="' + LAND + '" fill-rule="evenodd" stroke="' + COAST + '" stroke-width="0.6"/>');
if (lakePolys.length)
  o.push('<path id="lakes" d="' + polysPath(lakePolys) + '" fill="' + WATER + '" fill-rule="evenodd" stroke="' + COAST + '" stroke-width="0.4"/>');
o.push('</g>');

// Current lines layer
o.push('<g inkscape:groupmode="layer" inkscape:label="Current lines" id="currents" fill="none" stroke-linecap="round" stroke-opacity="0.9">');
lines.forEach(function (L) {
  var d = "M" + L.pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join("L");
  o.push('<path d="' + d + '" stroke="' + L.c + '" stroke-width="' + L.w.toFixed(2) + '"/>');
});
o.push('</g>');

// Labels layer
o.push('<g inkscape:groupmode="layer" inkscape:label="Labels" id="labels">');
o.push('<text x="24" y="40" fill="#1b2a3a" font-family="Helvetica,Arial,sans-serif" font-size="26" font-weight="700">The Loop Current — Gulf of Mexico</text>');
o.push('<text x="24" y="62" fill="#5a6b7b" font-family="Helvetica,Arial,sans-serif" font-size="14">Surface currents: HYCOM / NOAA' +
       (date ? " · " + date : "") + ' · Coastlines: Natural Earth</text>');
o.push('</g>');

o.push('</svg>');
process.stdout.write(o.join("\n"));
process.stderr.write("render-svg: " + lines.length + " streamlines, " + coast.land.length +
  " land polys → " + W + "x" + Hpx + " SVG\n");
