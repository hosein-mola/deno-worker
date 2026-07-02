type DenoPoolJob = {
  jobId: string;
  code: string;
  codeName: string;
  codeVersion: string;
  functionName: string;
  data: unknown;
  args: unknown[];
  timeoutMs: number;
};

type DbQueryResponseMessage = {
  type: "db.response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    type: string;
    message: string;
    retryable: boolean;
  };
};

type WorkerGlobal = typeof globalThis & {
  onmessage:
    | ((event: MessageEvent<DenoPoolJob | DbQueryResponseMessage>) => void | Promise<void>)
    | null;
  postMessage: (value: unknown) => void;
};

type LogItem = {
  level: "info" | "warn" | "error" | "debug";
  message: string;
};

const maxLogs = 500;
const maxLogMessageLength = 4_000;
const maxOutputBytes = 512 * 1024;
const maxOutputDepth = 25;
const maxOutputArrayItems = 1_000;
const maxOutputObjectKeys = 250;
const maxModuleCacheEntries = 500;
const workerSelf = self as unknown as WorkerGlobal;
const moduleCache = new Map<string, Promise<Record<string, unknown>>>();
const pendingDbQueries = new Map<
  string,
  {
    jobId: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function toBase64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    const type = classifyUserError(error);

    return {
      type,
      message: error.message,
      stack: error.stack,
      retryable: false,
    };
  }

  return {
    type: "USER_CODE_THROWN_VALUE",
    message: String(error),
    retryable: false,
  };
}

function safeStringify(value: unknown) {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(toJsonSafe(value));
  } catch {
    return String(value);
  }
}

function toJsonSafe(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (depth >= maxOutputDepth) return "[MaxDepth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value instanceof RegExp) return String(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, maxOutputArrayItems)
      .map((item) => toJsonSafe(item, seen, depth + 1));
    if (value.length > maxOutputArrayItems) {
      items.push(`...[${value.length - maxOutputArrayItems} more items]`);
    }
    return items;
  }

  if (value instanceof Map) {
    const entries: Record<string, unknown> = {};
    let index = 0;
    for (const [key, item] of value.entries()) {
      if (index >= maxOutputObjectKeys) {
        entries.__truncated = `...[${value.size - maxOutputObjectKeys} more entries]`;
        break;
      }
      entries[String(key)] = toJsonSafe(item, seen, depth + 1);
      index += 1;
    }
    return entries;
  }

  if (value instanceof Set) {
    const items: unknown[] = [];
    let index = 0;
    for (const item of value) {
      if (index >= maxOutputArrayItems) {
        items.push(`...[${value.size - maxOutputArrayItems} more items]`);
        break;
      }
      items.push(toJsonSafe(item, seen, depth + 1));
      index += 1;
    }
    return items;
  }

  const classLike = serializeClassLike(value, seen, depth);
  if (classLike !== undefined) {
    return classLike;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [index, [key, item]] of entries.entries()) {
    if (index >= maxOutputObjectKeys) {
      output.__truncated = `...[${entries.length - maxOutputObjectKeys} more properties]`;
      break;
    }
    output[key] = toJsonSafe(item, seen, depth + 1);
  }
  return output;
}

function serializeClassLike(
  value: object,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    return undefined;
  }

  const candidate = value as {
    format?: () => unknown;
    toJSON?: () => unknown;
    toString?: () => string;
  };

  if (typeof candidate.toJSON === "function") {
    try {
      return toJsonSafe(candidate.toJSON.call(value), seen, depth + 1);
    } catch {
      // Fall through to other compact representations.
    }
  }

  if (typeof candidate.format === "function") {
    try {
      return toJsonSafe(candidate.format.call(value), seen, depth + 1);
    } catch {
      // Fall through to toString/own property serialization.
    }
  }

  if (typeof candidate.toString === "function") {
    try {
      const text = candidate.toString.call(value);
      if (text && text !== "[object Object]") return text;
    } catch {
      // Fall through to own property serialization.
    }
  }

  return undefined;
}

function classifyUserError(error: Error) {
  if (error.name === "NotCapable" || error.message.includes("Requires")) {
    return "PERMISSION_ERROR";
  }

  return "USER_CODE_ERROR";
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + "...[truncated]";
}

function assertOutputSize(value: unknown) {
  const serialized = safeStringify(value);
  const byteLength = new TextEncoder().encode(serialized).length;

  if (byteLength > maxOutputBytes) {
    throw new Error(`Output exceeded ${maxOutputBytes} bytes`);
  }
}

function getUserModule(job: DenoPoolJob) {
  const cacheKey = `${job.codeName}\0${job.codeVersion}\0${job.code}`;
  const cached = moduleCache.get(cacheKey);
  if (cached) return cached;

  if (moduleCache.size >= maxModuleCacheEntries) {
    const oldestKey = moduleCache.keys().next().value;
    if (oldestKey !== undefined) moduleCache.delete(oldestKey);
  }

  const moduleUrl =
    "data:application/javascript;base64," + toBase64Utf8(job.code);
  const modulePromise = import(moduleUrl) as Promise<Record<string, unknown>>;
  moduleCache.set(cacheKey, modulePromise);
  return modulePromise;
}

function finishJob(jobId: string, value: unknown) {
  workerSelf.postMessage(value);
  clearPendingDbQueriesForJob(jobId);
}

function clearPendingDbQueriesForJob(jobId: string) {
  for (const [requestId, pending] of pendingDbQueries.entries()) {
    if (pending.jobId !== jobId) continue;
    clearTimeout(pending.timer);
    pendingDbQueries.delete(requestId);
  }
}

function createApi(job: DenoPoolJob) {
  return {
    db: {
      query: (
        code: string,
        query: string,
        params?: unknown[] | Record<string, unknown> | null,
      ) => {
        if (typeof code !== "string" || !code.trim()) {
          return Promise.reject(new Error("Connection code is required"));
        }
        if (typeof query !== "string" || !query.trim()) {
          return Promise.reject(new Error("SQL query is required"));
        }

        const requestId = crypto.randomUUID();
        const timeoutMs = Math.max(100, Math.min(job.timeoutMs, 30_000));

        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingDbQueries.delete(requestId);
            reject(new Error(`DB query timed out after ${timeoutMs}ms`));
          }, timeoutMs);

          pendingDbQueries.set(requestId, {
            jobId: job.jobId,
            resolve,
            reject,
            timer,
          });
        });

        workerSelf.postMessage({
          type: "db.query",
          requestId,
          jobId: job.jobId,
          code,
          query,
          params: params ?? null,
          timeoutMs,
        });

        return promise;
      },
    },
  };
}

function handleDbResponse(message: DbQueryResponseMessage) {
  const pending = pendingDbQueries.get(message.requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingDbQueries.delete(message.requestId);

  if (message.ok) {
    pending.resolve(message.result);
    return;
  }

  const error = new Error(message.error?.message ?? "DB query failed");
  error.name = message.error?.type ?? "DB_QUERY_ERROR";
  pending.reject(error);
}

workerSelf.onmessage = async (event: MessageEvent<DenoPoolJob | DbQueryResponseMessage>) => {
  if (isDbResponse(event.data)) {
    handleDbResponse(event.data);
    return;
  }

  const job = event.data;
  const startedAt = Date.now();
  const logs: LogItem[] = [];

  const pushLog = (level: LogItem["level"], args: unknown[]) => {
    if (logs.length >= maxLogs) return;

    logs.push({
      level,
      message: truncate(args.map(safeStringify).join(" "), maxLogMessageLength),
    });
  };

  globalThis.console = {
    ...globalThis.console,
    log: (...args: unknown[]) => pushLog("info", args),
    info: (...args: unknown[]) => pushLog("info", args),
    warn: (...args: unknown[]) => pushLog("warn", args),
    error: (...args: unknown[]) => pushLog("error", args),
    debug: (...args: unknown[]) => pushLog("debug", args),
  };

  try {
    const mod = await getUserModule(job);
    const fn = mod[job.functionName];

    if (typeof fn !== "function") {
      finishJob(job.jobId, {
        jobId: job.jobId,
        success: false,
        error: {
          type: "FUNCTION_NOT_FOUND",
          message: `Function "${job.functionName}" was not exported by user code`,
          retryable: false,
        },
        logs,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const api = createApi(job);
    (globalThis as unknown as { api: typeof api }).api = api;

    const ctx = {
      jobId: job.jobId,
      codeName: job.codeName,
      codeVersion: job.codeVersion,
      api,
      log: (...args: unknown[]) => pushLog("info", args),
      warn: (...args: unknown[]) => pushLog("warn", args),
      error: (...args: unknown[]) => pushLog("error", args),
    };

    const output = toJsonSafe(await Promise.resolve(
      fn(job.data, ctx, ...(job.args ?? [])),
    ));

    try {
      assertOutputSize(output);
    } catch (error) {
      finishJob(job.jobId, {
        jobId: job.jobId,
        success: false,
        error: {
          type: "OUTPUT_TOO_LARGE",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
        logs,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    finishJob(job.jobId, {
      jobId: job.jobId,
      success: true,
      output,
      logs,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    finishJob(job.jobId, {
      jobId: job.jobId,
      success: false,
      error: serializeError(error),
      logs,
      durationMs: Date.now() - startedAt,
    });
  }
};

function isDbResponse(value: unknown): value is DbQueryResponseMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "db.response"
  );
}
