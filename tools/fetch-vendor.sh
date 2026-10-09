#!/usr/bin/env sh
# Clones the pokepinballrs decompilation (only needed to re-run tools/gen_species.py or re-read the source).
set -e
cd "$(dirname "$0")/.."
[ -d vendor/pokepinballrs ] || git clone --depth 1 https://github.com/pret/pokepinballrs vendor/pokepinballrs
