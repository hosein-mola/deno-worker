import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { querySavedConnection } from "./db-service.js";
import * as logger from "./logger.js";
import type {
  DbQueryRequestMessage,
  DbQueryResponseMessage,
  DenoPoolJob,
  DenoPoolResult,
} from "./types.js";

type RunOptions = {
  queueTimeoutMs: number;
  onStart?: (runnerId: number) => Promise<void> | void;
};

type PendingJob = {
  job: DenoPoolJob;
  options: RunOptions;
  resolve: (value: DenoPoolResult) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout | null;
};

class DenoRunnerProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private current: {
    jobId: string;
    timer: NodeJS.Timeout;
    resolve: (value: DenoPoolResult) => void;
    reject: (error: unknown) => void;
  } | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private crashCount = 0;
  private stopping = false;

  public idle = true;
  public alive = false;

  constructor(
    public readonly id: number,
    private readonly responseGraceMs: number,
    private readonly onStateChange: () => void,
  ) {
    this.start();
  }

  private start() {
    if (this.stopping) return;

    const runnerPath = join(process.cwd(), "deno", "runner.ts");
    this.stdoutBuffer = "";

    logger.info("deno.runner.starting", {
      runnerId: this.id,
      runnerPath,
      crashCount: this.crashCount,
    });

    this.child = spawn(
      "deno",
      [
        "run",
        "--quiet",
        "--unstable-worker-options",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-env",
        runnerPath,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.alive = true;
    this.idle = true;
    logger.info("deno.runner.started", {
      runnerId: this.id,
      pid: this.child.pid,
    });
    this.onStateChange();

    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");

      if (this.stdoutBuffer.length > 1024 * 1024) {
        logger.error("deno.runner.stdout_buffer_exceeded", {
          runnerId: this.id,
          jobId: this.current?.jobId,
          bufferBytes: this.stdoutBuffer.length,
        });
        this.failCurrent(
          new Error(`Deno runner ${this.id} stdout buffer exceeded 1 MiB`),
        );
        this.child?.kill("SIGKILL");
        return;
      }

      this.consumeStdout();
    });

    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        logger.warn("deno.runner.stderr", {
          runnerId: this.id,
          jobId: this.current?.jobId,
          message: text,
        });
      }
    });

    this.child.on("exit", (code, signal) => {
      this.alive = false;
      this.idle = false;

      logger.error("deno.runner.exited", {
        runnerId: this.id,
        pid: this.child?.pid,
        jobId: this.current?.jobId,
        code,
        signal,
        stopping: this.stopping,
      });

      this.failCurrent(
        new Error(`Deno runner ${this.id} exited with code=${code}, signal=${signal}`),
      );

      if (!this.stopping) {
        this.scheduleRestart();
      }

      this.onStateChange();
    });

    this.child.on("error", (error) => {
      this.alive = false;
      logger.error("deno.runner.process_error", {
        runnerId: this.id,
        jobId: this.current?.jobId,
        error: logger.serializeLogError(error),
      });
      this.failCurrent(error);
      this.onStateChange();
    });
  }

  private scheduleRestart() {
    this.crashCount += 1;
    const delayMs = Math.min(30_000, 250 * 2 ** Math.min(this.crashCount - 1, 7));

    logger.warn("deno.runner.restart_scheduled", {
      runnerId: this.id,
      crashCount: this.crashCount,
      delayMs,
    });

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delayMs);
  }

  private consumeStdout() {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (!line.trim()) continue;

      if (!this.current) {
        logger.warn("deno.runner.unexpected_output", {
          runnerId: this.id,
          lineLength: line.length,
          line: line.slice(0, 1_000),
        });
        continue;
      }

      try {
        const message = JSON.parse(line) as DenoPoolResult | DbQueryRequestMessage;

        if (isDbQueryRequest(message)) {
          void this.handleDbQuery(message);
          continue;
        }

        const result = message;

        if (result.jobId !== this.current.jobId) {
          throw new Error(
            `Deno runner ${this.id} returned jobId=${result.jobId} while running jobId=${this.current.jobId}`,
          );
        }

        this.finishCurrent(result);
        this.crashCount = 0;
      } catch (error) {
        logger.error("deno.runner.output_parse_failed", {
          runnerId: this.id,
          jobId: this.current?.jobId,
          lineLength: line.length,
          line: line.slice(0, 1_000),
          error: logger.serializeLogError(error),
        });
        this.failCurrent(error);
        this.child?.kill("SIGKILL");
      }
    }
  }

  private async handleDbQuery(message: DbQueryRequestMessage) {
    logger.info("deno.runner.db_query.started", {
      runnerId: this.id,
      jobId: message.jobId,
      requestId: message.requestId,
      code: message.code,
      queryLength: message.query.length,
      paramsKind: Array.isArray(message.params)
        ? "array"
        : message.params && typeof message.params === "object"
          ? "object"
          : "none",
    });

    let response: DbQueryResponseMessage;
    try {
      const result = await querySavedConnection(
        message.code,
        message.query,
        message.params,
        message.timeoutMs,
      );
      response = {
        type: "db.response",
        requestId: message.requestId,
        ok: true,
        result,
      };
    } catch (error) {
      logger.error("deno.runner.db_query.failed", {
        runnerId: this.id,
        jobId: message.jobId,
        requestId: message.requestId,
        code: message.code,
        error: logger.serializeLogError(error),
      });
      response = {
        type: "db.response",
        requestId: message.requestId,
        ok: false,
        error: serializeDbQueryError(error),
      };
    }

    this.child?.stdin.write(JSON.stringify(response) + "\n", (error) => {
      if (error) {
        logger.error("deno.runner.db_response_write_failed", {
          runnerId: this.id,
          jobId: message.jobId,
          requestId: message.requestId,
          error: logger.serializeLogError(error),
        });
      }
    });
  }

  run(job: DenoPoolJob): Promise<DenoPoolResult> {
    if (!this.child || !this.alive) {
      logger.warn("deno.runner.run_rejected_not_alive", {
        runnerId: this.id,
        jobId: job.jobId,
      });
      return Promise.reject(new Error(`Deno runner ${this.id} is not alive`));
    }

    if (this.current) {
      logger.warn("deno.runner.run_rejected_busy", {
        runnerId: this.id,
        jobId: job.jobId,
        currentJobId: this.current.jobId,
      });
      return Promise.reject(new Error(`Deno runner ${this.id} is busy`));
    }

    this.idle = false;
    logger.info("deno.runner.job_started", {
      runnerId: this.id,
      jobId: job.jobId,
      codeName: job.codeName,
      codeVersion: job.codeVersion,
      functionName: job.functionName,
      timeoutMs: job.timeoutMs,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        logger.error("deno.runner.parent_timeout", {
          runnerId: this.id,
          jobId: job.jobId,
          timeoutMs: job.timeoutMs,
          responseGraceMs: this.responseGraceMs,
        });
        this.failCurrent(
          new Error(
            `Deno runner ${this.id} did not respond for job ${job.jobId} before parent timeout`,
          ),
        );
        this.child?.kill("SIGKILL");
      }, job.timeoutMs + this.responseGraceMs);

      this.current = {
        jobId: job.jobId,
        timer,
        resolve,
        reject,
      };

      this.child!.stdin.write(JSON.stringify(job) + "\n", (error) => {
        if (error) {
          logger.error("deno.runner.stdin_write_failed", {
            runnerId: this.id,
            jobId: job.jobId,
            error: logger.serializeLogError(error),
          });
          this.failCurrent(error);
          this.child?.kill("SIGKILL");
        }
      });
    });
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    logger.info("deno.runner.stop", {
      runnerId: this.id,
      pid: this.child?.pid,
    });
    this.child?.kill("SIGTERM");
  }

  reserve() {
    if (!this.child || !this.alive || !this.idle || this.current) return false;
    this.idle = false;
    return true;
  }

  releaseReservation() {
    if (this.current) return;
    this.idle = true;
    this.onStateChange();
  }

  kill() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    logger.warn("deno.runner.kill", {
      runnerId: this.id,
      pid: this.child?.pid,
      jobId: this.current?.jobId,
    });
    this.child?.kill("SIGKILL");
  }

  private finishCurrent(result: DenoPoolResult) {
    if (!this.current) return;

    const current = this.current;
    clearTimeout(current.timer);
    this.current = null;
    this.idle = true;
    logger.info("deno.runner.job_finished", {
      runnerId: this.id,
      jobId: result.jobId,
      success: result.success,
      errorType: result.error?.type,
      retryable: result.error?.retryable,
      durationMs: result.durationMs,
      logCount: result.logs.length,
    });
    current.resolve(result);
    this.onStateChange();
  }

  private failCurrent(error: unknown) {
    if (!this.current) return;

    const current = this.current;
    clearTimeout(current.timer);
    this.current = null;
    this.idle = false;
    logger.error("deno.runner.job_failed", {
      runnerId: this.id,
      jobId: current.jobId,
      error: logger.serializeLogError(error),
    });
    current.reject(error);
  }
}

export class DenoPool {
  private runners: DenoRunnerProcess[] = [];
  private pending: PendingJob[] = [];
  private closing = false;

  constructor(config: Pick<AppConfig, "poolSize" | "runnerResponseGraceMs">) {
    logger.info("deno.pool.initializing", {
      poolSize: config.poolSize,
      runnerResponseGraceMs: config.runnerResponseGraceMs,
    });

    for (let i = 0; i < config.poolSize; i++) {
      this.runners.push(
        new DenoRunnerProcess(i + 1, config.runnerResponseGraceMs, () =>
          this.drain(),
        ),
      );
    }
  }

  async run(job: DenoPoolJob, options: RunOptions): Promise<DenoPoolResult> {
    if (this.closing) {
      logger.warn("deno.pool.rejected_closing", {
        jobId: job.jobId,
      });
      return makePoolBusyResult(job.jobId, "Deno pool is shutting down");
    }

    const runner = this.findIdleRunner();

    if (runner) {
      return await this.startOnRunner(runner, job, options);
    }

    logger.warn("deno.pool.job_queued", {
      jobId: job.jobId,
      queueTimeoutMs: options.queueTimeoutMs,
      ...this.stats(),
      queuedJobsAfterEnqueue: this.pending.length + 1,
    });

    return await new Promise<DenoPoolResult>((resolve, reject) => {
      const pendingJob: PendingJob = {
        job,
        options,
        resolve,
        reject,
        timer: null,
      };

      pendingJob.timer = setTimeout(() => {
        this.removePending(pendingJob);
        logger.warn("deno.pool.queue_timeout", {
          jobId: job.jobId,
          queueTimeoutMs: options.queueTimeoutMs,
          ...this.stats(),
        });
        resolve(makePoolBusyResult(job.jobId, "No idle Deno runner available"));
      }, options.queueTimeoutMs);

      this.pending.push(pendingJob);
      this.drain();
    });
  }

  stats() {
    return {
      poolSize: this.runners.length,
      aliveRunners: this.runners.filter((runner) => runner.alive).length,
      idleRunners: this.runners.filter((runner) => runner.alive && runner.idle)
        .length,
      queuedJobs: this.pending.length,
      closing: this.closing,
    };
  }

  async close(graceMs: number) {
    this.closing = true;
    logger.info("deno.pool.closing", {
      graceMs,
      ...this.stats(),
    });

    for (const pending of this.pending.splice(0)) {
      if (pending.timer) clearTimeout(pending.timer);
      logger.warn("deno.pool.pending_rejected_on_shutdown", {
        jobId: pending.job.jobId,
      });
      pending.resolve(makePoolBusyResult(pending.job.jobId, "Deno pool is shutting down"));
    }

    const deadline = Date.now() + graceMs;

    while (Date.now() < deadline) {
      if (this.runners.every((runner) => runner.idle)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    for (const runner of this.runners) {
      if (runner.idle) runner.stop();
      else runner.kill();
    }

    logger.info("deno.pool.closed", this.stats());
  }

  private drain() {
    if (this.closing) return;

    while (this.pending.length > 0) {
      const runner = this.findIdleRunner();
      if (!runner) return;

      const pending = this.pending.shift()!;
      if (pending.timer) clearTimeout(pending.timer);

      this.startOnRunner(runner, pending.job, pending.options)
        .then(pending.resolve)
        .catch(pending.reject)
        .finally(() => this.drain());
    }
  }

  private async startOnRunner(
    runner: DenoRunnerProcess,
    job: DenoPoolJob,
    options: RunOptions,
  ) {
    if (!runner.reserve()) {
      logger.warn("deno.pool.runner_reservation_failed", {
        runnerId: runner.id,
        jobId: job.jobId,
      });
      return makePoolBusyResult(job.jobId, "No idle Deno runner available");
    }

    try {
      await options.onStart?.(runner.id);
    } catch (error) {
      logger.error("deno.pool.on_start_failed", {
        runnerId: runner.id,
        jobId: job.jobId,
        error: logger.serializeLogError(error),
      });
      runner.releaseReservation();
      throw error;
    }

    try {
      return await runner.run(job);
    } catch (error) {
      logger.error("deno.pool.runner_job_crashed", {
        runnerId: runner.id,
        jobId: job.jobId,
        error: logger.serializeLogError(error),
      });
      return {
        jobId: job.jobId,
        success: false,
        error: {
          type: "WORKER_PROCESS_CRASHED",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
        logs: [],
        durationMs: 0,
      };
    } finally {
      this.drain();
    }
  }

  private findIdleRunner() {
    return this.runners.find((runner) => runner.alive && runner.idle) ?? null;
  }

  private removePending(pendingJob: PendingJob) {
    const index = this.pending.indexOf(pendingJob);
    if (index !== -1) this.pending.splice(index, 1);
  }
}

function makePoolBusyResult(jobId: string, message: string): DenoPoolResult {
  return {
    jobId,
    success: false,
    error: {
      type: "POOL_BUSY",
      message,
      retryable: true,
    },
    logs: [],
    durationMs: 0,
  };
}

function isDbQueryRequest(value: DenoPoolResult | DbQueryRequestMessage): value is DbQueryRequestMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "db.query"
  );
}

function serializeDbQueryError(error: unknown) {
  if (error instanceof Error) {
    return {
      type: error.name || "DB_QUERY_ERROR",
      message: error.message,
      retryable: getErrorRetryability(error),
    };
  }

  return {
    type: "DB_QUERY_ERROR",
    message: String(error),
    retryable: false,
  };
}

function getErrorRetryability(error: Error) {
  const retryable = (error as Error & { retryable?: unknown }).retryable;
  if (typeof retryable === "boolean") return retryable;
  return false;
}
