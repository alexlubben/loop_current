#!/usr/bin/env python3
"""HYCOM GLBy0.08 surface u/v NetCDF -> leaflet-velocity gulf-currents.json.

Provenance
----------
Dataset   : HYCOM GOFS 3.1 GLBy0.08/expt_93.0 (global, 1/12 deg), surface layer.
Snapshot  : 2024-08-28T00:00:00Z (features Eddy Denali in the central Gulf).
Box       : 8-42 deg N, 99-58 deg W (lon 261-302 deg E in the source 0-360 frame).
Access    : 2026-06-23, via the NetCDF Subset Service (NCSS):
            https://ncss.hycom.org/thredds/ncss/GLBy0.08/expt_93.0?
              var=water_u&var=water_v&
              north=42&south=8&west=261&east=302&horizStride=1&
              time=2024-08-28T00:00:00Z&vertCoord=0&
              addLatLon=true&accept=netcdf4

The downloaded grid is 1/12 deg (lon 0.08 deg, lat 0.04 deg). This script
subsamples it the same way the previous file was made -- lon every 3rd point,
lat every 6th -> ~0.24 deg -- converts 0-360 deg longitude to negative degrees,
orders rows north->south, and writes ``null`` for land.
"""
import sys, json, numpy as np, netCDF4 as nc
IN  = sys.argv[1] if len(sys.argv)>1 else "tmp/glb2024.nc"
OUT = sys.argv[2] if len(sys.argv)>2 else "data/gulf-currents.json"
LON_STRIDE, LAT_STRIDE = 3, 6
DATE = "2024-08-28T00:00:00Z"
SOURCE = "HYCOM GOFS 3.1 GLBy0.08/expt_93.0 (NCSS), surface, " + DATE
d = nc.Dataset(IN)
lat = np.array(d.variables['lat'][:], float); lon = np.array(d.variables['lon'][:], float)
def surf(name):
    a = np.squeeze(d.variables[name][:])
    return np.ma.masked_greater(np.ma.masked_invalid(np.ma.masked_array(a)), 1e4)
U = surf('water_u'); V = surf('water_v')
lat = lat[::LAT_STRIDE]; lon = lon[::LON_STRIDE]
U = U[::LAT_STRIDE, ::LON_STRIDE]; V = V[::LAT_STRIDE, ::LON_STRIDE]
lon = np.where(lon > 180, lon - 360, lon)
order = np.argsort(lon); lon = lon[order]; U = U[:, order]; V = V[:, order]
if lat[0] < lat[-1]:
    lat = lat[::-1]; U = U[::-1, :]; V = V[::-1, :]
ny, nx = U.shape
dx = float(np.round(np.mean(np.diff(lon)), 6)); dy = float(np.round(np.mean(np.abs(np.diff(lat))), 6))
def flat(a):
    m = np.ma.getmaskarray(a)
    return [None if m[j,i] else round(float(a[j,i]),3) for j in range(ny) for i in range(nx)]
def header(pn):
    return {"parameterCategory":2,"parameterNumber":pn,"lo1":float(lon[0]),"la1":float(lat[0]),
            "dx":dx,"dy":dy,"nx":int(nx),"ny":int(ny),"refTime":DATE,"forecastTime":0,"source":SOURCE}
json.dump([{"header":header(2),"data":flat(U)},{"header":header(3),"data":flat(V)}], open(OUT,'w'))
print(f"wrote {OUT}: nx={nx} ny={ny} lo1={lon[0]:.3f} la1={lat[0]:.3f} dx={dx} dy={dy}")
d.close()
