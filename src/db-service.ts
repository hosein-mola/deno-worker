import type { RequestHandler, Router } from "express";
import sql from "mssql";
import type { AppConfig } from "./config.js";
import {
  DbWorkerPool,
  type DbConnectionSnapshot,
  type DbQueryParams,
} from "./db-worker-pool.js";
import { HttpError } from "./errors.js";
import { prisma } from "./store/client.js";

type JsonObject = Record<string, unknown>;

type DbConnectionRow = {
  id: string;
  code: string;
  name: string;
  description: string;
  provider: string;
  connectionString: string;
  active: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type QueryParams = DbQueryParams;

const dbConnections = () =>
  (prisma as unknown as { dbConnection: unknown }).dbConnection as {
    findMany(args?: unknown): Promise<DbConnectionRow[]>;
    findUnique(args: unknown): Promise<DbConnectionRow | null>;
    create(args: unknown): Promise<DbConnectionRow>;
    update(args: unknown): Promise<DbConnectionRow>;
    delete(args: unknown): Promise<DbConnectionRow>;
  };

const MAX_QUERY_MS = 30_000;
const MAX_ROWS = 1_000;
const connectionCache = new Map<
  string,
  {
    expiresAt: number;
    value: DbConnectionRow;
  }
>();
let dbWorkerPool: DbWorkerPool | null = null;
let connectionCacheTtlMs = 10_000;

export function configureDbQueryRuntime(
  config: Pick<
    AppConfig,
    | "dbWorkerPoolSize"
    | "dbQueryQueueTimeoutMs"
    | "dbQueryQueueLimit"
    | "dbConnectionCacheTtlMs"
  >,
) {
  connectionCacheTtlMs = config.dbConnectionCacheTtlMs;

  if (dbWorkerPool) return;

  dbWorkerPool = new DbWorkerPool({
    workerCount: config.dbWorkerPoolSize,
    queueTimeoutMs: config.dbQueryQueueTimeoutMs,
    maxQueueSize: config.dbQueryQueueLimit,
    maxQueryMs: MAX_QUERY_MS,
    maxRows: MAX_ROWS,
  });
}

export async function closeDbQueryRuntime() {
  connectionCache.clear();
  const pool = dbWorkerPool;
  dbWorkerPool = null;
  await pool?.close();
}

export function mountDbConnectionApi(router: Router) {
  router.get("/api/process/data/connections", listConnections);
  router.post("/api/process/data/connections", createConnection);
  router.put("/api/process/data/connections/:code", updateConnection);
  router.delete("/api/process/data/connections/:code", deleteConnection);
  router.post("/api/process/data/connections/test", testConnectionString);
  router.post("/api/process/data/connections/:code/test", testSavedConnection);
}

export async function querySavedConnection(
  code: string,
  query: string,
  params?: QueryParams,
  timeoutMs?: number,
) {
  const connection = await loadActiveConnectionCached(code);
  return executeQuery(connection, query, params, timeoutMs);
}

export async function testSavedConnectionByCode(code: string) {
  const connection = await loadConnection(code);
  const result = await testMssqlConnection(connection.connectionString);
  await dbConnections().update({
    where: { code: connection.code },
    data: {
      lastTestAt: new Date(),
      lastTestOk: result.ok,
      lastTestMessage: result.message,
    },
  });
  return result;
}

const listConnections: RequestHandler = async (_req, res) => {
  const connections = await dbConnections().findMany({
    orderBy: [{ updatedAt: "desc" }],
  });
  res.json({
    connections: connections.map(toConnectionDto),
  });
};

const createConnection: RequestHandler = async (req, res) => {
  const body = requireObject(req.body);
  const code = requireCode(body.code);
  const connectionString = requireConnectionString(body.connectionString);
  const row = await dbConnections().create({
    data: {
      code,
      name: requireString(body.name, "name", 120, 1),
      description:
        body.description === undefined
          ? ""
          : requireString(body.description, "description", 1_000),
      provider: "mssql",
      connectionString,
      active: body.active === undefined ? true : requireBoolean(body.active, "active"),
    },
  });
  res.status(201).json({ connection: toConnectionDto(row) });
};

const updateConnection: RequestHandler = async (req, res) => {
  const code = requireCode(routeParam(req.params.code));
  const body = requireObject(req.body);
  const data: JsonObject = {};

  if (body.name !== undefined) data.name = requireString(body.name, "name", 120, 1);
  if (body.description !== undefined) {
    data.description = requireString(body.description, "description", 1_000);
  }
  if (body.connectionString !== undefined) {
    data.connectionString = requireConnectionString(body.connectionString);
    invalidateConnection(code);
  }
  if (body.active !== undefined) {
    data.active = requireBoolean(body.active, "active");
    invalidateConnection(code);
  }

  const row = await dbConnections().update({ where: { code }, data });
  res.json({ connection: toConnectionDto(row) });
};

const deleteConnection: RequestHandler = async (req, res) => {
  const code = requireCode(routeParam(req.params.code));
  invalidateConnection(code);
  await dbConnections().delete({ where: { code } });
  res.json({ success: true });
};

const testConnectionString: RequestHandler = async (req, res) => {
  const body = requireObject(req.body);
  const result = await testMssqlConnection(
    requireConnectionString(body.connectionString),
  );
  res.status(result.ok ? 200 : 400).json(result);
};

const testSavedConnection: RequestHandler = async (req, res) => {
  const result = await testSavedConnectionByCode(requireCode(routeParam(req.params.code)));
  res.status(result.ok ? 200 : 400).json(result);
};

async function executeQuery(
  connection: DbConnectionRow,
  query: string,
  params?: QueryParams,
  timeoutMs?: number,
) {
  const trimmedQuery = requireString(query, "query", 100_000, 1);
  validateParams(params);

  return getDbWorkerPool().query({
    connection: toConnectionSnapshot(connection),
    query: trimmedQuery,
    params,
    timeoutMs,
  });
}

async function testMssqlConnection(connectionString: string) {
  const startedAt = Date.now();
  const pool = new sql.ConnectionPool(createMssqlConfig(connectionString, 10_000));
  try {
    await pool.connect();
    const request = pool.request();
    const result = await request.query("SELECT 1 AS ok");
    return {
      ok: true,
      message: "Connection successful",
      durationMs: Date.now() - startedAt,
      sample: result.recordset?.[0] ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await pool.close().catch(() => null);
  }
}

function createMssqlConfig(connectionString: string, requestTimeout: number) {
  return {
    ...sql.ConnectionPool.parseConnectionString(connectionString),
    requestTimeout,
  };
}

async function loadActiveConnection(code: string) {
  const connection = await loadConnection(code);
  if (!connection.active) throw new HttpError(400, `DB connection is inactive: ${code}`);
  return connection;
}

async function loadActiveConnectionCached(code: string) {
  if (connectionCacheTtlMs > 0) {
    const cached = connectionCache.get(code);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  const connection = await loadActiveConnection(code);

  if (connectionCacheTtlMs > 0) {
    connectionCache.set(code, {
      expiresAt: Date.now() + connectionCacheTtlMs,
      value: connection,
    });
  }

  return connection;
}

async function loadConnection(code: string) {
  const connection = await dbConnections().findUnique({ where: { code } });
  if (!connection) throw new HttpError(404, `DB connection not found: ${code}`);
  if (connection.provider !== "mssql") {
    throw new HttpError(400, `Unsupported DB provider: ${connection.provider}`);
  }
  return connection;
}

function validateParams(params: QueryParams) {
  if (params === undefined || params === null) return;

  if (Array.isArray(params)) {
    return;
  }

  if (typeof params !== "object") {
    throw new HttpError(400, "bind data must be an array, object, or null");
  }

  for (const [key, value] of Object.entries(params)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new HttpError(400, `Invalid bind parameter name: ${key}`);
    }
  }
}

function getDbWorkerPool() {
  if (!dbWorkerPool) {
    dbWorkerPool = new DbWorkerPool({
      workerCount: 4,
      queueTimeoutMs: 5_000,
      maxQueueSize: 1_000,
      maxQueryMs: MAX_QUERY_MS,
      maxRows: MAX_ROWS,
    });
  }

  return dbWorkerPool;
}

function invalidateConnection(code: string) {
  connectionCache.delete(code);
  dbWorkerPool?.closeConnection(code);
}

function toConnectionSnapshot(connection: DbConnectionRow): DbConnectionSnapshot {
  return {
    code: connection.code,
    provider: connection.provider,
    connectionString: connection.connectionString,
  };
}

function toConnectionDto(row: DbConnectionRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    provider: row.provider,
    active: row.active,
    connectionStringPreview: redactConnectionString(row.connectionString),
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestOk: row.lastTestOk,
    lastTestMessage: row.lastTestMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function redactConnectionString(value: string) {
  return value
    .replace(/(password|pwd)\s*=\s*([^;]+)/gi, "$1=******")
    .replace(/(user id|uid)\s*=\s*([^;]+)/gi, "$1=******");
}

function requireObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Invalid request");
  }
  return value as JsonObject;
}

function routeParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function requireString(value: unknown, name: string, max: number, min = 0) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return value.trim();
}

function requireCode(value: unknown) {
  const code = requireString(value, "code", 64, 2);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(code)) {
    throw new HttpError(400, "code must start with a letter and contain only letters, numbers, _ or -");
  }
  return code;
}

function requireConnectionString(value: unknown) {
  const connectionString = requireString(value, "connectionString", 4_000, 10);
  if (!/(server|data source)\s*=/i.test(connectionString)) {
    throw new HttpError(400, "connectionString must include Server or Data Source");
  }
  return connectionString;
}

function requireBoolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new HttpError(400, `${name} must be a boolean`);
  return value;
}
