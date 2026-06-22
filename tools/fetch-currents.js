/*
 * fetch-currents.js
 * -----------------
 * Pulls REAL HYCOM surface ocean-current data for the Gulf of Mexico from
 * NOAA ERDDAP servers and writes it as a leaflet-velocity u/v grid JSON
 * (data/gulf-currents.json) — the same data + format the GCOOS map uses.
 *
 * This must run somewhere with open internet (e.g. a GitHub Actions runner).
 * It self-introspects each dataset (dimensions, axis order, longitude
 * convention, depth) so it doesn't depend on hard-coded grid assumptions, and
 * it falls through a prioritized list of datasets until one succeeds.
 *
 * Usage:  node tools/fetch-currents.js [outfile]
 * Node 18+ (uses global fetch).
 */
"use strict";

const fs = require("fs");
const path = require("path");

// Gulf of Mexico + a slice of the Atlantic so the Gulf Stream has an exit.
const BBOX = { west: -98.5, east: -76.0, south: 17.5, north: 31.0 };
const STRIDE = 1; // 1 = native res; 2 = half (lighter file)

// Prioritized data sources. Each is tried in order until one yields data.
const DATASETS = [
  {
    name: "NCEI Global HYCOM surface (2D, near-real-time)",
    base: "https://www.ncei.noaa.gov/erddap",
    id: "Hycom_sfc_2d",
    uVar: "water_u", vVar: "water_v"
  },
  {
    name: "NCEI Global HYCOM surface (3D agg, surface level)",
    base: "https://www.ncei.noaa.gov/erddap",
    id: "Hycom_sfc_3d",
    uVar: "water_u", vVar: "water_v"
  },
  {
    name: "CoastWatch HYCOM Gulf of Mexico 1/25deg (archive)",
    base: "https://coastwatch.pfeg.noaa.gov/erddap",
    id: "hycom_gom310D",
    uVar: "water_u", vVar: "water_v"
  }
];

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "loop-current-fetch/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Read /info/<id>/index.json -> { dims:{name->{...}}, vars:Set, hasDepth }
async function introspect(ds) {
  const info = await getJSON(`${ds.base}/info/${ds.id}/index.json`);
  const rows = info.table.rows;
  const cols = info.table.columnNames;
  const RT = cols.indexOf("Row Type");
  const VN = cols.indexOf("Variable Name");
  const dims = [];
  const vars = new Set();
  for (const r of rows) {
    if (r[RT] === "dimension") dims.push(r[VN]);
    else if (r[RT] === "variable") vars.add(r[VN]);
  }
  return { dims, vars, hasDepth: dims.includes("depth") };
}

// Fetch a 1-D coordinate axis as a plain number array.
async function getAxis(ds, name) {
  const j = await getJSON(`${ds.base}/griddap/${ds.id}.json?${name}`);
  return j.table.rows.map((row) => row[0]);
}

// Find the inclusive index range [lo,hi] of axis values within [min,max].
function indexRange(axis, min, max) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < axis.length; i++) {
    if (axis[i] >= min && axis[i] <= max) { if (i < lo) lo = i; if (i > hi) hi = i; }
  }
  if (!isFinite(lo)) return null;
  return [lo, hi];
}

function toSigned(lon) { return lon > 180 ? lon - 360 : lon; }

async function tryDataset(ds) {
  console.log(`\n== Trying: ${ds.name}  [${ds.id}] ==`);
  const meta = await introspect(ds);
  console.log(`   dims: ${meta.dims.join(", ")} | hasDepth: ${meta.hasDepth}`);
  if (!meta.vars.has(ds.uVar) || !meta.vars.has(ds.vVar)) {
    throw new Error(`variables ${ds.uVar}/${ds.vVar} not present`);
  }

  const lat = await getAxis(ds, "latitude");
  const lon = await getAxis(ds, "longitude");
  const lonIs360 = Math.max(...lon) > 180;
  console.log(`   latitude ${lat[0]}..${lat[lat.length - 1]} (${lat.length})` +
              ` | longitude ${lon[0]}..${lon[lon.length - 1]} (${lon.length})` +
              ` | 0-360: ${lonIs360}`);

  const west = lonIs360 ? BBOX.west + 360 : BBOX.west;
  const east = lonIs360 ? BBOX.east + 360 : BBOX.east;

  const latIdx = indexRange(lat, BBOX.south, BBOX.north);
  const lonIdx = indexRange(lon, west, east);
  if (!latIdx || !lonIdx) throw new Error("bbox not covered by this dataset");

  const depthSel = meta.hasDepth ? "[0]" : ""; // index 0 = surface
  const sub = (v) =>
    `${v}[last]${depthSel}[${latIdx[0]}:${STRIDE}:${latIdx[1]}][${lonIdx[0]}:${STRIDE}:${lonIdx[1]}]`;
  const url = `${ds.base}/griddap/${ds.id}.json?${sub(ds.uVar)},${sub(ds.vVar)}`;
  console.log(`   query: ${url}`);

  const data = await getJSON(url);
  return buildGrid(ds, data);
}

function buildGrid(ds, resp) {
  const cols = resp.table.columnNames;
  const rows = resp.table.rows;
  const ti = cols.indexOf("time");
  const yi = cols.indexOf("latitude");
  const xi = cols.indexOf("longitude");
  const ui = cols.indexOf(ds.uVar);
  const vi = cols.indexOf(ds.vVar);

  // Unique, sorted axes: latitude N->S (descending), longitude W->E (ascending).
  const lats = [...new Set(rows.map((r) => r[yi]))].sort((a, b) => b - a);
  const lonsRaw = [...new Set(rows.map((r) => r[xi]))];
  const lons = lonsRaw.map(toSigned).sort((a, b) => a - b);
  const ny = lats.length, nx = lons.length;
  const latPos = new Map(lats.map((v, i) => [v, i]));
  const lonPos = new Map(lons.map((v, i) => [v, i]));

  const U = new Array(nx * ny).fill(null);
  const V = new Array(nx * ny).fill(null);
  let filled = 0;
  for (const r of rows) {
    const j = latPos.get(r[yi]);
    const i = lonPos.get(toSigned(r[xi]));
    if (j == null || i == null) continue;
    const p = j * nx + i;
    const u = r[ui], v = r[vi];
    if (u != null && v != null && isFinite(u) && isFinite(v)) {
      U[p] = u; V[p] = v; filled++;
    }
  }

  const dx = nx > 1 ? (lons[nx - 1] - lons[0]) / (nx - 1) : 0.08;
  const dy = ny > 1 ? (lats[0] - lats[ny - 1]) / (ny - 1) : 0.08;
  const refTime = rows.length ? rows[0][ti] : new Date().toISOString();

  console.log(`   grid ${nx} x ${ny} = ${nx * ny} pts, ${filled} ocean points` +
              ` (${((100 * filled) / (nx * ny)).toFixed(0)}%), time ${refTime}`);

  if (filled < 0.05 * nx * ny) throw new Error("almost no ocean data returned");

  const header = (parameterNumber) => ({
    parameterCategory: 2,
    parameterNumber, // 2 = eastward U, 3 = northward V
    lo1: lons[0],
    la1: lats[0],
    dx, dy, nx, ny,
    refTime,
    forecastTime: 0,
    source: `${ds.name} via ${ds.base}`
  });

  return [
    { header: header(2), data: U },
    { header: header(3), data: V }
  ];
}

(async function main() {
  const outfile = process.argv[2] ||
    path.join(__dirname, "..", "data", "gulf-currents.json");

  let result = null, lastErr = null;
  for (const ds of DATASETS) {
    try {
      result = await tryDataset(ds);
      break;
    } catch (e) {
      lastErr = e;
      console.log(`   FAILED: ${e.message}`);
    }
  }

  if (!result) {
    console.error(`\nAll datasets failed. Last error: ${lastErr && lastErr.message}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.writeFileSync(outfile, JSON.stringify(result));
  const kb = (fs.statSync(outfile).size / 1024).toFixed(0);
  console.log(`\nWrote ${outfile} (${kb} KB) — header:`, result[0].header.source);
})();
