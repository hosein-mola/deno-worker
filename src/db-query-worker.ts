import { parentPort } from "node:worker_threads";
import sql from "mssql";

type DbConnectionSnapshot = {
  code: string;
  provider: string;
  connectionString: string;
};

type DbQueryParams =
  | unknown[]
  | Record<string, unknown>
  | null
  | undefined;

type DbWorkerQueryMessage = {
  type: "query";
  id: string;
  connection: DbConnectionSnapshot;
  query: string;
  params: DbQueryParams;
  maxQueryMs: number;
  maxRows: number;
};

type DbWorkerCloseConnectionMessage = {
  type: "closeConnection";
  code: string;
};

type DbWorkerCloseAllMessage = {
  type: "closeAll";
};

type DbWorkerMessage =
  | DbWorkerQueryMessage
  | DbWorkerCloseConnectionMessage
  | DbWorkerCloseAllMessage;

const pools = new Map<string, Promise<sql.ConnectionPool>>();

if (!parentPort) {
  throw new Error("db-query-worker requires worker_threads parentPort");
}

parentPort.on("message", (message: DbWorkerMessage) => {
  void handleMessage(message);
});

async function handleMessage(message: DbWorkerMessage) {
  if (message.type === "closeConnection") {
    closeConnectionPools(message.code);
    return;
  }

  if (message.type === "closeAll") {
    await closeAllPools();
    return;
  }

  try {
    const result = await executeQuery(message);
    parentPort!.postMessage({
      id: message.id,
      ok: true,
      result,
    });
  } catch (error) {
    parentPort!.postMessage({
      id: message.id,
      ok: false,
      error: serializeError(error),
    });
  }
}

async function executeQuery(message: DbWorkerQueryMessage) {
  if (message.connection.provider !== "mssql") {
    throw new DbQueryWorkerError(
      "UNSUPPORTED_DB_PROVIDER",
      `Unsupported DB provider: ${message.connection.provider}`,
      false,
    );
  }

  const pool = await getPool(message.connection, message.maxQueryMs);
  const request = pool.request();
  bindParams(request, message.params);

  const result = await request.query(message.query);
  const rows = result.recordset ?? [];

  return {
    rows: rows.slice(0, message.maxRows),
    rowCount: rows.length,
    rowsTruncated: rows.length > message.maxRows,
    recordsAffected: result.rowsAffected,
  };
}

async function getPool(
  connection: DbConnectionSnapshot,
  requestTimeout: number,
) {
  const key = poolKey(connection);
  const existing = pools.get(key);
  if (existing) return existing;

  const poolPromise = new sql.ConnectionPool(
    createMssqlConfig(connection.connectionString, requestTimeout),
  )
    .connect()
    .catch((error: unknown) => {
      pools.delete(key);
      throw error;
    });

  pools.set(key, poolPromise);
  return poolPromise;
}

function createMssqlConfig(connectionString: string, requestTimeout: number) {
  return {
    ...sql.ConnectionPool.parseConnectionString(connectionString),
    requestTimeout,
  };
}

function bindParams(request: sql.Request, params: DbQueryParams) {
  if (params === undefined || params === null) return;

  if (Array.isArray(params)) {
    params.forEach((value, index) => request.input(`p${index}`, value));
    return;
  }

  if (typeof params !== "object") {
    throw new DbQueryWorkerError(
      "INVALID_DB_PARAMS",
      "bind data must be an array, object, or null",
      false,
    );
  }

  for (const [key, value] of Object.entries(params)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new DbQueryWorkerError(
        "INVALID_DB_PARAMS",
        `Invalid bind parameter name: ${key}`,
        false,
      );
    }
    request.input(key, value);
  }
}

function closeConnectionPools(code: string) {
  for (const [key, poolPromise] of pools.entries()) {
    if (!key.startsWith(`${code}\0`)) continue;

    pools.delete(key);
    void poolPromise.then((pool) => pool.close()).catch(() => undefined);
  }
}

async function closeAllPools() {
  const poolPromises = [...pools.values()];
  pools.clear();
  await Promise.all(
    poolPromises.map((poolPromise) =>
      poolPromise.then((pool) => pool.close()).catch(() => undefined),
    ),
  );
}

function poolKey(connection: DbConnectionSnapshot) {
  return `${connection.code}\0${connection.connectionString}`;
}

class DbQueryWorkerError extends Error {
  public readonly type: string;
  public readonly retryable: boolean;

  constructor(
    type: string,
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.type = type;
    this.retryable = retryable;
    this.name = type;
  }
}

function serializeError(error: unknown) {
  if (error instanceof DbQueryWorkerError) {
    return {
      type: error.type,
      message: error.message,
      stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
      retryable: error.retryable,
    };
  }

  if (error instanceof Error) {
    return {
      type: error.name || "DB_QUERY_ERROR",
      message: error.message,
      stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
      retryable: isRetryableError(error),
    };
  }

  return {
    type: "DB_QUERY_ERROR",
    message: String(error),
    retryable: false,
  };
}

function isRetryableError(error: Error) {
  const code = (error as Error & { code?: unknown }).code;
  if (
    code === "ETIMEOUT" ||
    code === "ESOCKET" ||
    code === "ECONNCLOSED" ||
    code === "ECONNRESET"
  ) {
    return true;
  }

  return /timeout|socket|connection closed|connection reset/i.test(error.message);
}
