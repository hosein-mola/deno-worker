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

const encoder = new TextEncoder();

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

async function runJob(job: DenoPoolJob) {
  return await new Promise((resolve) => {
    const workerUrl = new URL("./user-worker.ts", import.meta.url);

    let settled = false;
    let worker: Worker | null = null;

    const startedAt = Date.now();

    const finish = (value: unknown) => {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);

      if (worker) {
        worker.terminate();
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
      });
    }, job.timeoutMs);

    try {
      worker = new Worker(workerUrl, {
        type: "module",
        deno: {
          permissions: normalizePermissions(job.permissions),
        },
      } as WorkerOptions);

      worker.onmessage = (event) => {
        finish(event.data);
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
        });
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
        });
      };

      worker.postMessage(job);
    } catch (error) {
      finish({
        jobId: job.jobId,
        success: false,
        error: serializeInfraError(error),
        logs: [],
        durationMs: Date.now() - startedAt,
      });
    }
  });
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
  for await (const line of readStdinLines()) {
    if (!line.trim()) continue;

    try {
      const job = JSON.parse(line) as DenoPoolJob;
      const result = await runJob(job);

      writeJsonLine(result);
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
