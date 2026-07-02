import { randomUUID } from "node:crypto";
import type { DenoPoolJob, RunHttpRequest } from "./types.js";
import type { AppConfig } from "./config.js";
import { DenoPool } from "./deno-pool.js";
import { HttpError, serializeError } from "./errors.js";
import * as logger from "./logger.js";
import { hashRunRequest, validateRunRequest } from "./request-validation.js";
import {
  createQueuedJobRecord,
  failJobRecord,
  finishJobRecord,
  loadCodeVersion,
  markJobRunning,
  saveCodeVersion,
} from "./store.js";

export class RunService {
  constructor(
    private readonly pool: DenoPool,
    private readonly config: Pick<
      AppConfig,
      "queueTimeoutMs" | "allowInheritPermissions"
    >,
  ) {}

  async run(input: unknown) {
    const startedAt = Date.now();
    const body = validateRunRequest(input);

    logger.info("run.validation.succeeded", {
      requestedJobId: body.jobId,
      hasBundle: Boolean(body.bundle),
      hasCodeRef: Boolean(body.codeRef),
      codeName: body.bundle?.name ?? body.codeRef?.name,
      codeVersion: body.bundle?.version ?? body.codeRef?.version,
      functionName: body.functionName ?? "run",
      argsCount: body.args?.length ?? 0,
      metadataKeys: body.metadata ? Object.keys(body.metadata) : [],
    });

    if (body.permissions === "inherit" && !this.config.allowInheritPermissions) {
      logger.warn("run.permissions.inherit_rejected", {
        requestedJobId: body.jobId,
      });
      throw new HttpError(
        400,
        'permissions "inherit" is disabled in this environment',
        false,
        "VALIDATION_ERROR",
      );
    }
    const timeoutMs = clampTimeout(body.timeoutMs ?? 10_000);
    const functionName = body.functionName || "run";
    const stored = await resolveCode(body);

    logger.info("run.code.resolved", {
      requestedJobId: body.jobId,
      codeName: stored.name,
      codeVersion: stored.version,
      sha256: stored.sha256,
      source: body.bundle ? "bundle" : "codeRef",
      timeoutMs,
      functionName,
    });

    const requestHash = hashRunRequest({
      ...body,
      timeoutMs,
      functionName,
      metadata: {
        ...body.metadata,
        resolvedCodeSha256: stored.sha256,
      },
    });

    const jobStart = await createQueuedJobRecord({
      jobId: body.jobId || randomUUID(),
      codeName: stored.name,
      codeVersion: stored.version,
      request: sanitizeRunRequest(body),
      requestHash,
    });

    if (jobStart.kind === "existing") {
      logger.info("run.job.idempotent_result_returned", {
        jobId: jobStart.jobId,
        success: jobStart.result.success,
        errorType: jobStart.result.error?.type,
        durationMs: Date.now() - startedAt,
      });
      return jobStart.result;
    }

    const jobId = jobStart.jobId;
    const job: DenoPoolJob = {
      jobId,
      code: stored.code,
      codeName: stored.name,
      codeVersion: stored.version,
      functionName,
      data: body.data,
      args: body.args ?? [],
      permissions: body.permissions ?? "none",
      timeoutMs,
    };

    try {
      logger.info("run.job.dispatching", {
        jobId,
        codeName: stored.name,
        codeVersion: stored.version,
        functionName,
        timeoutMs,
        queueTimeoutMs: this.config.queueTimeoutMs,
      });

      const result = await this.pool.run(job, {
        queueTimeoutMs: this.config.queueTimeoutMs,
        onStart: (runnerId) => {
          logger.info("run.job.runner_assigned", {
            jobId,
            runnerId,
          });
          return markJobRunning(jobId, runnerId);
        },
      });
      await finishJobRecord(jobId, result);

      logger.info("run.job.finished", {
        jobId,
        success: result.success,
        errorType: result.error?.type,
        retryable: result.error?.retryable,
        userDurationMs: result.durationMs,
        serviceDurationMs: Date.now() - startedAt,
        logCount: result.logs.length,
      });

      return result;
    } catch (error) {
      logger.error("run.job.failed", {
        jobId,
        serviceDurationMs: Date.now() - startedAt,
        error: logger.serializeLogError(error),
      });

      await failJobRecord(jobId, error);

      return {
        jobId,
        success: false,
        error: serializeError(error),
        logs: [],
        durationMs: 0,
      };
    }
  }
}

function clampTimeout(value: number) {
  if (!Number.isFinite(value)) return 10_000;
  if (value < 100) return 100;
  if (value > 60_000) return 60_000;
  return Math.floor(value);
}

async function resolveCode(body: RunHttpRequest) {
  if (body.bundle) {
    return await saveCodeVersion(body.bundle);
  }

  if (body.codeRef) {
    return await loadCodeVersion(body.codeRef.name, body.codeRef.version);
  }

  throw new HttpError(
    400,
    "Either bundle or codeRef is required",
    false,
    "VALIDATION_ERROR",
  );
}

function sanitizeRunRequest(body: RunHttpRequest) {
  return {
    ...body,
    bundle: body.bundle
      ? {
          name: body.bundle.name,
          version: body.bundle.version,
          codeLength: body.bundle.code.length,
        }
      : undefined,
  };
}
