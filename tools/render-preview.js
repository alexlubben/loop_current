/*
 * render-preview.js — draws a static streamline snapshot of the current field
 * to an SVG. This is a verification artifact / poster image: it shows the same
 * flow the browser animates, integrated into streaklines colored by speed.
 *
 * Uses real HYCOM data (data/gulf-currents.json) if present, otherwise the
 * procedural field. Usage: node tools/render-preview.js > preview.svg
 */
var fs = require("fs");
var path = require("path");

var data, src;
var dataFile = path.join(__dirname, "..", "data", "gulf-currents.json");
if (fs.existsSync(dataFile)) {
  data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  src = "real HYCOM data";
} else {
  global.window = global;
  require("../js/current-field.js");
  data = GulfCurrentField.build();
  src = "procedural field";
}
var H = data[0].header;
var U = data[0].data, V = data[1].data;
process.stderr.write("render-preview: using " + src + " (" + H.nx + "x" + H.ny + ")\n");

// bilinear sampler in lon/lat -> [u, v]; returns null over land/missing data
function sample(lon, lat) {
  var fi = (lon - H.lo1) / H.dx;
  var fj = (H.la1 - lat) / H.dy;
  var i = Math.floor(fi), j = Math.floor(fj);
  if (i < 0 || j < 0 || i >= H.nx - 1 || j >= H.ny - 1) return null;
  var tx = fi - i, ty = fj - j;
  function at(ii, jj, arr) { return arr[jj * H.nx + ii]; }
  function bilin(arr) {
    var a = at(i, j, arr), b = at(i + 1, j, arr),
        c = at(i, j + 1, arr), d = at(i + 1, j + 1, arr);
    if (a == null || b == null || c == null || d == null) return null;
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) +
           c * (1 - tx) * ty + d * tx * ty;
  }
  var u = bilin(U), v = bilin(V);
  if (u == null || v == null) return null;
  return [u, v];
}

// view box
var W = 1200, Hpx = Math.round(W * (H.la1 - (H.la1 - (H.ny - 1) * H.dy)) /
                                    ((H.nx - 1) * H.dx));
var lonMin = H.lo1, lonMax = H.lo1 + (H.nx - 1) * H.dx;
var latMax = H.la1, latMin = H.la1 - (H.ny - 1) * H.dy;
function px(lon, lat) {
  return [
    (lon - lonMin) / (lonMax - lonMin) * W,
    (latMax - lat) / (latMax - latMin) * Hpx
  ];
}

var scale = [
  "#3a4f9a", "#2e6fb7", "#1f9ed1", "#39c2c9", "#7fe0c0",
  "#bdeeb0", "#f2f1a0", "#f7d774", "#fff4cf", "#ffffff"
];
function color(speed) {
  var t = Math.max(0, Math.min(1, speed / 1.8));
  return scale[Math.round(t * (scale.length - 1))];
}

// integrate streaklines
var lines = [];
var rng = (function () { var s = 12345; return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
var N = 2600, STEPS = 90, DT = 0.12;
for (var n = 0; n < N; n++) {
  var lon = lonMin + rng() * (lonMax - lonMin);
  var lat = latMin + rng() * (latMax - latMin);
  var pts = [], spds = [];
  for (var s = 0; s < STEPS; s++) {
    var v = sample(lon, lat);
    if (!v) break;
    var spd = Math.hypot(v[0], v[1]);
    if (spd < 0.02) break;
    var p = px(lon, lat);
    pts.push(p); spds.push(spd);
    lon += v[0] * DT / Math.cos(lat * Math.PI / 180);
    lat += v[1] * DT;
  }
  if (pts.length > 6) {
    var avg = spds.reduce(function (a, b) { return a + b; }, 0) / spds.length;
    lines.push({ pts: pts, c: color(avg), w: 0.5 + avg * 1.0 });
  }
}

var out = [];
out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + Hpx +
         '" viewBox="0 0 ' + W + ' ' + Hpx + '">');
out.push('<rect width="100%" height="100%" fill="#0a1726"/>');
lines.forEach(function (L) {
  var d = "M" + L.pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" L");
  out.push('<path d="' + d + '" fill="none" stroke="' + L.c + '" stroke-width="' +
           L.w.toFixed(2) + '" stroke-opacity="0.85" stroke-linecap="round"/>');
});
out.push('<text x="20" y="34" fill="#eaf4ff" font-family="Helvetica,Arial" font-size="22" font-weight="700">The Loop Current — Gulf of Mexico</text>');
out.push('<text x="20" y="56" fill="#9db8d2" font-family="Helvetica,Arial" font-size="13">Stylized illustration of flow (static snapshot of the animated field)</text>');
out.push('</svg>');
process.stdout.write(out.join("\n"));
