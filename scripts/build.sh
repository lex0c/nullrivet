#!/usr/bin/env bash
# Builds a standalone executable.
#
#   scripts/build.sh [target] [outfile]
#
# target is a Bun compile target such as bun-linux-x64 (default: this machine).
#
# The grep worker is a second entry point; the grep tool finds it inside the executable by its path
# relative to src/, so the entry points must keep that layout. The executable does not load .env or bunfig.toml from the directory it
# runs in: a repository must not be able to configure the agent or preload code into it.
set -euo pipefail

target="${1:-}"
outfile="${2:-dist/nullrivet}"

args=(
  build src/main.ts src/tools/grep-worker.ts
  --compile --minify
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig
  --outfile "$outfile"
)
if [[ -n "$target" ]]; then
  args+=(--target "$target")
fi

bun "${args[@]}"
