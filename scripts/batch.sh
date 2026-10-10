#!/usr/bin/env bash
# Runs scenarios headless in parallel, each on its own fresh anvil node, and writes one log per scenario.
#   scripts/batch.sh OUTDIR scenario[:years] ...        e.g. scripts/batch.sh /tmp/runs fifteen:60 challenges:40
set -uo pipefail
cd "$(dirname "$0")/.."
out=$1; shift
mkdir -p "$out"
port=8600
pids=()
for spec in "$@"; do
  name=${spec%%:*}; years=${spec#*:}; [ "$years" = "$spec" ] && years=60
  port=$((port + 1))
  (
    anvil --auto-impersonate --timestamp 1767225600 --port "$port" --gas-limit 100000000 --prune-history 64 --silent &
    node=$!
    sleep 1
    RPC="http://127.0.0.1:$port" SCENARIO="$name" SEED="${SEED:-1}" YEARS="$years" npx tsx scripts/headless.ts \
      2>&1 | grep -v "^\s*{ type\|^\s*\]\|^\s*\[" > "$out/$name.log"
    kill "$node" 2>/dev/null
  ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
for f in "$out"/*.log; do
  echo "== $(basename "$f" .log)"
  grep -E "^invariant failures|^anomalies:|finished=" "$f"
  sed -n '/^anomalies:/,/^{"/p' "$f" | grep -v "^anomalies:\|^{\"" | head -12
done
