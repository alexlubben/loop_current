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

var rng = (function () { var s = 12345; return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
var N = 3200, STEPS = 110, DT = 0.12;
var lonMin = H.lo1, lonMax = H.lo1 + (H.nx - 1) * H.dx;
var latMax = H.la1, latMin = H.la1 - (H.ny - 1) * H.dy;
var lines = [];
for (var n = 0; n < N; n++) {
  var lon = lonMin + rng() * (lonMax - lonMin);
  var lat = latMin + rng() * (latMax - latMin);
  var pts = [], spds = [];
  for (var s = 0; s < STEPS; s++) {
    var vel = sample(lon, lat);
    if (!vel) break;
    var spd = Math.hypot(vel[0], vel[1]);
    if (spd < 0.02) break;
    var p = px(lon, lat);
    pts.push(p); spds.push(spd);
    lon += vel[0] * DT / Math.cos(lat * Math.PI / 180);
    lat += vel[1] * DT;
  }
  if (pts.length > 6) {
    var avg = spds.reduce(function (a, b) { return a + b; }, 0) / spds.length;
    lines.push({ pts: pts, c: color(avg), w: 0.5 + avg * 1.4 });
  }
}

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
