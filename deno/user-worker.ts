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

type WorkerGlobal = typeof globalThis & {
  onmessage: ((event: MessageEvent<DenoPoolJob>) => void | Promise<void>) | null;
  postMessage: (value: unknown) => void;
};

type LogItem = {
  level: "info" | "warn" | "error" | "debug";
  message: string;
};

const maxLogs = 500;
const maxLogMessageLength = 4_000;
const maxOutputBytes = 512 * 1024;
const workerSelf = self as unknown as WorkerGlobal;

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
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

workerSelf.onmessage = async (event: MessageEvent<DenoPoolJob>) => {
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
    const moduleUrl =
      "data:application/javascript;base64," + toBase64Utf8(job.code);

    const mod = await import(moduleUrl);
    const fn = mod[job.functionName];

    if (typeof fn !== "function") {
      workerSelf.postMessage({
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

    const ctx = {
      jobId: job.jobId,
      codeName: job.codeName,
      codeVersion: job.codeVersion,
      log: (...args: unknown[]) => pushLog("info", args),
      warn: (...args: unknown[]) => pushLog("warn", args),
      error: (...args: unknown[]) => pushLog("error", args),
    };

    const output = await Promise.resolve(
      fn(job.data, ctx, ...(job.args ?? [])),
    );

    try {
      assertOutputSize(output);
    } catch (error) {
      workerSelf.postMessage({
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

    workerSelf.postMessage({
      jobId: job.jobId,
      success: true,
      output,
      logs,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    workerSelf.postMessage({
      jobId: job.jobId,
      success: false,
      error: serializeError(error),
      logs,
      durationMs: Date.now() - startedAt,
    });
  }
};
