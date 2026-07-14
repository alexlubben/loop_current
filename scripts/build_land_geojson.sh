#!/usr/bin/env bash
#
# build_land_geojson.sh — regenerate data/land.geojson, the basemap.
#
# The map draws land from Natural Earth physical vector data (public domain,
# no attribution required), replacing the former OpenFreeMap/OSM vector tiles.
# This script downloads the source shapefiles, clips them to the map's frame,
# simplifies, merges, and writes a small GeoJSON that ships with the page.
#
# Requirements: curl, mapshaper (npm i -g mapshaper), node.
# Usage:        scripts/build_land_geojson.sh
#
# ---------------------------------------------------------------------------
# SOURCE (verified working 2026-07-14)
#
# Natural Earth's canonical download host (naciscdn.org / naturalearthdata.com)
# was NOT reachable from the build environment, and github.com/.../raw/ is gated
# behind repo access. The Natural Earth GitHub mirror served over
# raw.githubusercontent.com worked, so that is what we use. The shapefile
# components (.shp/.shx/.dbf/.prj) are fetched individually from:
#
#   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/10m_physical/
#
# Files used (1:10m physical vector):
#   ne_10m_land.{shp,shx,dbf,prj}            — main land polygons
#   ne_10m_minor_islands.{shp,shx,dbf,prj}   — small islands the land layer omits
#
# Why 1:10m and not 1:50m: at this map's locked zoom the 1:50m coastline was
# visibly blocky along Florida, Cuba, and the Yucatán. Why minor_islands: the
# Natural Earth "land" layer drops very small islands; merging minor_islands
# restores the Florida Keys and the Bahamas/Cuba cays that frame the Loop
# Current's exit through the Florida Straits. (There is no 1:50m minor_islands
# layer — it exists only at 1:10m.)
# ---------------------------------------------------------------------------
set -euo pipefail

MIRROR="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/10m_physical"
# Clip box, W,S,E,N. A touch wider than the map's SAFE_BOUNDS maxBounds wall
# ([[13,-98.5],[41,-59]] in js/app.js) so land covers to every visible edge.
BBOX="-100,12,-58,42"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/data/land.geojson"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for layer in ne_10m_land ne_10m_minor_islands; do
  for ext in shp shx dbf prj; do
    curl -sSL --fail -o "$TMP/$layer.$ext" "$MIRROR/$layer.$ext"
  done
done

# Clip (biggest size win) -> simplify (keep-shapes so tiny islands survive) ->
# merge both layers -> trim coordinate precision to ~100m (sub-pixel at our zoom).
mapshaper \
  -i "$TMP/ne_10m_land.shp" "$TMP/ne_10m_minor_islands.shp" combine-files \
  -clip bbox="$BBOX" remove-slivers target=* \
  -simplify 12% keep-shapes planar \
  -merge-layers force name=land \
  -o precision=0.001 format=geojson "$TMP/land_merged.geojson"

# Drop per-feature attributes (geometry is all the map needs) while keeping a
# FeatureCollection, and write compact JSON.
node -e '
  const fs = require("fs");
  const g = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const f of g.features) f.properties = {};
  fs.writeFileSync(process.argv[2], JSON.stringify(g));
' "$TMP/land_merged.geojson" "$OUT"

echo "Wrote $OUT ($(wc -c < "$OUT") bytes, $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).features.length)' "$OUT") features)"
