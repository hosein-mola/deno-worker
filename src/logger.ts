type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

export type LogEntry = {
  ts: string;
  level: LogLevel;
  event: string;
  service: "deno-worker";
  fields: LogFields;
};

type LogWriter = (entry: LogEntry) => Promise<void> | void;

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = normalizeLevel(process.env.LOG_LEVEL);
const consoleEnabled = process.env.NODE_ENV !== "production";
const maxBufferedLogs = 10_000;

let logWriter: LogWriter | null = null;
let logQueue: LogEntry[] = [];
let drainPromise: Promise<void> | null = null;

export function debug(event: string, fields: LogFields = {}) {
  writeLog("debug", event, fields);
}

export function info(event: string, fields: LogFields = {}) {
  writeLog("info", event, fields);
}

export function warn(event: string, fields: LogFields = {}) {
  writeLog("warn", event, fields);
}

export function error(event: string, fields: LogFields = {}) {
  writeLog("error", event, fields);
}

export function registerLogWriter(writer: LogWriter) {
  logWriter = writer;
  void drainLogQueue();
}

export async function flushLogs() {
  await drainLogQueue();
}

export function serializeLogError(input: unknown) {
  if (input instanceof Error) {
    return {
      name: input.name,
      message: input.message,
      stack: process.env.NODE_ENV === "production" ? undefined : input.stack,
    };
  }

  return {
    message: String(input),
  };
}

function writeLog(level: LogLevel, event: string, fields: LogFields) {
  if (levels[level] < levels[configuredLevel]) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    service: "deno-worker",
    fields,
  };

  enqueueLog(entry);

  if (consoleEnabled) {
    const line = JSON.stringify({
      ts: entry.ts,
      level,
      event,
      service: entry.service,
      ...fields,
    });

    if (level === "error") {
      console.error(line);
      return;
    }

    if (level === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  }
}

function enqueueLog(entry: LogEntry) {
  if (logQueue.length >= maxBufferedLogs) {
    logQueue = logQueue.slice(Math.floor(maxBufferedLogs / 2));
  }

  logQueue.push(entry);
  void drainLogQueue();
}

function drainLogQueue() {
  if (!logWriter || logQueue.length === 0) {
    return Promise.resolve();
  }

  if (drainPromise) return drainPromise;

  const writer = logWriter;

  drainPromise = (async () => {
    while (logQueue.length > 0) {
      const entry = logQueue.shift()!;

      try {
        await writer(entry);
      } catch (error) {
        if (consoleEnabled) {
          console.error(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: "error",
              event: "logger.db_write_failed",
              service: "deno-worker",
              error: serializeLogError(error),
            }),
          );
        }
      }
    }
  })().finally(() => {
    drainPromise = null;
    if (logWriter && logQueue.length > 0) {
      void drainLogQueue();
    }
  });

  return drainPromise;
}

function normalizeLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }

  return "info";
}
