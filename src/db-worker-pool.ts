import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { URL } from "node:url";
import * as logger from "./logger.js";

export type DbConnectionSnapshot = {
  code: string;
  provider: string;
  connectionString: string;
};

export type DbQueryParams =
  | unknown[]
  | Record<string, unknown>
  | null
  | undefined;

export type DbQueryResult = {
  rows: unknown[];
  rowCount: number;
  rowsTruncated: boolean;
  recordsAffected: number[];
};

type DbWorkerPoolOptions = {
  workerCount: number;
  queueTimeoutMs: number;
  maxQueueSize: number;
  maxQueryMs: number;
  maxRows: number;
};

type DbQueryTask = {
  id: string;
  connection: DbConnectionSnapshot;
  query: string;
  params: DbQueryParams;
  timeoutMs: number;
  enqueuedAt: number;
  queueTimer: NodeJS.Timeout | null;
  runTimer: NodeJS.Timeout | null;
  resolve: (value: DbQueryResult) => void;
  reject: (error: unknown) => void;
};

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

type DbWorkerResponse =
  | {
      id: string;
      ok: true;
      result: DbQueryResult;
    }
  | {
      id: string;
      ok: false;
      error: {
        type: string;
        message: string;
        stack?: string;
        retryable: boolean;
      };
    };

type DbWorkerSlot = {
  id: number;
  worker: Worker | null;
  alive: boolean;
  busy: boolean;
  stopping: boolean;
  crashCount: number;
  restartTimer: NodeJS.Timeout | null;
  current: DbQueryTask | null;
};

export class DbWorkerPoolError extends Error {
  constructor(
    public readonly type: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = type;
  }
}

export class DbWorkerPool {
  private readonly slots: DbWorkerSlot[] = [];
  private readonly queue: DbQueryTask[] = [];
  private closing = false;

  constructor(private readonly options: DbWorkerPoolOptions) {
    logger.info("db.worker_pool.initializing", {
      workerCount: options.workerCount,
      queueTimeoutMs: options.queueTimeoutMs,
      maxQueueSize: options.maxQueueSize,
      maxQueryMs: options.maxQueryMs,
      maxRows: options.maxRows,
    });

    for (let index = 0; index < options.workerCount; index += 1) {
      const slot: DbWorkerSlot = {
        id: index + 1,
        worker: null,
        alive: false,
        busy: false,
        stopping: false,
        crashCount: 0,
        restartTimer: null,
        current: null,
      };

      this.slots.push(slot);
      this.startWorker(slot);
    }
  }

  query(input: {
    connection: DbConnectionSnapshot;
    query: string;
    params?: DbQueryParams;
    timeoutMs?: number;
  }) {
    if (this.closing) {
      return Promise.reject(
        new DbWorkerPoolError(
          "DB_WORKER_POOL_CLOSING",
          "DB worker pool is shutting down",
          true,
        ),
      );
    }

    if (this.queue.length >= this.options.maxQueueSize) {
      return Promise.reject(
        new DbWorkerPoolError(
          "DB_QUERY_QUEUE_FULL",
          "DB query queue is full",
          true,
        ),
      );
    }

    return new Promise<DbQueryResult>((resolve, reject) => {
      const task: DbQueryTask = {
        id: randomUUID(),
        connection: input.connection,
        query: input.query,
        params: input.params ?? null,
        timeoutMs: clampQueryTimeout(input.timeoutMs, this.options.maxQueryMs),
        enqueuedAt: Date.now(),
        queueTimer: null,
        runTimer: null,
        resolve,
        reject,
      };

      const slot = this.findIdleSlot();
      if (slot) {
        this.runOnSlot(slot, task);
        return;
      }

      task.queueTimer = setTimeout(() => {
        this.removeQueuedTask(task);
        task.reject(
          new DbWorkerPoolError(
            "DB_QUERY_QUEUE_TIMEOUT",
            `No idle DB worker available within ${this.options.queueTimeoutMs}ms`,
            true,
          ),
        );
      }, this.options.queueTimeoutMs);

      this.queue.push(task);
      logger.warn("db.worker_pool.query_queued", {
        requestId: task.id,
        connectionCode: input.connection.code,
        queueDepth: this.queue.length,
        ...this.stats(),
      });
    });
  }

  closeConnection(code: string) {
    for (const slot of this.slots) {
      if (!slot.worker || !slot.alive) continue;
      slot.worker.postMessage({
        type: "closeConnection",
        code,
      } satisfies DbWorkerMessage);
    }
  }

  async close() {
    this.closing = true;

    for (const task of this.queue.splice(0)) {
      this.clearTaskTimers(task);
      task.reject(
        new DbWorkerPoolError(
          "DB_WORKER_POOL_CLOSING",
          "DB worker pool is shutting down",
          true,
        ),
      );
    }

    await Promise.all(
      this.slots.map(async (slot) => {
        slot.stopping = true;
        if (slot.restartTimer) clearTimeout(slot.restartTimer);
        slot.restartTimer = null;
        slot.worker?.postMessage({ type: "closeAll" } satisfies DbWorkerMessage);
        await slot.worker?.terminate().catch(() => undefined);
      }),
    );

    logger.info("db.worker_pool.closed", this.stats());
  }

  stats() {
    return {
      dbWorkerPoolSize: this.slots.length,
      dbWorkersAlive: this.slots.filter((slot) => slot.alive).length,
      dbWorkersIdle: this.slots.filter((slot) => slot.alive && !slot.busy).length,
      dbQueuedQueries: this.queue.length,
      dbWorkerPoolClosing: this.closing,
    };
  }

  private startWorker(slot: DbWorkerSlot) {
    if (slot.stopping) return;

    const workerUrl = getWorkerUrl();

    logger.info("db.worker.starting", {
      workerId: slot.id,
      workerUrl: workerUrl.toString(),
      crashCount: slot.crashCount,
    });

    const worker = new Worker(workerUrl, {
      name: `db-query-worker-${slot.id}`,
      execArgv: getWorkerExecArgv(),
    });

    slot.worker = worker;
    slot.alive = true;
    slot.busy = false;

    worker.on("message", (message: DbWorkerResponse) => {
      this.handleWorkerResponse(slot, message);
    });

    worker.on("error", (error) => {
      logger.error("db.worker.error", {
        workerId: slot.id,
        requestId: slot.current?.id,
        error: logger.serializeLogError(error),
      });
    });

    worker.on("exit", (code) => {
      slot.alive = false;
      slot.busy = false;
      slot.worker = null;

      const exitFields = {
        workerId: slot.id,
        requestId: slot.current?.id,
        code,
        stopping: slot.stopping,
      };

      if (slot.stopping || this.closing) {
        logger.info("db.worker.exited", exitFields);
      } else {
        logger.error("db.worker.exited", exitFields);

        this.failCurrent(
          slot,
          new DbWorkerPoolError(
            "DB_WORKER_EXITED",
            `DB worker ${slot.id} exited with code ${code}`,
            true,
          ),
        );
      }

      if (!slot.stopping && !this.closing) {
        this.scheduleRestart(slot);
      }
    });

    logger.info("db.worker.started", {
      workerId: slot.id,
      threadId: worker.threadId,
    });

    this.drain();
  }

  private scheduleRestart(slot: DbWorkerSlot) {
    slot.crashCount += 1;
    const delayMs = Math.min(15_000, 100 * 2 ** Math.min(slot.crashCount - 1, 7));

    logger.warn("db.worker.restart_scheduled", {
      workerId: slot.id,
      crashCount: slot.crashCount,
      delayMs,
    });

    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      this.startWorker(slot);
    }, delayMs);
  }

  private handleWorkerResponse(slot: DbWorkerSlot, message: DbWorkerResponse) {
    const task = slot.current;

    if (!task || task.id !== message.id) {
      logger.warn("db.worker.unexpected_response", {
        workerId: slot.id,
        responseId: message.id,
        currentRequestId: task?.id,
      });
      return;
    }

    this.clearTaskTimers(task);
    slot.current = null;
    slot.busy = false;
    slot.crashCount = 0;

    const durationMs = Date.now() - task.enqueuedAt;

    if (message.ok) {
      logger.info("db.worker.query_finished", {
        workerId: slot.id,
        requestId: task.id,
        connectionCode: task.connection.code,
        durationMs,
        rowCount: message.result.rowCount,
        rowsTruncated: message.result.rowsTruncated,
      });
      task.resolve(message.result);
    } else {
      logger.warn("db.worker.query_failed", {
        workerId: slot.id,
        requestId: task.id,
        connectionCode: task.connection.code,
        durationMs,
        errorType: message.error.type,
        retryable: message.error.retryable,
      });
      task.reject(
        new DbWorkerPoolError(
          message.error.type,
          message.error.message,
          message.error.retryable,
        ),
      );
    }

    this.drain();
  }

  private runOnSlot(slot: DbWorkerSlot, task: DbQueryTask) {
    if (!slot.worker || !slot.alive || slot.busy) {
      this.queue.unshift(task);
      return;
    }

    slot.busy = true;
    slot.current = task;

    const runTimeoutMs = task.timeoutMs + 1_000;
    task.runTimer = setTimeout(() => {
      logger.error("db.worker.query_parent_timeout", {
        workerId: slot.id,
        requestId: task.id,
        connectionCode: task.connection.code,
        runTimeoutMs,
      });

      this.failCurrent(
        slot,
        new DbWorkerPoolError(
          "DB_WORKER_TIMEOUT",
          `DB worker did not return within ${runTimeoutMs}ms`,
          true,
        ),
      );
      void slot.worker?.terminate();
    }, runTimeoutMs);

    logger.info("db.worker.query_started", {
      workerId: slot.id,
      requestId: task.id,
      connectionCode: task.connection.code,
      queryLength: task.query.length,
      queuedMs: Date.now() - task.enqueuedAt,
    });

    slot.worker.postMessage({
      type: "query",
      id: task.id,
      connection: task.connection,
      query: task.query,
      params: task.params,
      maxQueryMs: task.timeoutMs,
      maxRows: this.options.maxRows,
    } satisfies DbWorkerMessage);
  }

  private drain() {
    if (this.closing) return;

    while (this.queue.length > 0) {
      const slot = this.findIdleSlot();
      if (!slot) return;

      const task = this.queue.shift()!;
      if (task.queueTimer) {
        clearTimeout(task.queueTimer);
        task.queueTimer = null;
      }
      this.runOnSlot(slot, task);
    }
  }

  private findIdleSlot() {
    return this.slots.find((slot) => slot.alive && !slot.busy && slot.worker) ?? null;
  }

  private removeQueuedTask(task: DbQueryTask) {
    const index = this.queue.indexOf(task);
    if (index !== -1) this.queue.splice(index, 1);
  }

  private failCurrent(slot: DbWorkerSlot, error: unknown) {
    const task = slot.current;
    if (!task) return;

    this.clearTaskTimers(task);
    slot.current = null;
    slot.busy = false;
    task.reject(error);
    this.drain();
  }

  private clearTaskTimers(task: DbQueryTask) {
    if (task.queueTimer) clearTimeout(task.queueTimer);
    if (task.runTimer) clearTimeout(task.runTimer);
    task.queueTimer = null;
    task.runTimer = null;
  }
}

function getWorkerUrl(): URL {
  const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
  return new URL(
    isTypeScriptRuntime ? "./db-query-worker.ts" : "./db-query-worker.js",
    import.meta.url,
  );
}

function getWorkerExecArgv() {
  return import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : undefined;
}

function clampQueryTimeout(value: number | undefined, maxQueryMs: number) {
  if (!Number.isFinite(value)) return maxQueryMs;
  return Math.max(100, Math.min(Math.floor(value as number), maxQueryMs));
}
