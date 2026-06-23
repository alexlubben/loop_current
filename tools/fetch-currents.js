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

// Broad western-Atlantic / Gulf domain: the Caribbean Sea (where the Caribbean
// Current feeds in), the whole Gulf of Mexico, and the Gulf Stream running up
// the U.S. East Coast and out into the North Atlantic. Datasets that only cover
// part of this box (e.g. the Gulf-specific HYCOM) are clipped automatically by
// indexRange(), so a wider box never breaks the Gulf-only sources.
const BBOX = { west: -99.0, east: -58.0, south: 8.0, north: 42.0 };

// Instead of a fixed stride (which made a fine, basin-scale grid a huge, slow
// ERDDAP download), pick the stride per dataset so the subset lands near this
// many points. Keeps the payload light AND the server-side request fast no
// matter the source's native resolution (1/25deg Gulf vs 1/12deg global etc.).
const TARGET_POINTS = 30000;

// Overall wall-clock budget for source discovery. ERDDAP servers can be slow or
// flaky; once this elapses we stop probing and use the best dataset found so far
// rather than letting the fetch step drag on. Bounded by per-request timeouts on
// top of this, so total runtime stays a few minutes at worst.
const DEADLINE_MS = 210000; // 3.5 min

// "Broad enough" bar: a dataset must reach down into the Caribbean, up past Cape
// Hatteras into the North Atlantic, and east of the Bahamas before we treat it as
// covering the whole Caribbean Current -> Loop Current -> Gulf Stream corridor.
// A Gulf-only dataset (e.g. hycom_gom310D, which stops near -76E / 18N) fails this
// bar and is only used as a fallback when nothing broader is reachable. This is
// what lets the map stay populated when the reader zooms out past the Gulf.
const BROAD = { south: 14.0, north: 36.0, west: -92.0, east: -64.0 };

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0 Safari/537.36 loop-current-fetch/1.0";

// Known-good datasets, probed directly (no search needed) before discovery.
// hycom_gom310D = NRL HYCOM 1/25deg Gulf of Mexico — high-res but Gulf-ONLY, so
// it is kept only as a narrow fallback; coverage scoring prefers a broader,
// basin-scale model (global HYCOM/RTOFS/OSCAR) found via discovery below.
const DIRECT = [
  { base: "https://coastwatch.pfeg.noaa.gov/erddap", id: "hycom_gom310D" }
];

// ERDDAP servers to search. Ordered so the ones that actually host basin-scale /
// global current models (CoastWatch's NRL global HYCOM, PacIOOS's global models)
// are tried FIRST — that's where a broad dataset is found — with the Gulf/
// regional IOOS servers after, and the historically slow TAMU server last.
const SERVERS = [
  "https://coastwatch.pfeg.noaa.gov/erddap",
  "https://pae-paha.pacioos.hawaii.edu/erddap",
  "https://erddap.gcoos.org/erddap",
  "https://erddap.secoora.org/erddap",
  "https://erddap.caricoos.org/erddap",
  "https://gcoos5.geos.tamu.edu/erddap"
];
// Search terms tuned to surface basin-scale / global surface-current models
// (which cover the whole western-Atlantic corridor) alongside regional ones.
const SEARCH_TERMS = ["hycom", "rtofs", "oscar", "current"];
const MAX_CANDIDATES_PER_SERVER = 16;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch JSON with retries/backoff — handles ERDDAP servers (esp. CoastWatch)
// that intermittently return 403/5xx from a WAF. `timeout` is per attempt: the
// probe phase uses a short one so a slow/blocked server is abandoned quickly,
// while the final data download gets longer.
async function getJSON(url, { attempts = 2, timeout = 25000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        signal: AbortSignal.timeout(timeout)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(1500); // brief retry for transient blips
    }
  }
  throw lastErr;
}

// Short, fail-fast options for the discovery/probe phase. Searches don't retry
// (a dead/slow server shouldn't cost two timeouts per term); axis/info probes
// retry once since those are the calls we actually depend on.
const PROBE = { attempts: 2, timeout: 12000 };
const SEARCH = { attempts: 1, timeout: 10000 };

// --- ERDDAP search: return griddap dataset IDs matching a term ---------------
async function searchDatasets(base, term) {
  const url = `${base}/search/index.json?searchFor=${encodeURIComponent(term)}` +
              `&page=1&itemsPerPage=50`;
  const j = await getJSON(url, SEARCH);
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
  const info = await getJSON(`${base}/info/${id}/index.json`, PROBE);
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
  const j = await getJSON(`${base}/griddap/${id}.json?${encodeURIComponent(name)}`, PROBE);
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

// --- Cheap probe: figure out whether a dataset has u/v currents over the BBOX
// and HOW MUCH of the BBOX it actually spans, WITHOUT pulling the heavy data
// grid. Returns everything fetchProbed() needs plus a `coverage` summary.
async function probeDataset(base, id) {
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

  // Actual covered extent (signed lon) of the part of this dataset inside the BBOX.
  const latVals = lat.slice(latIdx[0], latIdx[1] + 1);
  const lonVals = lon.slice(lonIdx[0], lonIdx[1] + 1).map(toSigned);
  const cs = Math.min(...latVals), cn = Math.max(...latVals);
  const cw = Math.min(...lonVals), ce = Math.max(...lonVals);
  const coverage = {
    south: cs, north: cn, west: cw, east: ce,
    // fraction of the target box spanned, in each axis and overall (area).
    latFrac: (cn - cs) / (BBOX.north - BBOX.south),
    lonFrac: (ce - cw) / (BBOX.east - BBOX.west),
    get area() { return this.latFrac * this.lonFrac; },
    // does it reach the Caribbean / North Atlantic / mid-Atlantic corners?
    broad: cs <= BROAD.south && cn >= BROAD.north && cw <= BROAD.west && ce >= BROAD.east
  };

  return { base, id, dims: meta.dims, latIdx, lonIdx, uVar, vVar, coverage };
}

// --- Heavy fetch: pull the actual u/v grid for an already-probed dataset.
async function fetchProbed(p) {
  const { base, id, dims, latIdx, lonIdx, uVar, vVar } = p;
  // Pick a stride so the subset lands near TARGET_POINTS regardless of the
  // dataset's native resolution — keeps both the payload and the server-side
  // ERDDAP request small (a fixed stride made fine global grids huge and slow).
  const nLat = latIdx[1] - latIdx[0] + 1, nLon = lonIdx[1] - lonIdx[0] + 1;
  const stride = Math.max(1, Math.ceil(Math.sqrt((nLat * nLon) / TARGET_POINTS)));
  console.log(`   native ${nLon}x${nLat} over box -> stride ${stride} ` +
              `(~${Math.round((nLat / stride) * (nLon / stride))} pts)`);

  // Build an index selector respecting the dataset's actual dimension order.
  const selFor = (d) => {
    switch (d.role) {
      case "time": return "[last]";
      case "depth": return "[0]"; // surface
      case "lat": return `[${latIdx[0]}:${stride}:${latIdx[1]}]`;
      case "lon": return `[${lonIdx[0]}:${stride}:${lonIdx[1]}]`;
      default: return "[0]";
    }
  };
  const sel = dims.map(selFor).join("");
  const url = `${base}/griddap/${id}.json?${uVar}${sel},${vVar}${sel}`;
  console.log(`   query: ${url}`);

  const resp = await getJSON(url, { attempts: 2, timeout: 45000 });
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

  // We "shop" across sources: probe candidates cheaply, collect them ranked by
  // how much of the corridor they cover, then DOWNLOAD them in that order until
  // one actually returns data. Probing and downloading are separated so a single
  // dataset that 500s on its data query (as some ERDDAP entries do) just moves us
  // to the next candidate instead of crashing the run — and a Gulf-only source
  // never wins while a broader one is fetchable.
  const candidates = [];          // all probed datasets (with coverage)
  const seen = new Set();         // dedupe base+id
  let broadCount = 0;             // how many clear the BROAD bar

  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;

  const describe = (c) =>
    `lat ${c.south.toFixed(1)}..${c.north.toFixed(1)}, ` +
    `lon ${c.west.toFixed(1)}..${c.east.toFixed(1)} ` +
    `(${(c.area * 100).toFixed(0)}% of target box)`;

  // Probe one candidate and record it. Returns true once we have collected
  // enough broad candidates to stop probing and start downloading.
  const consider = async (base, id) => {
    const key = `${base}|${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const p = await probeDataset(base, id);
    const c = p.coverage;
    console.log(`   coverage ${describe(c)}${c.broad ? "  [BROAD]" : ""}`);
    candidates.push(p);
    if (c.broad) broadCount++;
    return broadCount >= 3; // a few broad options is plenty to try downloading
  };

  // 1) Probe the known-good direct datasets first.
  for (const ds of DIRECT) {
    try {
      console.log(`\n#### Direct: ${ds.id} @ ${ds.base}`);
      await consider(ds.base, ds.id);
    } catch (e) {
      console.log(`   skip: ${e.message}`);
    }
  }

  // 2) Discover more datasets by searching each server, until we have a few
  //    broad options or the time budget is spent.
  outer:
  for (const base of broadCount >= 3 ? [] : SERVERS) {
    if (outOfTime()) { console.log("\n(time budget spent; stopping discovery)"); break; }
    console.log(`\n#### Server: ${base}`);
    const ids = [];
    for (const term of SEARCH_TERMS) {
      if (outOfTime()) break;
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
      if (outOfTime()) { console.log("   (time budget spent; stopping discovery)"); break outer; }
      tried++;
      try {
        console.log(`-- ${id}`);
        if (await consider(base, id)) break outer;
      } catch (e) {
        console.log(`   skip: ${e.message}`);
      }
    }
  }

  if (!candidates.length) {
    // Leave any existing (last-good) data file untouched so a transient outage
    // doesn't downgrade the deployed map to the procedural fallback.
    console.error("\nNo ERDDAP dataset yielded current data; keeping existing data file if present.");
    process.exit(1);
  }

  // Rank: broad datasets first, then by how much of the box they cover. Download
  // them in order until one succeeds — so a 500 on the best one falls through to
  // the next rather than aborting the whole fetch.
  candidates.sort((a, b) =>
    (b.coverage.broad - a.coverage.broad) || (b.coverage.area - a.coverage.area));

  let result = null, used = null;
  for (const p of candidates) {
    try {
      console.log(
        `\n==> Trying ${p.coverage.broad ? "BROAD " : ""}dataset ${p.id} — ` +
        `${describe(p.coverage)}`);
      result = await fetchProbed(p);
      used = p;
      break;
    } catch (e) {
      console.log(`   download failed: ${e.message}`);
    }
  }

  if (!result) {
    console.error("\nEvery candidate failed to download; keeping existing data file if present.");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.writeFileSync(outfile, JSON.stringify(result));
  const kb = (fs.statSync(outfile).size / 1024).toFixed(0);
  console.log(`\nWrote ${outfile} (${kb} KB) from ${result[0].header.source}` +
    `${used.coverage.broad ? "" : "  (NOTE: sub-regional — no basin-wide source was reachable)"}`);
})();
