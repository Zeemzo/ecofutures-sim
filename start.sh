#!/usr/bin/env bash
# Starts the EcoFutures V11 simulator: a local anvil chain (from 1 January 2026; each run starts when you press Start) and the app at http://localhost:5173.
# The app deploys the contracts itself, with whatever configuration you choose on its setup screen.
set -euo pipefail
cd "$(dirname "$0")"

PORT=${ANVIL_PORT:-8545}
if curl -s -o /dev/null -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "http://127.0.0.1:$PORT"; then
  echo "Something is already listening on port $PORT. Stop it, or set ANVIL_PORT." >&2
  exit 1
fi

# inside the contracts repo, build them so the app runs the current code; on its own, the committed artifacts are used
if [ -f ../foundry.toml ]; then
  (cd .. && forge build >/dev/null 2>&1) || { echo "forge build failed: run it in v11/ to see why." >&2; exit 1; }
fi
# --prune-history keeps a few recent states in memory and writes none to disk
anvil --auto-impersonate --timestamp 1767225600 --port "$PORT" --gas-limit 100000000 --prune-history 64 --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null' EXIT
sleep 1

[ -d node_modules ] || npm install
VITE_RPC="http://127.0.0.1:$PORT" npm run dev
