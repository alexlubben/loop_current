/*
 * fetch-currents.js
 * -----------------
 * Pulls REAL ocean surface-current data for the Gulf of Mexico from NOAA/IOOS
 * ERDDAP servers (HYCOM / RTOFS) and writes it as a leaflet-velocity u/v grid
 * JSON (data/gulf-currents.json) — the same kind of data + format the GCOOS map
 * uses.
 *
 * It is SELF-DISCOVERING and robust:
 *   - searches each ERDDAP server for HYCOM/RTOFS current datasets,
 *   - auto-detects the eastward/northward velocity variables,
 *   - reads each dataset's real dimension order, axis order, depth, and
 *     longitude convention (0-360 vs -180..180),
 *   - subsets to the Gulf using index ranges, and stops at the first dataset
 *     that actually covers the region with ocean data.
 *
 * Must run where there is open internet (e.g. a GitHub Actions runner).
 * Node 18+ (uses global fetch).
 *
 * Usage:  node tools/fetch-currents.js [outfile]
 */
"use strict";

const fs = require("fs");
const path = require("path");

// Gulf of Mexico + a slice of the Atlantic so the Gulf Stream has an exit.
const BBOX = { west: -98.5, east: -76.0, south: 17.5, north: 31.0 };
const STRIDE = 1; // 1 = native resolution

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0 Safari/537.36 loop-current-fetch/1.0";

// ERDDAP servers to search, most-preferred first.
const SERVERS = [
  "https://www.ncei.noaa.gov/erddap",
  "https://coastwatch.pfeg.noaa.gov/erddap",
  "https://pae-paha.pacioos.hawaii.edu/erddap",
  "https://erddap.aoml.noaa.gov/hdb/erddap",
  "https://upwell.pfeg.noaa.gov/erddap"
];
const SEARCH_TERMS = ["hycom", "rtofs"];
const MAX_CANDIDATES_PER_SERVER = 10;

// Candidate eastward/northward velocity variable name pairs, in priority order.
const UV_PAIRS = [
  ["water_u", "water_v"],
  ["u", "v"],
  ["uo", "vo"],
  ["u_velocity", "v_velocity"],
  ["surf_u", "surf_v"],
  ["eastward_sea_water_velocity", "northward_sea_water_velocity"],
  ["ssu", "ssv"]
];

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- ERDDAP search: return griddap dataset IDs matching a term ---------------
async function searchDatasets(base, term) {
  const url = `${base}/search/index.json?searchFor=${encodeURIComponent(term)}` +
              `&page=1&itemsPerPage=50`;
  const j = await getJSON(url);
  const cols = j.table.columnNames;
  const idIdx = cols.indexOf("Dataset ID");
  const gridIdx = cols.indexOf("griddap");
  const ids = [];
  for (const row of j.table.rows) {
    const grid = row[gridIdx];
    if (grid && grid !== "" && idIdx >= 0) ids.push(row[idIdx]);
  }
  return ids;
}

// --- Dataset introspection ---------------------------------------------------
// Returns { dims:[{name,role}], vars:Map(name->units) }
async function introspect(base, id) {
  const info = await getJSON(`${base}/info/${id}/index.json`);
  const cols = info.table.columnNames;
  const RT = cols.indexOf("Row Type");
  const VN = cols.indexOf("Variable Name");
  const AN = cols.indexOf("Attribute Name");
  const VAL = cols.indexOf("Value");

  const dims = [];
  const vars = new Map();
  const units = new Map();
  for (const r of info.table.rows) {
    if (r[RT] === "dimension") dims.push(r[VN]);
    else if (r[RT] === "variable") vars.set(r[VN], true);
    else if (r[RT] === "attribute" && r[AN] === "units") units.set(r[VN], r[VAL]);
  }
  const role = (name) => {
    if (/^lat/i.test(name)) return "lat";
    if (/^lon/i.test(name)) return "lon";
    if (/time/i.test(name)) return "time";
    if (/depth|altitude|^lev|^z$/i.test(name)) return "depth";
    return "other";
  };
  return { dims: dims.map((n) => ({ name: n, role: role(n) })), vars, units };
}

function pickUV(vars) {
  for (const [u, v] of UV_PAIRS) if (vars.has(u) && vars.has(v)) return [u, v];
  return null;
}

async function getAxis(base, id, name) {
  const j = await getJSON(`${base}/griddap/${id}.json?${encodeURIComponent(name)}`);
  return j.table.rows.map((row) => row[0]);
}

function indexRange(axis, min, max) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < axis.length; i++) {
    if (axis[i] >= min && axis[i] <= max) { if (i < lo) lo = i; if (i > hi) hi = i; }
  }
  return isFinite(lo) ? [lo, hi] : null;
}

const toSigned = (lon) => (lon > 180 ? lon - 360 : lon);

async function tryDataset(base, id) {
  const meta = await introspect(base, id);
  const latDim = meta.dims.find((d) => d.role === "lat");
  const lonDim = meta.dims.find((d) => d.role === "lon");
  if (!latDim || !lonDim) throw new Error("no lat/lon dims");

  const uv = pickUV(meta.vars);
  if (!uv) throw new Error("no recognized u/v variables");
  const [uVar, vVar] = uv;

  const lat = await getAxis(base, id, latDim.name);
  const lon = await getAxis(base, id, lonDim.name);
  const lonIs360 = Math.max(...lon) > 180;
  const west = lonIs360 ? BBOX.west + 360 : BBOX.west;
  const east = lonIs360 ? BBOX.east + 360 : BBOX.east;

  const latIdx = indexRange(lat, BBOX.south, BBOX.north);
  const lonIdx = indexRange(lon, west, east);
  if (!latIdx || !lonIdx) throw new Error("bbox not covered");

  // Build an index selector respecting the dataset's actual dimension order.
  const selFor = (d) => {
    switch (d.role) {
      case "time": return "[last]";
      case "depth": return "[0]"; // surface
      case "lat": return `[${latIdx[0]}:${STRIDE}:${latIdx[1]}]`;
      case "lon": return `[${lonIdx[0]}:${STRIDE}:${lonIdx[1]}]`;
      default: return "[0]";
    }
  };
  const sel = meta.dims.map(selFor).join("");
  const url = `${base}/griddap/${id}.json?${uVar}${sel},${vVar}${sel}`;
  console.log(`   query: ${url}`);

  const resp = await getJSON(url);
  return buildGrid(resp, uVar, vVar, `${id} via ${base}`);
}

function buildGrid(resp, uVar, vVar, source) {
  const cols = resp.table.columnNames;
  const yi = cols.findIndex((c) => /^lat/i.test(c));
  const xi = cols.findIndex((c) => /^lon/i.test(c));
  const ti = cols.findIndex((c) => /time/i.test(c));
  const ui = cols.indexOf(uVar);
  const vi = cols.indexOf(vVar);
  const rows = resp.table.rows;

  const lats = [...new Set(rows.map((r) => r[yi]))].sort((a, b) => b - a); // N->S
  const lons = [...new Set(rows.map((r) => toSigned(r[xi])))].sort((a, b) => a - b); // W->E
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
    const u = r[ui], v = r[vi];
    if (u != null && v != null && isFinite(u) && isFinite(v)) {
      U[j * nx + i] = u; V[j * nx + i] = v; filled++;
    }
  }

  const dx = nx > 1 ? (lons[nx - 1] - lons[0]) / (nx - 1) : 0.08;
  const dy = ny > 1 ? (lats[0] - lats[ny - 1]) / (ny - 1) : 0.08;
  const refTime = ti >= 0 && rows.length ? rows[0][ti] : new Date().toISOString();
  const pct = (100 * filled) / (nx * ny);
  console.log(`   grid ${nx}x${ny}, ${filled} ocean pts (${pct.toFixed(0)}%), time ${refTime}`);
  if (filled < 0.05 * nx * ny) throw new Error("almost no ocean data");

  const header = (parameterNumber) => ({
    parameterCategory: 2, parameterNumber, // 2 = U east, 3 = V north
    lo1: lons[0], la1: lats[0], dx, dy, nx, ny,
    refTime, forecastTime: 0, source
  });
  return [
    { header: header(2), data: U },
    { header: header(3), data: V }
  ];
}

(async function main() {
  const outfile = process.argv[2] ||
    path.join(__dirname, "..", "data", "gulf-currents.json");

  let result = null;
  outer:
  for (const base of SERVERS) {
    console.log(`\n#### Server: ${base}`);
    // Collect candidate dataset IDs via search.
    const ids = [];
    for (const term of SEARCH_TERMS) {
      try {
        const found = await searchDatasets(base, term);
        for (const id of found) if (!ids.includes(id)) ids.push(id);
        console.log(`   search "${term}": ${found.length} griddap datasets`);
      } catch (e) {
        console.log(`   search "${term}" failed: ${e.message}`);
      }
    }
    if (!ids.length) continue;

    let tried = 0;
    for (const id of ids) {
      if (tried >= MAX_CANDIDATES_PER_SERVER) break;
      tried++;
      try {
        console.log(`-- ${id}`);
        result = await tryDataset(base, id);
        console.log(`   OK: using ${id}`);
        break outer;
      } catch (e) {
        console.log(`   skip: ${e.message}`);
      }
    }
  }

  if (!result) {
    console.error("\nNo ERDDAP dataset yielded Gulf current data.");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.writeFileSync(outfile, JSON.stringify(result));
  const kb = (fs.statSync(outfile).size / 1024).toFixed(0);
  console.log(`\nWrote ${outfile} (${kb} KB) from ${result[0].header.source}`);
})();
