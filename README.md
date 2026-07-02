# Durable Deno Pool

HTTP service for running user-provided JavaScript/TypeScript code inside a pool of Deno runner processes. Each request can provide code, input data, a function name, permissions, and timeout settings. Code versions and job records are persisted in SQLite through Prisma.

## Prerequisites

- `nvm` is installed; use it to activate a compatible Node.js version before running `npm` commands.
- Node.js 24.x, or any Node.js version compatible with the installed Prisma and TypeScript dependencies.
- npm.
- Deno 2.x available on `PATH`.
- `curl` and `jq` for the shell smoke tests.

Check the important tools:

```sh
nvm version
nvm list
nvm use <version>
node --version
npm --version
deno --version
```

## Fresh Clone Setup

Install dependencies:

```sh
npm install
```

Create `.env` if it does not exist:

```sh
printf 'DATABASE_URL="file:./data/deno-worker.db"\n' > .env
```

Apply the SQLite schema and generate Prisma Client:

```sh
npm run db:migrate
npm run db:generate
```

The migration creates `data/deno-worker.db`. The `data` directory is runtime state and stores the SQLite database only.

Run a type check:

```sh
npm run typecheck
```

Start the service:

```sh
npm run dev
```

The default URL is:

```text
http://localhost:3000
```

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port. |
| `DENO_POOL_SIZE` | `4` | Number of long-lived Deno runner processes. |
| `DENO_QUEUE_TIMEOUT_MS` | `5000` | How long `/run` waits for an idle runner before returning retryable `POOL_BUSY`. |
| `RUNNER_RESPONSE_GRACE_MS` | `1000` | Extra parent-side timeout after a job timeout before killing a stuck runner. |
| `DENO_WORKER_REUSE` | `true` | Reuse warm sandbox workers inside each runner for matching permission profiles. Set to `false` for fresh-worker isolation. |
| `CODE_VERSION_CACHE_TTL_MS` | `60000` | In-memory TTL for loaded code versions used by repeated `codeRef` calls. Set to `0` to disable. |
| `CODE_VERSION_CACHE_MAX` | `1000` | Maximum loaded code versions kept in memory. |
| `DB_WORKER_POOL_SIZE` | `4` | Number of Node worker threads used for saved SQL connection queries requested by sandboxed code. |
| `DB_QUERY_QUEUE_TIMEOUT_MS` | `5000` | How long a SQL query waits for an idle DB worker before returning a retryable DB queue timeout. |
| `DB_QUERY_QUEUE_LIMIT` | `1000` | Maximum queued SQL queries before new SQL work is rejected with a retryable queue-full error. |
| `DB_CONNECTION_CACHE_TTL_MS` | `10000` | Short-lived cache for active saved DB connection metadata; set to `0` to disable. |
| `SHUTDOWN_GRACE_MS` | `30000` | How long shutdown waits for active jobs before killing runners. |
| `MAX_REQUEST_BYTES` | `1048576` | Maximum accepted JSON request body size. |
| `ALLOW_INHERIT_PERMISSIONS` | local only | Set to `true` to allow `"permissions": "inherit"` when `NODE_ENV=production`. |
| `DATABASE_URL` | `file:./data/deno-worker.db` | SQLite database path used by Prisma and the runtime adapter. |
| `LOG_LEVEL` | `info` | Structured log verbosity: `debug`, `info`, `warn`, or `error`. |
| `OPENAPI_ENABLED` | `true` | Set to `false` to disable OpenAPI JSON and Swagger UI routes. |
| `OPENAPI_JSON_PATH` | `/openapi.json` | Route that serves the OpenAPI document. |
| `SWAGGER_UI_PATH` | `/docs` | Route that serves Swagger UI. |
| `SWAGGER_UI_CDN_URL` | `https://unpkg.com/swagger-ui-dist@5` | Base URL for Swagger UI static assets. |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Public server URL advertised in the OpenAPI document. |

Example:

```sh
PORT=3100 DENO_POOL_SIZE=2 npm run dev
```

## API

Swagger UI:

```text
http://localhost:3000/docs
```

OpenAPI JSON:

```sh
curl -s http://localhost:3000/openapi.json | jq
```

### Health

```sh
curl -s http://localhost:3000/health | jq
```

Response:

```json
{
  "ok": true,
  "poolSize": 4
}
```

### Run a Code Bundle

`POST /run` accepts either a new `bundle` or an existing `codeRef`.

```sh
curl -s -X POST http://localhost:3000/run \
  -H 'content-type: application/json' \
  -d '{
    "bundle": {
      "name": "hello",
      "version": "1.0.0",
      "code": "export function run(input, ctx) { ctx.log(\"ok\"); return { ok: true, input }; }"
    },
    "functionName": "run",
    "data": { "x": 1 },
    "permissions": "none",
    "timeoutMs": 5000
  }' | jq
```

The first run stores the code as `hello@1.0.0` in SQLite. Reusing the same name and version with different code returns a version conflict.

### Run an Existing Code Version

```sh
curl -s -X POST http://localhost:3000/run \
  -H 'content-type: application/json' \
  -d '{
    "codeRef": {
      "name": "hello",
      "version": "1.0.0"
    },
    "functionName": "run",
    "data": { "fromRef": true },
    "permissions": "none",
    "timeoutMs": 5000
  }' | jq
```

## Request Shape

```ts
type RunHttpRequest = {
  jobId?: string;
  bundle?: {
    name: string;
    version: string;
    code: string;
  };
  codeRef?: {
    name: string;
    version: string;
  };
  functionName?: string;
  data: unknown;
  args?: unknown[];
  permissions?: PermissionSpec;
  timeoutMs?: number;
};
```

If `functionName` is omitted, the service calls `run`.

`timeoutMs` is clamped between `100` and `60000`.

`jobId` is optional for direct use. If provided, it is treated as an idempotency key:

- same `jobId` and same normalized request after completion returns the stored result
- same `jobId` and same normalized request after a retryable terminal failure requeues the job
- same `jobId` while the original job is queued or running returns retryable `JOB_ALREADY_RUNNING`
- same `jobId` with a different request returns non-retryable `JOB_CONFLICT`

This makes `/run` safe for a future Temporal activity retry loop without requiring Temporal-specific fields.

## Permissions

Permissions are passed to the Deno Worker that runs user code.

Use no permissions:

```json
"permissions": "none"
```

Inherit runner permissions:

```json
"permissions": "inherit"
```

Allow selected permissions:

```json
{
  "permissions": {
    "net": ["example.com"],
    "read": false,
    "write": false,
    "env": false
  }
}
```

Subprocess and FFI are disabled by the runner:

```json
{
  "run": false,
  "ffi": false
}
```

## Persistence

Prisma models:

- `CodeVersion`: stores user code by `name` and `version`, plus SHA-256 hash.
- `JobRecord`: stores request payload, request hash, status, runner id, attempts, result, error type, and lifecycle timestamps.

Job statuses:

```text
queued -> running -> completed | failed | timed_out | crashed | cancelled
```

The service enables SQLite WAL mode and a 5 second busy timeout on startup. SQLite is intended for single-node operation.

Files:

- `prisma/schema.prisma`: Prisma data model.
- `prisma.config.ts`: Prisma 7 config and datasource URL loading.
- `prisma/migrations`: database migrations.
- `data/deno-worker.db`: local SQLite runtime database.

On startup, any job left with `status = "queued"` or `status = "running"` is marked as `crashed` with a retryable `WORKER_PROCESS_CRASHED` result. A later identical `/run` call with the same `jobId` requeues retryable terminal failures instead of returning the stale failure forever.

On `SIGTERM` or `SIGINT`, the HTTP server stops accepting new requests, queued jobs are returned as retryable `POOL_BUSY`, active jobs are allowed to finish until `SHUTDOWN_GRACE_MS`, and remaining runners are killed.

## Temporal Integration Notes

This service does not require Temporal, but it is ready to be called from a future `runCodeActivity`:

- pass a stable `jobId` from the workflow/activity identity
- keep Temporal activity timeout larger than `DENO_QUEUE_TIMEOUT_MS + timeoutMs + RUNNER_RESPONSE_GRACE_MS`
- retry only errors where `error.retryable` is `true`
- avoid retrying non-retryable user-code errors such as `VALIDATION_ERROR`, `CODE_VERSION_CONFLICT`, `FUNCTION_NOT_FOUND`, `USER_CODE_ERROR`, `PERMISSION_ERROR`, and `OUTPUT_TOO_LARGE`
- keep `permissions` defaulted to `"none"` unless the workflow explicitly grants a small allowlist

## Production Readiness

This service is durable enough for local and single-node use, but production needs a few explicit operating decisions:

- Put it behind authentication. `POST /run` executes user-provided code, so do not expose it directly to the public internet.
- Keep default permissions at `"none"` and allowlist permission scopes per tenant or workload. Avoid `"inherit"` for untrusted callers.
- Run the service inside a container or VM with OS-level limits: CPU quota, memory limit, read-only filesystem except `data`, and no host Docker socket.
- Use a process supervisor such as systemd, Docker restart policy, or Kubernetes. Startup recovery already marks interrupted queued/running jobs as retryable `crashed` records.
- Back up `data/deno-worker.db`, or move from SQLite to a managed database before running multiple service replicas. SQLite is not a multi-node queue.
- Set `MAX_REQUEST_BYTES` to the largest code bundle you actually accept. The default is 1 MiB.
- Add external rate limits and concurrency limits per caller. The internal pool rejects work when all Deno runners are busy.
- Send logs to a central collector and alert on `POOL_BUSY`, `TIMEOUT`, `WORKER_PROCESS_CRASHED`, and repeated Deno runner restarts.
- Logs are stored in SQLite `LogRecord` rows. In development they are also printed to the console as JSON lines; in production they are only saved to the database. Log fields include `ts`, `level`, `event`, and contextual fields such as `requestId`, `jobId`, `runnerId`, status, durations, and error metadata. They intentionally do not log user code or input data.
- Keep Deno, Node.js, Prisma, and OS packages patched. User-code execution services have a higher security maintenance burden.
- Add CI checks for `npm run typecheck`, migrations, and smoke tests before deploy.

The current module boundaries are:

- `src/server.ts`: process startup only.
- `src/app.ts`: Express routing, JSON body limits, and response mapping.
- `src/run-service.ts`: `/run` orchestration and job lifecycle.
- `src/deno-pool.ts`: long-lived Deno runner pool.
- `src/store/*`: Prisma client, code-version repository, and job-record repository.
- `src/errors.ts`, `src/config.ts`: shared error and environment helpers.

## Test

Start the service in one terminal:

```sh
npm run dev
```

Run the simple smoke test:

```sh
./test.sh
```

Run the larger behavior test:

```sh
./test2.sh
```

Use a custom URL for tests:

```sh
BASE=http://localhost:3100 ./test2.sh
```

## Development Commands

```sh
npm run dev
npm run start
npm run typecheck
npm run db:migrate
npm run db:generate
```

`npm run start` runs the same server through Node with `tsx` import support.

## Reset Local Database

Stop the service first, then remove the SQLite file and rerun migrations:

```sh
rm -f data/deno-worker.db
npm run db:migrate
```

## Troubleshooting

If Prisma says the client is not generated:

```sh
npm run db:generate
```

If `deno` is not found, install Deno and confirm `deno --version` works in the same shell that starts the Node service.

If port `3000` is already in use:

```sh
PORT=3100 npm run dev
```

If a network permission test fails while using `"net": ["example.com"]`, confirm the machine has internet access. Permission-denied tests should still fail as expected when `permissions` is `"none"`.
# deno-workler
