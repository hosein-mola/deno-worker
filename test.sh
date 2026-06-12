#!/usr/bin/env bash
set -e

BASE="http://localhost:3000"

echo "Health"
curl -s "$BASE/health" | jq

echo "Success"
curl -s -X POST "$BASE/run" \
  -H 'content-type: application/json' \
  -d '{
    "bundle": {
      "name": "smoke-success",
      "version": "1.0.0",
      "code": "export function run(input, ctx) { ctx.log(\"ok\"); return { ok: true, input }; }"
    },
    "data": { "x": 1 },
    "permissions": "none",
    "timeoutMs": 5000
  }' | jq

echo "Error"
curl -s -X POST "$BASE/run" \
  -H 'content-type: application/json' \
  -d '{
    "bundle": {
      "name": "smoke-error",
      "version": "1.0.0",
      "code": "export function run() { throw new Error(\"boom\"); }"
    },
    "data": {},
    "permissions": "none",
    "timeoutMs": 5000
  }' | jq

echo "Timeout"
curl -s -X POST "$BASE/run" \
  -H 'content-type: application/json' \
  -d '{
    "bundle": {
      "name": "smoke-timeout",
      "version": "1.0.0",
      "code": "export function run() { while (true) {} }"
    },
    "data": {},
    "permissions": "none",
    "timeoutMs": 1000
  }' | jq