/*
 * generate-field.js
 * -----------------
 * Renders the illustrative ocean-current field (js/current-field.js) to a
 * leaflet-velocity u/v grid JSON (data/gulf-currents.json) — the same format
 * fetch-currents.js writes from real HYCOM data and the map consumes at runtime.
 *
 * This is the OFFLINE seed: it guarantees the map shows flow across the whole
 * domain even before (or without) a successful ERDDAP fetch. CI still runs
 * fetch-currents.js, which overwrites this file with real HYCOM data whenever a
 * source that covers the domain is reachable.
 *
 * Usage:  node tools/generate-field.js [outfile]
 */
"use strict";

const fs = require("fs");
const path = require("path");

// current-field.js is a browser IIFE that hangs its API off `this` when there's
// no `window` — under CommonJS `this` is module.exports, so requiring it returns
// { GulfCurrentField: {...} }.
const { GulfCurrentField } = require("../js/current-field.js");

const out = process.argv[2] || path.join(__dirname, "..", "data", "gulf-currents.json");
const grid = GulfCurrentField.build();
grid[0].header.source = "illustrative field (tools/generate-field.js)";
grid[1].header.source = grid[0].header.source;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(grid));

const h = grid[0].header;
console.log(
  `wrote ${out}\n  domain: ${h.lo1}..${(h.lo1 + (h.nx - 1) * h.dx).toFixed(1)} lon, ` +
  `${(h.la1 - (h.ny - 1) * h.dy).toFixed(1)}..${h.la1} lat\n  grid: ${h.nx}x${h.ny} ` +
  `(${h.nx * h.ny} points), step ${h.dx} deg`
);
