import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { DenoPoolResult, JobStatus } from "../types.js";
import { HttpError, serializeError } from "../errors.js";
import * as logger from "../logger.js";
import { prisma } from "./client.js";

const terminalStatuses = new Set<JobStatus>([
  "completed",
  "failed",
  "timed_out",
  "crashed",
  "cancelled",
]);

export type JobRecordStart =
  | {
      kind: "created";
      jobId: string;
    }
  | {
      kind: "existing";
      jobId: string;
      result: DenoPoolResult;
    };

export async function createQueuedJobRecord(input: {
  jobId?: string;
  codeName: string;
  codeVersion: string;
  request: unknown;
  requestHash: string;
}): Promise<JobRecordStart> {
  const jobId = input.jobId || randomUUID();
  const existing = await prisma.jobRecord.findUnique({
    where: {
      jobId,
    },
  });

  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      logger.warn("job_record.conflict", {
        jobId,
        existingStatus: existing.status,
        codeName: input.codeName,
        codeVersion: input.codeVersion,
      });

      throw new HttpError(
        409,
        `Job ${jobId} already exists with a different request`,
        false,
        "JOB_CONFLICT",
      );
    }

    if (terminalStatuses.has(existing.status as JobStatus) && existing.result) {
      const result = existing.result as DenoPoolResult;

      if (result.error?.retryable) {
        await prisma.jobRecord.update({
          where: {
            jobId,
          },
          data: {
            status: "queued",
            result: Prisma.DbNull,
            errorType: null,
            runnerId: null,
            queuedAt: new Date(),
            startedAt: null,
            heartbeatAt: null,
            finishedAt: null,
          },
        });

        logger.info("job_record.retryable_terminal_requeued", {
          jobId,
          previousStatus: existing.status,
          previousErrorType: result.error.type,
          codeName: existing.codeName,
          codeVersion: existing.codeVersion,
        });

        return {
          kind: "created",
          jobId,
        };
      }

      logger.info("job_record.idempotent_hit", {
        jobId,
        status: existing.status,
        codeName: existing.codeName,
        codeVersion: existing.codeVersion,
      });

      return {
        kind: "existing",
        jobId,
        result,
      };
    }

    logger.warn("job_record.already_active", {
      jobId,
      status: existing.status,
      codeName: existing.codeName,
      codeVersion: existing.codeVersion,
    });

    throw new HttpError(
      409,
      `Job ${jobId} is already ${existing.status}`,
      true,
      "JOB_ALREADY_RUNNING",
    );
  }

  await prisma.jobRecord.create({
    data: {
      jobId,
      status: "queued",
      codeName: input.codeName,
      codeVersion: input.codeVersion,
      request: input.request as Prisma.InputJsonValue,
      requestHash: input.requestHash,
      requestSchemaVersion: 1,
    },
  });

  logger.info("job_record.queued", {
    jobId,
    codeName: input.codeName,
    codeVersion: input.codeVersion,
  });

  return {
    kind: "created",
    jobId,
  };
}

export async function markJobRunning(jobId: string, runnerId: number) {
  await prisma.jobRecord.update({
    where: {
      jobId,
    },
    data: {
      status: "running",
      startedAt: new Date(),
      heartbeatAt: new Date(),
      runnerId,
      attempts: {
        increment: 1,
      },
    },
  });

  logger.info("job_record.running", {
    jobId,
    runnerId,
  });
}

export async function finishJobRecord(jobId: string, result: DenoPoolResult) {
  const errorType = result.error?.type;
  const status = getStatusForResult(result);

  await prisma.jobRecord.update({
    where: {
      jobId,
    },
    data: {
      status,
      finishedAt: new Date(),
      heartbeatAt: new Date(),
      errorType,
      result: result as Prisma.InputJsonValue,
    },
  });

  logger.info("job_record.finished", {
    jobId,
    status,
    success: result.success,
    errorType,
    retryable: result.error?.retryable,
    durationMs: result.durationMs,
    logCount: result.logs.length,
  });
}

export async function failJobRecord(jobId: string, error: unknown) {
  const serialized = serializeError(error);
  const status = serialized.type === "TIMEOUT" ? "timed_out" : "failed";

  await prisma.jobRecord.update({
    where: {
      jobId,
    },
    data: {
      status,
      finishedAt: new Date(),
      heartbeatAt: new Date(),
      errorType: serialized.type,
      result: {
        jobId,
        success: false,
        error: serialized,
        logs: [],
        durationMs: 0,
      },
    },
  });

  logger.error("job_record.failed", {
    jobId,
    status,
    errorType: serialized.type,
    retryable: serialized.retryable,
    error: logger.serializeLogError(error),
  });
}

export async function recoverInterruptedJobs() {
  const interruptedJobs = await prisma.jobRecord.findMany({
    where: {
      status: {
        in: ["queued", "running"],
      },
    },
    select: {
      jobId: true,
      status: true,
    },
  });

  logger.info("job_record.recovery.started", {
    interruptedJobs: interruptedJobs.length,
  });

  for (const record of interruptedJobs) {
    const result = makeInterruptedJobResult(record.jobId, record.status as JobStatus);

    await prisma.jobRecord.update({
      where: {
        jobId: record.jobId,
      },
      data: {
        status: "crashed",
        finishedAt: new Date(),
        heartbeatAt: new Date(),
        errorType: result.error?.type,
        result: result as Prisma.InputJsonValue,
      },
    });

    logger.warn("job_record.recovered_crashed", {
      jobId: record.jobId,
      previousStatus: record.status,
    });
  }

  logger.info("job_record.recovery.finished", {
    recoveredJobs: interruptedJobs.length,
  });
}

function makeInterruptedJobResult(
  jobId: string,
  previousStatus: JobStatus,
): DenoPoolResult {
  return {
    jobId,
    success: false,
    error: {
      type: "WORKER_PROCESS_CRASHED",
      message:
        previousStatus === "queued"
          ? "Node server restarted before this queued job started"
          : "Node server restarted while this job was running",
      retryable: true,
    },
    logs: [],
    durationMs: 0,
  };
}

function getStatusForResult(result: DenoPoolResult): JobStatus {
  if (result.success) return "completed";
  if (result.error?.type === "TIMEOUT") return "timed_out";
  if (result.error?.type === "WORKER_PROCESS_CRASHED") return "crashed";
  return "failed";
}
