#!/usr/bin/env python3
"""
fetch-hycom-tsis.py
-------------------
Replace data/gulf-currents.json with a REAL Gulf of Mexico surface-current
snapshot from the HYCOM-TSIS 1/25 deg Gulf of Mexico Reanalysis
(GOMb0.04 / reanalysis), summer 2010 -- the Loop Current Eddy "Franklin"
period.

It is faithful to the task pipeline:

  1. introspect  -- read the dataset header off the OPeNDAP endpoint
                    (the `ncdump -h` equivalent: we GET the .das / .dds text),
                    confirming variable names (water_u / water_v), the depth
                    coordinate, the time axis, and the lon/lat extent.
  2. pick-date   -- pull surf_el (sea-surface height) over the Gulf for a set
                    of candidate summer-2010 dates via NCSS and score the
                    anticyclonic ring so we can choose the cleanest snapshot.
  3. download    -- request ONLY water_u + water_v, surface depth, a single
                    timestep, over the Gulf bounding box, as NetCDF, via the
                    NetCDF Subset Service (NCSS).
  4. convert     -- transform the NetCDF u/v grid into the EXACT leaflet-velocity
                    schema the site already consumes (see SCHEMA NOTES below).
  5. verify      -- range / coverage sanity checks against the original file.

Only plain HTTPS GETs are used against the data servers:
  * OPeNDAP `.das` / `.dds` text for introspection, and
  * NCSS grid requests that return a NetCDF file we parse LOCALLY with netCDF4.
This avoids depending on a DAP-enabled client library at the remote end.

Network: the data hosts (tds.hycom.org, ncss.hycom.org) must be reachable. In
the sandboxed web environment they are blocked by the egress allowlist until
those hosts are added; run this where they are reachable.

Dependencies: numpy, netCDF4  (pip install numpy netCDF4).

--------------------------------------------------------------------------------
SCHEMA NOTES -- the exact format of data/gulf-currents.json (must match!)
--------------------------------------------------------------------------------
The file is a JSON array of EXACTLY two blocks: [ uBlock, vBlock ].
Each block is { "header": {...}, "data": [...] } where:

  header.parameterCategory = 2          (momentum)
  header.parameterNumber   = 2 for U (eastward), 3 for V (northward)
  header.lo1               = WEST-most longitude  (NW-corner origin), signed
  header.la1               = NORTH-most latitude  (NW-corner origin)
  header.dx, header.dy     = grid spacing in degrees (POSITIVE)
  header.nx, header.ny     = grid dimensions
  header.refTime           = ISO-8601 snapshot timestamp
  header.forecastTime      = 0
  header.source            = provenance string

  data = a FLAT array of length nx*ny, row-major, scanned NORTH -> SOUTH
         (first row at la1) and WEST -> EAST within each row. Units m/s.
         Land / masked / fill cells are JSON null. Longitudes are signed
         (-180..180). Real value range is roughly -2..2.5 m/s.

Usage:
  python3 tools/fetch-hycom-tsis.py introspect
  python3 tools/fetch-hycom-tsis.py pick-date
  python3 tools/fetch-hycom-tsis.py run --date 2010-07-15T00:00:00Z
  python3 tools/fetch-hycom-tsis.py run          # auto-pick the date
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.request
import urllib.error

import numpy as np
import netCDF4  # noqa: F401  (used via netCDF4.Dataset)

# ---------------------------------------------------------------------------
# Configuration -- confirmed against the live catalog before downloading.
# The catalog page https://tds.hycom.org/thredds/catalogs/GOMb0.04/reanalysis.html
# serves the year 2010 as dataset id  GOMb0.04-reanalysis-2010-3z, whose paths
# are the OPeNDAP / NCSS bases below. The `introspect` stage re-confirms the
# variable names and axes at runtime, so these are starting points, not faith.
# ---------------------------------------------------------------------------
DATASET_PATH = "GOMb0.04/reanalysis/2010/3z"
OPENDAP_BASE = "https://tds.hycom.org/thredds/dodsC/" + DATASET_PATH
NCSS_BASE = "https://ncss.hycom.org/thredds/ncss/grid/" + DATASET_PATH
CATALOG_URL = "https://tds.hycom.org/thredds/catalogs/GOMb0.04/reanalysis.html"

# Gulf of Mexico bounding box (the domain is roughly 98W-77W, 18N-32N). The
# server clips to its own native domain, so a slightly generous box is safe.
BBOX = {"west": -98.0, "east": -77.0, "south": 18.0, "north": 31.0}

# Eddy "Franklin" shed from the Loop Current around 24 May 2010; the Loop stayed
# strongly extended through the summer before full separation in Sept 2010.
# Probe mid-June..mid-August and pick the cleanest ring.
CANDIDATE_DATES = [
    "2010-06-08T00:00:00Z",
    "2010-06-15T00:00:00Z",
    "2010-06-22T00:00:00Z",
    "2010-07-01T00:00:00Z",
    "2010-07-08T00:00:00Z",
    "2010-07-15T00:00:00Z",
    "2010-08-01T00:00:00Z",
    "2010-08-15T00:00:00Z",
]

# Variable names (confirmed at runtime by `introspect`).
U_VAR, V_VAR = "water_u", "water_v"
SSH_VAR = "surf_el"

# Region used to score the anticyclonic ring (eastern/central Gulf where the
# Loop Current intrudes and sheds warm-core rings).
RING_REGION = {"west": -93.0, "east": -83.0, "south": 22.0, "north": 28.0}

HERE = os.path.dirname(os.path.abspath(__file__))
OUTFILE = os.path.join(HERE, "..", "data", "gulf-currents.json")
SCRATCH = os.path.join(HERE, "..", ".hycom-cache")

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36 loop-current-fetch/2.0")

# Anything with |value| beyond this is treated as a fill/garbage sentinel even
# if it slipped past the netCDF mask (HYCOM fill is ~1.2676506e30).
FILL_GUARD = 1.0e10


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def http_get(url, dest=None, timeout=120, retries=4):
    """GET a URL with retry/backoff. Returns bytes, or writes to `dest`."""
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
            if dest:
                with open(dest, "wb") as f:
                    f.write(data)
                return dest
            return data
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            last = e
            if i < retries - 1:
                import time
                time.sleep(2 ** (i + 1))
    raise RuntimeError(f"GET failed after {retries} tries: {url}\n  {last}")


# ---------------------------------------------------------------------------
# Stage 1 -- introspect (ncdump -h equivalent via OPeNDAP .das / .dds)
# ---------------------------------------------------------------------------
def introspect():
    print(f"# Catalog : {CATALOG_URL}")
    print(f"# OPeNDAP : {OPENDAP_BASE}")
    print(f"# NCSS    : {NCSS_BASE}\n")

    print("=== OPeNDAP .dds (structure: variables, dimensions, sizes) ===")
    dds = http_get(OPENDAP_BASE + ".dds").decode("utf-8", "replace")
    print(dds)

    print("=== OPeNDAP .das (attributes: units, _FillValue, ranges, time) ===")
    das = http_get(OPENDAP_BASE + ".das").decode("utf-8", "replace")
    print(das)

    # Quick confirmations a human should eyeball.
    for name in (U_VAR, V_VAR, SSH_VAR):
        present = name in dds
        print(f"[check] variable {name!r:12} present in .dds: {present}")
    for axis in ("depth", "time", "lat", "lon"):
        print(f"[check] axis {axis!r:6} present in .dds: {axis in dds}")
    print("\nReview the depth coordinate (surface = depth 0), the time units, "
          "and the lat/lon ranges above before downloading.")


# ---------------------------------------------------------------------------
# NCSS request builder + NetCDF reader
# ---------------------------------------------------------------------------
def ncss_url(variables, time_iso, vert_coord=0.0, accept="netcdf4"):
    """Build a minimal NCSS grid request: chosen vars, surface, single time,
    Gulf bbox, NetCDF."""
    vs = "".join(f"var={v}&" for v in variables)
    return (
        f"{NCSS_BASE}?{vs}"
        f"north={BBOX['north']}&south={BBOX['south']}&"
        f"west={BBOX['west']}&east={BBOX['east']}&"
        f"disableProjSubset=on&horizStride=1&"
        f"time={time_iso}&vertCoord={vert_coord}&"
        f"accept={accept}"
    )


def _find_dim_index(var, *roles):
    """Index of the first dimension of `var` whose name matches any role regex."""
    import re
    for idx, dname in enumerate(var.dimensions):
        for role in roles:
            if re.search(role, dname, re.I):
                return idx, dname
    return None, None


def find_uv_vars(ds):
    """Return (uvar, vvar) names, preferring CF standard_name, then common
    name pairs. Works for both `water_u`/`water_v` (NCSS) and `u`/`v` (the
    HYCOM archive translation)."""
    by_std = {}
    for name, var in ds.variables.items():
        std = getattr(var, "standard_name", "")
        if std:
            by_std.setdefault(std, name)
    u = by_std.get("eastward_sea_water_velocity")
    v = by_std.get("northward_sea_water_velocity")
    if u and v:
        return u, v
    for cu, cv in (("water_u", "water_v"), ("u", "v"), ("uo", "vo"),
                   ("surf_u", "surf_v")):
        if cu in ds.variables and cv in ds.variables:
            return cu, cv
    raise RuntimeError("could not identify eastward/northward velocity variables")


def open_surface_grid(nc_path, varname):
    """Open a NetCDF, collapse every non-horizontal axis (surface depth, single
    time, anything else) to a single level, and return (lat1d, lon1d, data2d)
    with masked/fill cells as NaN. data2d is indexed [lat_index, lon_index] in
    the file's native axis order."""
    ds = netCDF4.Dataset(nc_path)
    try:
        ds.set_auto_maskandscale(True)  # apply scale_factor/add_offset, mask fill
        var = ds.variables[varname]

        # Locate coordinate variables (HYCOM uses capitalised names).
        lat = lon = None
        for cand in ("lat", "latitude", "Latitude", "Y", "y"):
            if cand in ds.variables:
                lat = np.asarray(ds.variables[cand][:], dtype="float64"); break
        for cand in ("lon", "longitude", "Longitude", "X", "x"):
            if cand in ds.variables:
                lon = np.asarray(ds.variables[cand][:], dtype="float64"); break
        if lat is None or lon is None:
            raise RuntimeError(f"lat/lon coordinate variables not found in {nc_path}")

        zi, zname = _find_dim_index(var, r"depth", r"^lev", r"^z$", r"altitude")
        yi, _ = _find_dim_index(var, r"^lat", r"^y$", r"latitude")
        xi, _ = _find_dim_index(var, r"^lon", r"^x$", r"longitude")
        if yi is None or xi is None:
            raise RuntimeError(f"{varname}: cannot locate lat/lon dimensions "
                               f"(dims={var.dimensions})")

        # Collapse EVERY non-horizontal axis to one index: surface for depth
        # (closest to 0), index 0 for time / MT / anything else.
        sel = [slice(None)] * var.ndim
        for d in range(var.ndim):
            if d in (yi, xi):
                continue
            if d == zi and zname in ds.variables:
                depths = np.asarray(ds.variables[zname][:], dtype="float64")
                sel[d] = int(np.argmin(np.abs(depths)))
            else:
                sel[d] = 0

        arr = var[tuple(sel)]
        arr = np.asarray(arr.filled(np.nan) if np.ma.isMaskedArray(arr) else arr,
                         dtype="float64")
        # Only the lat & lon axes survive; order them as (lat, lon).
        remaining = [d for d in range(var.ndim) if isinstance(sel[d], slice)]
        ypos, xpos = remaining.index(yi), remaining.index(xi)
        arr = np.moveaxis(arr, (ypos, xpos), (0, 1))
        arr = np.squeeze(arr)
        if arr.ndim != 2:
            raise RuntimeError(f"{varname}: expected a 2-D surface field, got {arr.shape}")

        # Belt-and-suspenders fill guard: HYCOM's stored land sentinel (2^126)
        # does not exactly equal the _FillValue attribute, so the netCDF mask
        # can miss it. Anything absurdly large is land.
        arr = np.where(np.abs(arr) > FILL_GUARD, np.nan, arr)
        return lat, lon, arr
    finally:
        ds.close()


def read_ref_time(nc_path):
    """Read the snapshot time from the NetCDF and return an ISO-8601 string."""
    ds = netCDF4.Dataset(nc_path)
    try:
        for cand in ("time", "Time", "MT"):
            if cand in ds.variables:
                tv = ds.variables[cand]
                val = np.asarray(tv[:]).ravel()[0]
                when = netCDF4.num2date(
                    val, tv.units,
                    getattr(tv, "calendar", "standard"),
                    only_use_cftime_datetimes=False,
                )
                if isinstance(when, dt.datetime):
                    return when.strftime("%Y-%m-%dT%H:%M:%SZ")
                return str(when)
    finally:
        ds.close()
    return None


# ---------------------------------------------------------------------------
# Stage 2 -- pick the cleanest anticyclonic-ring date from surf_el
# ---------------------------------------------------------------------------
def score_ring(lat, lon, ssh):
    """Score an SSH field for a large, cleanly formed anticyclonic ring in the
    eastern/central Gulf. Returns (peak_anomaly_m, high_area_fraction)."""
    lon_s = np.where(lon > 180, lon - 360, lon)
    inreg = ((lat[:, None] >= RING_REGION["south"]) &
             (lat[:, None] <= RING_REGION["north"]) &
             (lon_s[None, :] >= RING_REGION["west"]) &
             (lon_s[None, :] <= RING_REGION["east"]))
    vals = ssh[inreg]
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return (float("nan"), float("nan"))
    med = float(np.median(vals))
    peak = float(np.nanmax(vals)) - med               # dome height above median
    high_frac = float(np.mean(vals > med + 0.25))     # area of a strong high
    return (peak, high_frac)


def pick_date(verbose=True):
    os.makedirs(SCRATCH, exist_ok=True)
    results = []
    for date in CANDIDATE_DATES:
        try:
            url = ncss_url([SSH_VAR], date)
            dest = os.path.join(SCRATCH, f"ssh_{date.replace(':', '').replace('-', '')}.nc")
            http_get(url, dest=dest)
            lat, lon, ssh = open_surface_grid(dest, SSH_VAR)
            peak, frac = score_ring(lat, lon, ssh)
            results.append((date, peak, frac))
            if verbose:
                print(f"{date}  peak_anom={peak:+.3f} m  high_area={frac*100:5.1f}%")
        except Exception as e:  # noqa: BLE001
            if verbose:
                print(f"{date}  (failed: {e})")
    if not results:
        raise RuntimeError("no candidate SSH fields could be retrieved")
    # Prefer the largest well-formed high: rank by high-area fraction, then peak.
    results.sort(key=lambda r: (r[2], r[1]), reverse=True)
    best = results[0][0]
    if verbose:
        print(f"\n--> chosen date: {best}  "
              f"(override with --date if a different ring looks cleaner)")
    return best


# ---------------------------------------------------------------------------
# Stage 4 -- convert NetCDF u/v -> exact leaflet-velocity JSON schema
# ---------------------------------------------------------------------------
def to_uniform_lat(lat, field2d):
    """Resample a [lat_index, lon_index] field from a (possibly Mercator,
    non-uniform) latitude axis onto a UNIFORM latitude axis with the same count
    and extent. leaflet-velocity addresses rows as la1 - j*dy, so a uniform dy
    must hold for features to land at the right latitude. Longitude is left
    untouched (HYCOM's lon is already evenly spaced).

    Nearest-neighbour in latitude: each uniform row takes the value of the
    closest native row. This removes the systematic displacement of using a
    mean dy (which drifts several cells over a Mercator axis), preserves the
    land mask exactly (no coastline erosion or bridging), and is an exact
    identity when the input axis is already uniform. The residual placement
    error is at most half a native cell (~0.018 deg). `lat` must be ascending.
    """
    lat = np.asarray(lat, dtype="float64")
    ny = lat.size
    target = np.linspace(lat[0], lat[-1], ny)        # uniform, same extent/count
    idx = np.abs(lat[None, :] - target[:, None]).argmin(axis=1)  # nearest native row
    return target, field2d[idx, :]


def build_blocks(lat, lon, u2d, v2d, ref_time, source, ndigits=3,
                 uniform_lat=True):
    """Core converter. lat/lon are 1D (any order/convention); u2d/v2d are 2D
    [lat_index, lon_index] in m/s with NaN for masked cells. Returns the two
    [uBlock, vBlock] dicts in the site's schema."""
    lat = np.asarray(lat, dtype="float64")
    lon = np.asarray(lon, dtype="float64")
    lon = np.where(lon > 180, lon - 360, lon)  # -> signed -180..180
    u2d = np.asarray(u2d, dtype="float64")
    v2d = np.asarray(v2d, dtype="float64")

    # HYCOM latitude is Mercator (non-uniform); the renderer assumes uniform dy.
    # Resample onto a uniform latitude axis so features land at the right lat.
    if uniform_lat and lat.size > 2:
        asc = np.argsort(lat)
        la = lat[asc]
        lat, u2d = to_uniform_lat(la, u2d[asc, :])
        _,  v2d = to_uniform_lat(la, v2d[asc, :])

    # Row order NORTH -> SOUTH, column order WEST -> EAST.
    jorder = np.argsort(-lat)   # descending latitude
    iorder = np.argsort(lon)    # ascending longitude
    lat_sorted = lat[jorder]
    lon_sorted = lon[iorder]
    ny, nx = lat_sorted.size, lon_sorted.size

    def flatten(field):
        g = np.asarray(field, dtype="float64")[np.ix_(jorder, iorder)]
        g = np.where(np.isfinite(g) & (np.abs(g) <= FILL_GUARD), g, np.nan)
        g = np.round(g, ndigits)
        out = [None if not np.isfinite(x) else float(x) for x in g.ravel(order="C")]
        return out

    dx = float(np.mean(np.diff(lon_sorted))) if nx > 1 else 0.04
    dy = float(np.mean(-np.diff(lat_sorted))) if ny > 1 else 0.04  # N->S => positive

    def header(parameter_number):
        return {
            "parameterCategory": 2,
            "parameterNumber": parameter_number,  # 2 = U east, 3 = V north
            "lo1": float(lon_sorted[0]),          # west-most (NW corner)
            "la1": float(lat_sorted[0]),          # north-most (NW corner)
            "dx": dx,
            "dy": dy,
            "nx": int(nx),
            "ny": int(ny),
            "refTime": ref_time,
            "forecastTime": 0,
            "source": source,
        }

    return [
        {"header": header(2), "data": flatten(u2d)},
        {"header": header(3), "data": flatten(v2d)},
    ]


# ---------------------------------------------------------------------------
# Stage 5 -- verify
# ---------------------------------------------------------------------------
def verify_blocks(blocks):
    assert isinstance(blocks, list) and len(blocks) == 2, "must be [uBlock, vBlock]"
    names = {2: "U(eastward)", 3: "V(northward)"}
    for blk in blocks:
        h = blk["header"]
        data = blk["data"]
        n = h["nx"] * h["ny"]
        assert len(data) == n, f"data length {len(data)} != nx*ny {n}"
        finite = [x for x in data if isinstance(x, (int, float))]
        nulls = sum(1 for x in data if x is None)
        assert finite, "block is entirely null/fill"
        lo, hi = min(finite), max(finite)
        ocean_pct = 100.0 * len(finite) / n
        print(f"{names.get(h['parameterNumber'], '?'):14}  "
              f"grid {h['nx']}x{h['ny']}  ocean {ocean_pct:4.1f}%  "
              f"null {nulls}  range [{lo:+.3f}, {hi:+.3f}] m/s")
        assert -5.0 < lo and hi < 5.0, "velocity range implausible for m/s"
        assert ocean_pct > 5.0, "almost no ocean data"
    h = blocks[0]["header"]
    print(f"origin NW corner lo1={h['lo1']:.3f} la1={h['la1']:.3f}  "
          f"dx={h['dx']:.4f} dy={h['dy']:.4f}  refTime={h['refTime']}")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def run(date=None, keep=False):
    os.makedirs(SCRATCH, exist_ok=True)
    if date is None:
        print("# Picking the cleanest Eddy-Franklin date from surf_el ...")
        date = pick_date()
    print(f"\n# Downloading water_u/water_v surface subset for {date} ...")
    url = ncss_url([U_VAR, V_VAR], date)
    print(f"  NCSS: {url}")
    nc = os.path.join(SCRATCH, f"uv_{date.replace(':', '').replace('-', '')}.nc")
    http_get(url, dest=nc)
    size = os.path.getsize(nc)
    print(f"  downloaded {size/1024:.0f} KB -> {nc}")
    if size < 1024:
        raise RuntimeError("download suspiciously small; check the NCSS request")

    lat, lon, u2d = open_surface_grid(nc, U_VAR)
    _, _, v2d = open_surface_grid(nc, V_VAR)
    if not np.isfinite(u2d).any() or not np.isfinite(v2d).any():
        raise RuntimeError("velocity arrays are empty / all-fill")

    ref_time = read_ref_time(nc) or date
    source = (f"HYCOM-TSIS GOMb0.04 reanalysis (dataset GOMb0.04-reanalysis-2010-3z); "
              f"{OPENDAP_BASE}; snapshot {ref_time}; "
              f"bbox W{BBOX['west']} E{BBOX['east']} S{BBOX['south']} N{BBOX['north']}; "
              f"accessed {dt.date.today().isoformat()}")
    blocks = build_blocks(lat, lon, u2d, v2d, ref_time, source)

    print("\n# Verify:")
    verify_blocks(blocks)

    with open(OUTFILE, "w") as f:
        json.dump(blocks, f)
    print(f"\nWrote {os.path.abspath(OUTFILE)} "
          f"({os.path.getsize(OUTFILE)/1024:.0f} KB)")
    print(f"Source: {source}")

    if not keep:
        try:
            os.remove(nc)
        except OSError:
            pass


def convert_file(nc_path, uvar=None, vvar=None):
    """Convert an already-downloaded HYCOM NetCDF (e.g. an NCSS subset, or the
    HYCOM archive translation with `u`/`v`) into data/gulf-currents.json."""
    ds = netCDF4.Dataset(nc_path)
    try:
        if not (uvar and vvar):
            uvar, vvar = find_uv_vars(ds)
    finally:
        ds.close()
    print(f"# Converting {os.path.abspath(nc_path)}")
    print(f"  velocity variables: u={uvar!r}  v={vvar!r}")

    lat, lon, u2d = open_surface_grid(nc_path, uvar)
    _, _, v2d = open_surface_grid(nc_path, vvar)
    if not np.isfinite(u2d).any() or not np.isfinite(v2d).any():
        raise RuntimeError("velocity arrays are empty / all-fill")

    ref_time = read_ref_time(nc_path) or "unknown"
    source = (f"HYCOM-TSIS GOMb0.04 1/25deg Gulf of Mexico Reanalysis "
              f"(dataset GOMb0.04-reanalysis-2010-3z, experiment 01.0); "
              f"{OPENDAP_BASE}; snapshot {ref_time}; "
              f"bbox W{BBOX['west']} E{BBOX['east']} S{BBOX['south']} N{BBOX['north']}; "
              f"accessed {dt.date.today().isoformat()}")
    blocks = build_blocks(lat, lon, u2d, v2d, ref_time, source)

    print("\n# Verify:")
    verify_blocks(blocks)
    with open(OUTFILE, "w") as f:
        json.dump(blocks, f)
    print(f"\nWrote {os.path.abspath(OUTFILE)} "
          f"({os.path.getsize(OUTFILE)/1024:.0f} KB)")
    print(f"Source: {source}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage",
                    choices=["introspect", "pick-date", "download", "run",
                             "convert-file"],
                    help="pipeline stage")
    ap.add_argument("--date", default=None,
                    help="ISO snapshot time, e.g. 2010-07-15T00:00:00Z "
                         "(default: auto-pick from surf_el)")
    ap.add_argument("--file", default=None,
                    help="local NetCDF to convert (for the convert-file stage)")
    ap.add_argument("--uvar", default=None, help="eastward velocity var name")
    ap.add_argument("--vvar", default=None, help="northward velocity var name")
    ap.add_argument("--keep", action="store_true",
                    help="keep the downloaded .nc in .hycom-cache/")
    args = ap.parse_args()

    if args.stage == "introspect":
        introspect()
    elif args.stage == "pick-date":
        pick_date()
    elif args.stage in ("download", "run"):
        run(date=args.date, keep=args.keep)
    elif args.stage == "convert-file":
        if not args.file:
            ap.error("convert-file requires --file PATH")
        convert_file(args.file, args.uvar, args.vvar)


if __name__ == "__main__":
    main()
