#!/usr/bin/env python3
"""
test_convert_synthetic.py
-------------------------
Offline test of the NetCDF -> leaflet-velocity JSON conversion in
fetch-hycom-tsis.py. It builds a tiny synthetic NetCDF that mimics the awkward
parts of the real HYCOM files -- a 0..360 longitude convention, ascending
latitude, a depth axis, a leading time axis, packed Int16 values with
scale_factor/add_offset, and a _FillValue for land -- then asserts the
converter reproduces the EXACT schema of data/gulf-currents.json:

  * two blocks [uBlock, vBlock] with parameterNumber 2 and 3,
  * NW-corner origin (lo1 = west-most signed lon, la1 = north-most lat),
  * positive dx/dy, flat data of length nx*ny scanned N->S then W->E,
  * land/fill cells as JSON null, ocean values in m/s.

Run: python3 tools/test_convert_synthetic.py   (needs numpy, netCDF4)
"""
import importlib.util
import os
import tempfile

import numpy as np
import netCDF4

HERE = os.path.dirname(os.path.abspath(__file__))

# Import the hyphenated module file directly.
_spec = importlib.util.spec_from_file_location(
    "fetch_hycom_tsis", os.path.join(HERE, "fetch-hycom-tsis.py"))
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


SCALE = 0.001
OFFSET = 0.0
FILLV = np.int16(-30000)


def make_synthetic_nc(path):
    """Write a small HYCOM-like file. Returns the raw int16 u/v fields and the
    coordinate arrays so the test can compute the expected output independently.
    """
    ny, nx = 6, 8
    lat = 18.0 + 0.04 * np.arange(ny)          # ASCENDING south->north
    lon360 = 262.0 + 0.04 * np.arange(nx)      # 0..360 convention (=> -98..)
    depth = np.array([0.0, 10.0, 30.0])        # surface is index 0
    time = np.array([1500.0])                  # hours since epoch below

    # Raw packed ocean fields (Int16). Distinct per-cell so ordering bugs show.
    u_raw = np.zeros((ny, nx), dtype=np.int16)
    v_raw = np.zeros((ny, nx), dtype=np.int16)
    for j in range(ny):
        for i in range(nx):
            u_raw[j, i] = np.int16(100 * j + i)        # *SCALE -> m/s
            v_raw[j, i] = np.int16(-(100 * i + j))
    # A couple of land/fill cells.
    land = [(0, 0), (5, 7), (2, 3)]
    for (j, i) in land:
        u_raw[j, i] = FILLV
        v_raw[j, i] = FILLV

    ds = netCDF4.Dataset(path, "w", format="NETCDF4")
    ds.createDimension("time", 1)
    ds.createDimension("depth", depth.size)
    ds.createDimension("lat", ny)
    ds.createDimension("lon", nx)

    tv = ds.createVariable("time", "f8", ("time",))
    tv.units = "hours since 2000-01-01 00:00:00"
    tv.calendar = "standard"
    tv[:] = time

    dv = ds.createVariable("depth", "f4", ("depth",))
    dv.units = "m"
    dv[:] = depth

    yv = ds.createVariable("lat", "f4", ("lat",))
    yv.units = "degrees_north"
    yv[:] = lat
    xv = ds.createVariable("lon", "f4", ("lon",))
    xv.units = "degrees_east"
    xv[:] = lon360

    for name, raw in (("water_u", u_raw), ("water_v", v_raw)):
        var = ds.createVariable(name, "i2", ("time", "depth", "lat", "lon"),
                                fill_value=FILLV)
        var.units = "m/s"
        var.scale_factor = SCALE
        var.add_offset = OFFSET
        # Broadcast the surface field across the (dummy) depth/time axes.
        full = np.empty((1, depth.size, ny, nx), dtype=np.int16)
        for k in range(depth.size):
            full[0, k] = raw
        # Mark fill explicitly (auto-mask uses _FillValue).
        var.set_auto_maskandscale(False)
        var[:] = full

    ssh = ds.createVariable("surf_el", "f4", ("time", "lat", "lon"))
    ssh.units = "m"
    ssh[:] = np.random.default_rng(0).normal(0, 0.1, (1, ny, nx)).astype("f4")

    ds.close()
    return lat, lon360, u_raw, v_raw, land


def expected_flat(field_raw, lat, lon360, land):
    """Independently compute the expected flat array (N->S, W->E, null at land)."""
    ny, nx = field_raw.shape
    lon_signed = np.where(lon360 > 180, lon360 - 360, lon360)
    jorder = np.argsort(-lat)          # north -> south
    iorder = np.argsort(lon_signed)    # west -> east
    landset = set(land)
    out = []
    for j in jorder:
        for i in iorder:
            if (j, i) in landset:
                out.append(None)
            else:
                out.append(round(float(field_raw[j, i]) * SCALE, 3))
    return out, lon_signed[iorder], lat[jorder]


def main():
    with tempfile.TemporaryDirectory() as tmp:
        nc = os.path.join(tmp, "synthetic.nc")
        lat, lon360, u_raw, v_raw, land = make_synthetic_nc(nc)

        # Run the real conversion path.
        glat, glon, u2d = mod.open_surface_grid(nc, "water_u")
        _, _, v2d = mod.open_surface_grid(nc, "water_v")
        blocks = mod.build_blocks(glat, glon, u2d, v2d,
                                  "2010-07-15T00:00:00Z", "synthetic-test")

        # ---- schema assertions ----
        assert isinstance(blocks, list) and len(blocks) == 2
        assert blocks[0]["header"]["parameterNumber"] == 2
        assert blocks[1]["header"]["parameterNumber"] == 3
        for blk in blocks:
            h = blk["header"]
            assert h["parameterCategory"] == 2
            assert h["forecastTime"] == 0
            assert len(blk["data"]) == h["nx"] * h["ny"]
            assert h["dx"] > 0 and h["dy"] > 0

        exp_u, lon_we, lat_ns = expected_flat(u_raw, lat, lon360, land)
        exp_v, _, _ = expected_flat(v_raw, lat, lon360, land)

        h = blocks[0]["header"]
        # NW-corner origin, signed lon, abs(dx/dy) ~ 0.04.
        assert abs(h["lo1"] - lon_we[0]) < 1e-6, (h["lo1"], lon_we[0])
        assert abs(h["la1"] - lat_ns[0]) < 1e-6, (h["la1"], lat_ns[0])
        assert abs(h["dx"] - 0.04) < 1e-3 and abs(h["dy"] - 0.04) < 1e-3
        assert h["lo1"] < 0, "Gulf longitudes must be signed/negative"

        # ---- exact data assertions (ordering + fill + units) ----
        assert blocks[0]["data"] == exp_u, "U grid mismatch (ordering/fill?)"
        assert blocks[1]["data"] == exp_v, "V grid mismatch (ordering/fill?)"

        # Land cells are JSON null in both components.
        nulls_u = sum(1 for x in blocks[0]["data"] if x is None)
        assert nulls_u == len(land), (nulls_u, len(land))

        # ---- verify() runs clean ----
        mod.verify_blocks(blocks)

        print("\nOK: synthetic NetCDF converts to the exact gulf-currents.json schema.")


if __name__ == "__main__":
    main()
