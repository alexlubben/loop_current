/*
 * build-coastline.js — fetches Natural Earth 10m land + lakes, clips them to the
 * map's extent, and writes a compact data/coastline.json used by render-svg.js to
 * draw a VECTOR basemap layer (editable coastlines for a print graphics editor).
 *
 * The clip window matches the map's maxBounds in js/app.js (lon -100..-54,
 * lat 4..45), so it covers the Gulf, the Caribbean and the NW Atlantic and stays
 * valid even if the current-data domain is widened later.
 *
 * Usage: node tools/build-coastline.js
 * Network is needed once to fetch Natural Earth (same as tools/fetch-currents.js).
 */
var fs = require("fs");
var path = require("path");

// Clip window [west, south, east, north] — matches js/app.js maxBounds.
var BBOX = [-100, 4, -54, 45];
var OUT = path.join(__dirname, "..", "data", "coastline.json");

var SOURCES = {
  land: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson",
  lakes: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson"
};

// Sutherland–Hodgman clip of a ring against one axis-aligned edge.
function clipEdge(ring, inside, intersect) {
  var out = [];
  for (var i = 0; i < ring.length; i++) {
    var cur = ring[i], prev = ring[(i + ring.length - 1) % ring.length];
    var curIn = inside(cur), prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

// Clip a ring [[lon,lat],...] to the rectangle [w,s,e,n]. Returns [] if nothing left.
function clipRing(ring, b) {
  var w = b[0], s = b[1], e = b[2], n = b[3];
  var r = ring;
  r = clipEdge(r, function (p) { return p[0] >= w; }, function (a, c) { var t = (w - a[0]) / (c[0] - a[0]); return [w, a[1] + t * (c[1] - a[1])]; });
  if (!r.length) return r;
  r = clipEdge(r, function (p) { return p[0] <= e; }, function (a, c) { var t = (e - a[0]) / (c[0] - a[0]); return [e, a[1] + t * (c[1] - a[1])]; });
  if (!r.length) return r;
  r = clipEdge(r, function (p) { return p[1] >= s; }, function (a, c) { var t = (s - a[1]) / (c[1] - a[1]); return [a[0] + t * (c[0] - a[0]), s]; });
  if (!r.length) return r;
  r = clipEdge(r, function (p) { return p[1] <= n; }, function (a, c) { var t = (n - a[1]) / (c[1] - a[1]); return [a[0] + t * (c[0] - a[0]), n]; });
  return r;
}

function round(p) { return [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4]; }

// Flatten a feature's geometry to a list of polygons (each = [outerRing, ...holes]).
function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  return [];
}

function clipFeatures(fc, b) {
  var polys = [];
  (fc.features || []).forEach(function (f) {
    polygonsOf(f.geometry).forEach(function (rings) {
      var outer = clipRing(rings[0], b);
      if (outer.length < 3) return;
      var clipped = [outer.map(round)];
      for (var h = 1; h < rings.length; h++) {
        var hole = clipRing(rings[h], b);
        if (hole.length >= 3) clipped.push(hole.map(round));
      }
      polys.push(clipped);
    });
  });
  return polys;
}

async function load(url) {
  // Allow an offline cache: COASTLINE_CACHE_DIR/<key>.geojson
  var res = await fetch(url);
  if (!res.ok) throw new Error("fetch " + url + " -> HTTP " + res.status);
  return res.json();
}

(async function () {
  process.stderr.write("build-coastline: fetching Natural Earth 10m…\n");
  var landFC = await load(SOURCES.land);
  var lakesFC = await load(SOURCES.lakes);

  var land = clipFeatures(landFC, BBOX);
  var lakes = clipFeatures(lakesFC, BBOX);

  var out = { bbox: BBOX, source: "Natural Earth 10m (land, lakes)", land: land, lakes: lakes };
  fs.writeFileSync(OUT, JSON.stringify(out));
  process.stderr.write("build-coastline: wrote " + path.relative(process.cwd(), OUT) +
    " (" + land.length + " land polys, " + lakes.length + " lakes, " +
    (fs.statSync(OUT).size / 1024).toFixed(0) + " KB)\n");
})().catch(function (e) { process.stderr.write("build-coastline: " + e.message + "\n"); process.exit(1); });
