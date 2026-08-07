#!/bin/sh
# Every check that runs without a GPU, a browser, or a network.
#
#   sh tests/run-all.sh
#
# What these cover: the id grammar and stability, type instantiation and
# stacking, the real generators over the real spec, the display arithmetic, the
# RoomViewer itself against a substituted renderer, and the shell's contract
# with the page.
#
# What they cannot cover: shading, real draw calls, real frame timing, and
# anything that depends on layout. Those are page verification.

set -e
cd "$(dirname "$0")/.."

status=0
run() {
  name="$1"; shift
  echo ""
  echo "── $name ─────────────────────────────────────────"
  "$@" || status=1
}

run "building composition"      deno run -A --import-map=tests/import_map.json tests/verify-building.js
run "generators over the spec"  deno run -A --import-map=tests/import_map.json tests/verify-meshes.js
run "display arithmetic"        deno run -A tests/verify-display.js
run "the viewer, headless"      deno run -A --import-map=tests/import_map_headless.json tests/verify-viewer.js
run "selection coherence"       deno run -A --import-map=tests/import_map.json tests/verify-selection.js
run "shell wiring"              deno run -A --import-map=tests/import_map.json tests/verify-wiring.js
run "de-identification"         deno run -A tests/verify-deid.js

echo ""
if [ "$status" -eq 0 ]; then
  echo "ALL PASS"
else
  echo "FAILURES ABOVE"
fi
exit "$status"
