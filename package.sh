#!/usr/bin/env bash
# Builds the Chrome Web Store upload zip containing only what ships.
# Everything else in this repo (docs, tests, the packaging script itself)
# stays out: extra files widen the review surface for no benefit.
set -euo pipefail

cd "$(dirname "$0")"

name=$(python3 -c "import json;print(json.load(open('manifest.json'))['name'].lower().replace(' ','-'))")
version=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
out="dist/${name}-${version}.zip"

rm -rf dist
mkdir -p dist

zip -r -q "$out" \
  manifest.json \
  background.js \
  content/content.js \
  content/content.css \
  popup/popup.html \
  popup/popup.js \
  popup/popup.css \
  sidepanel/sidepanel.html \
  sidepanel/sidepanel.js \
  sidepanel/sidepanel.css \
  icons/icon16.png \
  icons/icon32.png \
  icons/icon48.png \
  icons/icon128.png

echo "built $out"
# `head -n -N` is a GNU extension; awk keeps this portable to macOS.
unzip -l "$out" | awk 'NR>3 && $4 != "" {printf "  %8s  %s\n", $1, $4}'
