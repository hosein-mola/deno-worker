#!/usr/bin/env bash

set -uo pipefail

BASE="${BASE:-http://localhost:3000}"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"

PASSED=0
FAILED=0
WARNED=0

GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[1;33m"
BLUE="\033[0;34m"
RESET="\033[0m"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo -e "${RED}Missing command:${RESET} $1"
    exit 1
  fi
}

pass() {
  echo -e "${GREEN}PASS${RESET} $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo -e "${RED}FAIL${RESET} $1"
  FAILED=$((FAILED + 1))
}

warn() {
  echo -e "${YELLOW}WARN${RESET} $1"
  WARNED=$((WARNED + 1))
}

section() {
  echo
  echo -e "${BLUE}== $1 ==${RESET}"
}

assert_jq() {
  local name="$1"
  local body="$2"
  local expr="$3"

  if echo "$body" | jq -e "$expr" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name"
    echo "Expected jq:"
    echo "  $expr"
    echo "Body:"
    echo "$body" | jq . 2>/dev/null || echo "$body"
  fi
}

post_run() {
  local payload="$1"
  local body_file
  local status

  body_file="$(mktemp)"

  status="$(
    curl -sS \
      -o "$body_file" \
      -w "%{http_code}" \
      -X POST "$BASE/run" \
      -H 'content-type: application/json' \
      -d "$payload" || true
  )"

  LAST_STATUS="$status"
  LAST_BODY="$(cat "$body_file")"

  rm -f "$body_file"
}

need_cmd curl
need_cmd jq

section "Health"

HEALTH_BODY="$(curl -sS "$BASE/health" || true)"

echo "$HEALTH_BODY" | jq . 2>/dev/null || echo "$HEALTH_BODY"

assert_jq "health endpoint returns ok" "$HEALTH_BODY" '.ok == true'
assert_jq "health endpoint has poolSize" "$HEALTH_BODY" '.poolSize | type == "number"'

section "Success: sync user code"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-sync\",
    \"version\": \"1.0.0\",
    \"code\": \"export function run(input, ctx) { ctx.log(\\\"sync ok\\\"); return { ok: true, input }; }\"
  },
  \"functionName\": \"run\",
  \"data\": {
    \"x\": 1
  },
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq .

assert_jq "sync code succeeds" "$LAST_BODY" '.success == true'
assert_jq "sync output is correct" "$LAST_BODY" '.output.ok == true and .output.input.x == 1'
assert_jq "sync logs captured" "$LAST_BODY" '.logs[0].message == "sync ok"'

section "Success: async user code"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-async\",
    \"version\": \"1.0.0\",
    \"code\": \"export async function run(input, ctx) { ctx.log(\\\"async start\\\"); await new Promise(r => setTimeout(r, 200)); ctx.log(\\\"async end\\\"); return { delayed: true, value: input.value }; }\"
  },
  \"functionName\": \"run\",
  \"data\": {
    \"value\": 123
  },
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq .

assert_jq "async code succeeds" "$LAST_BODY" '.success == true'
assert_jq "async output is correct" "$LAST_BODY" '.output.delayed == true and .output.value == 123'
assert_jq "async logs captured" "$LAST_BODY" '.logs | length == 2'

section "Error: thrown user-code error"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-throw\",
    \"version\": \"1.0.0\",
    \"code\": \"export function run() { throw new Error(\\\"boom\\\"); }\"
  },
  \"functionName\": \"run\",
  \"data\": {},
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq .

assert_jq "thrown error returns success false" "$LAST_BODY" '.success == false'
assert_jq "thrown error message is captured" "$LAST_BODY" '.error.message == "boom"'
assert_jq "thrown error is non-retryable" "$LAST_BODY" '.error.retryable == false'

section "Error: missing exported function"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-missing-fn\",
    \"version\": \"1.0.0\",
    \"code\": \"export function other() { return 123; }\"
  },
  \"functionName\": \"run\",
  \"data\": {},
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq .

assert_jq "missing function returns success false" "$LAST_BODY" '.success == false'
assert_jq "missing function error mentions export" "$LAST_BODY" '.error.message | contains("was not exported")'

section "Error: timeout / infinite loop"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-timeout\",
    \"version\": \"1.0.0\",
    \"code\": \"export function run() { while (true) {} }\"
  },
  \"functionName\": \"run\",
  \"data\": {},
  \"permissions\": \"none\",
  \"timeoutMs\": 1000
}"

echo "$LAST_BODY" | jq .

assert_jq "timeout returns success false" "$LAST_BODY" '.success == false'
assert_jq "timeout error type is TIMEOUT" "$LAST_BODY" '.error.type == "TIMEOUT"'
assert_jq "timeout is retryable" "$LAST_BODY" '.error.retryable == true'

section "Permissions: network denied"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-net-denied\",
    \"version\": \"1.0.0\",
    \"code\": \"export async function run() { const res = await fetch(\\\"https://example.com\\\"); return await res.text(); }\"
  },
  \"functionName\": \"run\",
  \"data\": {},
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq .

assert_jq "network denied returns success false" "$LAST_BODY" '.success == false'
assert_jq "network denied has error message" "$LAST_BODY" '.error.message | type == "string"'

section "Permissions: network allowed"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-net-allowed\",
    \"version\": \"1.0.0\",
    \"code\": \"export async function run() { const res = await fetch(\\\"https://example.com\\\"); return { status: res.status, ok: res.ok }; }\"
  },
  \"functionName\": \"run\",
  \"data\": {},
  \"permissions\": {
    \"net\": [\"example.com\"],
    \"read\": false,
    \"write\": false,
    \"env\": false
  },
  \"timeoutMs\": 10000
}"

echo "$LAST_BODY" | jq .

if echo "$LAST_BODY" | jq -e '.success == true and .output.status == 200' >/dev/null 2>&1; then
  pass "network allowed succeeds"
else
  warn "network allowed did not succeed; this can fail if machine has no internet or Deno permission config is wrong"
fi

section "Permissions: env denied"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-env-denied\",
    \"version\": \"1.0.0\",
    \"code\": \"export function run() { return Deno.env.get(\\\"HOME\\\"); }\"
  },
  \"functionName\": \"run\",
  \"data\": {},
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq .

assert_jq "env denied returns success false" "$LAST_BODY" '.success == false'
assert_jq "env denied has error message" "$LAST_BODY" '.error.message | type == "string"'

section "Permissions: read denied"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-read-denied\",
    \"version\": \"1.0.0\",
    \"code\": \"export async function run() { return await Deno.readTextFile(\\\"/etc/passwd\\\"); }\"
  },
  \"functionName\": \"run\",
  \"data\": {},
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq .

assert_jq "read denied returns success false" "$LAST_BODY" '.success == false'
assert_jq "read denied has error message" "$LAST_BODY" '.error.message | type == "string"'

section "Versioning: create version"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-versioned\",
    \"version\": \"1.0.0\",
    \"code\": \"export function run(input) { return { version: \\\"1.0.0\\\", input }; }\"
  },
  \"functionName\": \"run\",
  \"data\": {
    \"first\": true
  },
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq .

assert_jq "versioned code first run succeeds" "$LAST_BODY" '.success == true'
assert_jq "versioned code output is correct" "$LAST_BODY" '.output.version == "1.0.0" and .output.input.first == true'

section "Versioning: run existing codeRef"

post_run "{
  \"codeRef\": {
    \"name\": \"t-${RUN_ID}-versioned\",
    \"version\": \"1.0.0\"
  },
  \"functionName\": \"run\",
  \"data\": {
    \"second\": true
  },
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq .

assert_jq "codeRef run succeeds" "$LAST_BODY" '.success == true'
assert_jq "codeRef output is correct" "$LAST_BODY" '.output.version == "1.0.0" and .output.input.second == true'

section "Versioning: immutable version conflict"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-versioned\",
    \"version\": \"1.0.0\",
    \"code\": \"export function run() { return { changed: true }; }\"
  },
  \"functionName\": \"run\",
  \"data\": {},
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq .

assert_jq "version conflict returns success false" "$LAST_BODY" '.success == false'
assert_jq "version conflict message exists" "$LAST_BODY" '.error.message | contains("Version conflict")'

section "Large logs are capped"

post_run "{
  \"bundle\": {
    \"name\": \"t-${RUN_ID}-logs\",
    \"version\": \"1.0.0\",
    \"code\": \"export function run(input, ctx) { for (let i = 0; i < 1000; i++) ctx.log(\\\"log\\\", i); return { done: true }; }\"
  },
  \"functionName\": \"run\",
  \"data\": {},
  \"permissions\": \"none\",
  \"timeoutMs\": 5000
}"

echo "$LAST_BODY" | jq '.success, .output, (.logs | length)'

assert_jq "large log job succeeds" "$LAST_BODY" '.success == true'
assert_jq "logs are capped at 500" "$LAST_BODY" '.logs | length == 500'

section "Concurrent requests / pool behavior"

CONCURRENCY="${CONCURRENCY:-8}"
TMP_DIR="$(mktemp -d)"

for i in $(seq 1 "$CONCURRENCY"); do
  (
    curl -sS \
      -X POST "$BASE/run" \
      -H 'content-type: application/json' \
      -d "{
        \"bundle\": {
          \"name\": \"t-${RUN_ID}-parallel-$i\",
          \"version\": \"1.0.0\",
          \"code\": \"export async function run(input) { await new Promise(r => setTimeout(r, 1000)); return { id: input.id }; }\"
        },
        \"functionName\": \"run\",
        \"data\": {
          \"id\": $i
        },
        \"permissions\": \"none\",
        \"timeoutMs\": 5000
      }" > "$TMP_DIR/$i.json"
  ) &
done

wait

SUCCESS_COUNT=0
FAIL_COUNT=0

for file in "$TMP_DIR"/*.json; do
  if jq -e '.success == true' "$file" >/dev/null 2>&1; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

echo "concurrency=$CONCURRENCY success=$SUCCESS_COUNT fail=$FAIL_COUNT"

if [ "$SUCCESS_COUNT" -ge 1 ]; then
  pass "concurrent requests produced successful results"
else
  fail "no concurrent request succeeded"
fi

rm -rf "$TMP_DIR"

section "Disk persistence check"

if [ -f "data/deno-worker.db" ]; then
  DB_SIZE="$(wc -c < data/deno-worker.db | tr -d ' ')"
  echo "database bytes: $DB_SIZE"

  if [ "$DB_SIZE" -gt 0 ]; then
    pass "SQLite database exists"
  else
    fail "SQLite database is empty"
  fi
else
  fail "data/deno-worker.db does not exist"
fi

if [ -f "data/deno-worker.db-wal" ]; then
  pass "SQLite WAL file exists"
else
  warn "SQLite WAL file was not present at check time"
fi

section "Summary"

echo -e "${GREEN}Passed:${RESET} $PASSED"
echo -e "${YELLOW}Warnings:${RESET} $WARNED"
echo -e "${RED}Failed:${RESET} $FAILED"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

exit 0
