type PermissionSpec =
  | "none"
  | "inherit"
  | {
      read?: boolean | string[];
      write?: boolean | string[];
      net?: boolean | string[];
      env?: boolean | string[];
      sys?: boolean | string[];
      ffi?: false;
      run?: false;
    };

type DenoPoolJob = {
  jobId: string;
  code: string;
  codeName: string;
  codeVersion: string;
  functionName: string;
  data: unknown;
  args: unknown[];
  permissions: PermissionSpec;
  timeoutMs: number;
};

type DbQueryRequestMessage = {
  type: "db.query";
  requestId: string;
  jobId: string;
  code: string;
  query: string;
  params?: unknown[] | Record<string, unknown> | null;
  timeoutMs?: number;
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

const encoder = new TextEncoder();
const workerUrl = new URL("./user-worker.ts", import.meta.url);
const reuseWorkers = Deno.env.get("DENO_WORKER_REUSE") !== "false";
const pendingDbResponses = new Map<
  string,
  {
    resolve: (value: DbQueryResponseMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let sandbox: {
  worker: Worker;
  sandboxKey: string;
} | null = null;

function writeJsonLine(value: unknown) {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(value) + "\n"));
}

function normalizePermissions(input: PermissionSpec): Deno.PermissionOptions {
  if (!input) return "none";
  if (input === "none") return "none";
  if (input === "inherit") return "inherit";

  return {
    read: input.read ?? false,
    write: input.write ?? false,
    net: input.net ?? false,
    env: input.env ?? false,
    sys: input.sys ?? false,

    // Do not allow subprocess or FFI in this MVP.
    ffi: false,
    run: false,
  } as Deno.PermissionOptionsObject;
}

function serializeInfraError(error: unknown) {
  if (error instanceof Error) {
    return {
      type: "DENO_RUNNER_ERROR",
      message: error.message,
      stack: error.stack,
      retryable: true,
    };
  }

  return {
    type: "UNKNOWN_INFRA_ERROR",
    message: String(error),
    retryable: true,
  };
}

function writeDbQueryRequest(value: DbQueryRequestMessage) {
  writeJsonLine(value);
}

function waitForDbResponse(requestId: string, timeoutMs: number) {
  return new Promise<DbQueryResponseMessage>((resolve) => {
    const timer = setTimeout(() => {
      pendingDbResponses.delete(requestId);
      resolve({
        type: "db.response",
        requestId,
        ok: false,
        error: {
          type: "DB_QUERY_TIMEOUT",
          message: `DB query did not respond within ${timeoutMs}ms`,
          retryable: true,
        },
      });
    }, timeoutMs);

    pendingDbResponses.set(requestId, {
      resolve,
      timer,
    });
  });
}

function resolveDbResponse(message: DbQueryResponseMessage) {
  const pending = pendingDbResponses.get(message.requestId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingDbResponses.delete(message.requestId);
  pending.resolve(message);
  return true;
}

async function runJob(job: DenoPoolJob) {
  return await new Promise((resolve) => {
    let settled = false;
    const startedAt = Date.now();
    const permissionKey = getPermissionKey(job.permissions);
    const sandboxKey = getSandboxKey(job, permissionKey);
    let worker: Worker | null = null;

    const finish = (value: unknown, keepWorker = true) => {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);

      if (!reuseWorkers) {
        worker?.terminate();
      } else if (!keepWorker) {
        terminateSandbox();
      }

      resolve(value);
    };

    const timeout = setTimeout(() => {
      finish({
        jobId: job.jobId,
        success: false,
        error: {
          type: "TIMEOUT",
          message: `Job timed out after ${job.timeoutMs}ms`,
          retryable: true,
        },
        logs: [],
        durationMs: Date.now() - startedAt,
      }, false);
    }, job.timeoutMs);

    try {
      worker = getSandboxWorker(job.permissions, sandboxKey);

      worker.onmessage = (event) => {
        if (isDbQueryRequest(event.data)) {
          const request = event.data;
          writeDbQueryRequest(request);
          void waitForDbResponse(
            request.requestId,
            request.timeoutMs ?? job.timeoutMs,
          ).then(
            (response) => {
              if (!settled) worker?.postMessage(response);
            },
          );
          return;
        }

        finish(event.data, true);
      };

      worker.onerror = (event) => {
        finish({
          jobId: job.jobId,
          success: false,
          error: {
            type: "DENO_WORKER_ERROR",
            message: event.message,
            retryable: true,
          },
          logs: [],
          durationMs: Date.now() - startedAt,
        }, false);
      };

      worker.onmessageerror = () => {
        finish({
          jobId: job.jobId,
          success: false,
          error: {
            type: "DENO_WORKER_MESSAGE_ERROR",
            message: "Failed to deserialize message from Deno Worker",
            retryable: true,
          },
          logs: [],
          durationMs: Date.now() - startedAt,
        }, false);
      };

      worker.postMessage(job);
    } catch (error) {
      finish({
        jobId: job.jobId,
        success: false,
        error: serializeInfraError(error),
        logs: [],
        durationMs: Date.now() - startedAt,
      }, false);
    }
  });
}

function getSandboxWorker(permissions: PermissionSpec, sandboxKey: string) {
  if (reuseWorkers && sandbox?.sandboxKey === sandboxKey) {
    return sandbox.worker;
  }

  terminateSandbox();

  const worker = new Worker(workerUrl, {
    type: "module",
    deno: {
      permissions: normalizePermissions(permissions),
    },
  } as WorkerOptions);

  if (reuseWorkers) {
    sandbox = {
      worker,
      sandboxKey,
    };
  }

  return worker;
}

function terminateSandbox() {
  if (!sandbox) return;
  sandbox.worker.terminate();
  sandbox = null;
}

function getPermissionKey(input: PermissionSpec) {
  return stableStringify(normalizePermissions(input));
}

function getSandboxKey(job: DenoPoolJob, permissionKey: string) {
  return `${permissionKey}\0${job.codeName}\0${job.codeVersion}\0${job.code}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

async function* readStdinLines(): AsyncGenerator<string> {
  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();

  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      yield line;
    }
  }

  buffer += decoder.decode();

  if (buffer.length > 0) {
    yield buffer;
  }
}

async function main() {
  let running: Promise<unknown> | null = null;

  for await (const line of readStdinLines()) {
    if (!line.trim()) continue;

    try {
      const message = JSON.parse(line) as DenoPoolJob | DbQueryResponseMessage;

      if (isDbQueryResponse(message)) {
        resolveDbResponse(message);
        continue;
      }

      if (running) {
        writeJsonLine({
          jobId: message.jobId ?? "unknown",
          success: false,
          error: {
            type: "DENO_RUNNER_BUSY",
            message: "Runner received a new job while another job is running",
            retryable: true,
          },
          logs: [],
          durationMs: 0,
        });
        continue;
      }

      const job = message as DenoPoolJob;
      running = runJob(job)
        .then((result) => {
          writeJsonLine(result);
        })
        .catch((error) => {
          writeJsonLine({
            jobId: job.jobId,
            success: false,
            error: serializeInfraError(error),
            logs: [],
            durationMs: 0,
          });
        })
        .finally(() => {
          running = null;
        });
    } catch (error) {
      writeJsonLine({
        jobId: "unknown",
        success: false,
        error: serializeInfraError(error),
        logs: [],
        durationMs: 0,
      });
    }
  }
}

main();

function isDbQueryRequest(value: unknown): value is DbQueryRequestMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "db.query"
  );
}

function isDbQueryResponse(value: unknown): value is DbQueryResponseMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "db.response"
  );
}
