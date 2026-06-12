#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://localhost:3000/run}"
DURATION="${2:-30s}"

echo "Testing $URL"
echo "Duration per test: $DURATION"
echo

make_payload() {
  local id="$1"
  local sleep_ms="$2"

  cat <<JSON
{
  "bundle": {
    "name": "index",
    "version": "1.0.$id",
    "code": "const sleep = ms => new Promise(r => setTimeout(r, ms)); export async function run(input, ctx) { const start = Date.now(); await sleep(input.sleepMs); return { ok: true, elapsedMs: Date.now() - start, input }; }"
  },
  "functionName": "run",
  "data": {
    "requestId": "$id",
    "x": $id,
    "sleepMs": $sleep_ms,
    "text": "realistic payload with some extra data"
  },
  "permissions": {
    "net": false
  },
  "timeoutMs": 120
}
JSON
}

echo "Warmup..."
hey \
  -z 10s \
  -c 5 \
  -m POST \
  -H "Content-Type: application/json" \
  -d "$(make_payload warmup 300)" \
  "$URL" > /dev/null

echo
printf "%-12s %-12s %-12s %-12s %-12s %-12s %-12s\n" \
  "Concurrency" "Req/sec" "Avg" "P50" "P95" "P99" "Errors"

printf "%-12s %-12s %-12s %-12s %-12s %-12s %-12s\n" \
  "-----------" "-------" "---" "---" "---" "---" "------"

for C in 1 5 10 25 50 100 200; do
  ID="$(date +%s%N)"

  # Simulate mostly 300ms work, sometimes slower.
  if (( C >= 100 )); then
    SLEEP_MS=500
  else
    SLEEP_MS=300
  fi

  OUT=$(hey \
    -z "$DURATION" \
    -c "$C" \
    -m POST \
    -H "Content-Type: application/json" \
    -d "$(make_payload "$ID" "$SLEEP_MS")" \
    "$URL")

  RPS=$(echo "$OUT" | awk '/Requests\/sec:/ {print $2}')
  AVG=$(echo "$OUT" | awk '/Average:/ {print $2 "s"}')
  P50=$(echo "$OUT" | awk '$1=="50%" {print $3 "s"}')
  P95=$(echo "$OUT" | awk '$1=="95%" {print $3 "s"}')
  P99=$(echo "$OUT" | awk '$1=="99%" {print $3 "s"}')
  ERRORS=$(echo "$OUT" | awk '/Non-2xx or 3xx responses:/ {print $5}')

  printf "%-12s %-12s %-12s %-12s %-12s %-12s %-12s\n" \
    "$C" \
    "${RPS:-0}" \
    "${AVG:-N/A}" \
    "${P50:-N/A}" \
    "${P95:-N/A}" \
    "${P99:-N/A}" \
    "${ERRORS:-0}"
done