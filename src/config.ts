export type AppConfig = {
  port: number;
  poolSize: number;
  maxRequestBytes: number;
  queueTimeoutMs: number;
  shutdownGraceMs: number;
  runnerResponseGraceMs: number;
  dbWorkerPoolSize: number;
  dbQueryQueueTimeoutMs: number;
  dbQueryQueueLimit: number;
  dbConnectionCacheTtlMs: number;
  allowInheritPermissions: boolean;
  openApiEnabled: boolean;
  openApiJsonPath: string;
  swaggerUiPath: string;
  swaggerUiCdnUrl: string;
  publicBaseUrl?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: readInteger(env.PORT, 3001, { min: 1, max: 65535 }),
    poolSize: readInteger(env.DENO_POOL_SIZE, 4, { min: 1, max: 128 }),
    maxRequestBytes: readInteger(env.MAX_REQUEST_BYTES, 1_048_576, {
      min: 1024,
      max: 50 * 1024 * 1024,
    }),
    queueTimeoutMs: readInteger(env.DENO_QUEUE_TIMEOUT_MS, 5_000, {
      min: 0,
      max: 300_000,
    }),
    shutdownGraceMs: readInteger(env.SHUTDOWN_GRACE_MS, 30_000, {
      min: 1_000,
      max: 300_000,
    }),
    runnerResponseGraceMs: readInteger(env.RUNNER_RESPONSE_GRACE_MS, 1_000, {
      min: 0,
      max: 30_000,
    }),
    dbWorkerPoolSize: readInteger(env.DB_WORKER_POOL_SIZE, 4, {
      min: 1,
      max: 128,
    }),
    dbQueryQueueTimeoutMs: readInteger(env.DB_QUERY_QUEUE_TIMEOUT_MS, 5_000, {
      min: 0,
      max: 300_000,
    }),
    dbQueryQueueLimit: readInteger(env.DB_QUERY_QUEUE_LIMIT, 1_000, {
      min: 1,
      max: 100_000,
    }),
    dbConnectionCacheTtlMs: readInteger(env.DB_CONNECTION_CACHE_TTL_MS, 10_000, {
      min: 0,
      max: 300_000,
    }),
    allowInheritPermissions:
      env.ALLOW_INHERIT_PERMISSIONS === "true" || env.NODE_ENV !== "production",
    openApiEnabled: env.OPENAPI_ENABLED !== "false",
    openApiJsonPath: readPath(env.OPENAPI_JSON_PATH, "/openapi.json"),
    swaggerUiPath: readPath(env.SWAGGER_UI_PATH, "/docs"),
    swaggerUiCdnUrl:
      env.SWAGGER_UI_CDN_URL ?? "https://unpkg.com/swagger-ui-dist@5",
    publicBaseUrl: env.PUBLIC_BASE_URL,
  };
}

function readInteger(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
) {
  const parsed = Number(value ?? fallback);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(parsed)));
}

function readPath(value: string | undefined, fallback: string) {
  const path = value?.trim() || fallback;
  return path.startsWith("/") ? path : `/${path}`;
}
