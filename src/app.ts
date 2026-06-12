import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import type { AppConfig } from "./config.js";
import { DenoPool } from "./deno-pool.js";
import { HttpError, serializeError } from "./errors.js";
import * as logger from "./logger.js";
import { createOpenApiDocument, createSwaggerHtml } from "./openapi.js";
import { RunService } from "./run-service.js";
import type { RunHttpRequest } from "./types.js";
import { mountWorkspaceApi } from "./workspace-api.js";

export function createApp(config: AppConfig) {
  const pool = new DenoPool(config);
  const runService = new RunService(pool, config);
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: config.maxRequestBytes }));
  app.use(requestLogger);

  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      ...pool.stats(),
    });
  });

  app.post(
    "/run",
    asyncHandler(async (req, res) => {
      logger.info("run.request.accepted", {
        requestId: res.locals.requestId,
        hasBundle: Boolean(req.body?.bundle),
        hasCodeRef: Boolean(req.body?.codeRef),
        requestedJobId: req.body?.jobId,
        functionName: req.body?.functionName,
        permissions: summarizePermissions(req.body?.permissions),
        timeoutMs: req.body?.timeoutMs,
        bodyBytes: req.socket.bytesRead,
      });

      const result = await runService.run(req.body as RunHttpRequest);

      logger.info("run.request.completed", {
        requestId: res.locals.requestId,
        jobId: result.jobId,
        success: result.success,
        errorType: result.error?.type,
        retryable: result.error?.retryable,
        durationMs: result.durationMs,
        logCount: result.logs.length,
      });

      res.status(result.success ? 200 : 400).json(result);
    }),
  );

  mountWorkspaceApi(app, runService);

  if (config.openApiEnabled) {
    const openApiDocument = createOpenApiDocument(config);
    const swaggerHtml = createSwaggerHtml(config);

    app.get(config.openApiJsonPath, (_req, res) => {
      res.status(200).json(openApiDocument);
    });

    app.get(config.swaggerUiPath, (_req, res) => {
      res.status(200).type("html").send(swaggerHtml);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({
      error: "Not found",
    });
  });

  app.use(errorHandler);

  return {
    app,
    close: (graceMs: number) => pool.close(graceMs),
  };
}

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const status = getErrorStatus(error);
  const serialized = serializeError(error, {
    includeStack: process.env.NODE_ENV !== "production",
    retryable: getErrorRetryability(error, status),
  });

  logger.error("http.request.failed", {
    requestId: res.locals.requestId,
    method: req.method,
    path: req.path,
    status,
    errorType: serialized.type,
    retryable: serialized.retryable,
    error: logger.serializeLogError(error),
  });

  res.status(status).json({
    success: false,
    error: serialized,
  });
};

const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  const requestId = randomUUID();
  res.locals.requestId = requestId;

  logger.info("http.request.started", {
    requestId,
    method: req.method,
    path: req.path,
    remoteAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.on("finish", () => {
    logger.info("http.request.finished", {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
};

function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getErrorStatus(error: unknown) {
  if (error instanceof HttpError) return error.status;

  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    return 413;
  }

  if (error instanceof SyntaxError) return 400;

  return 500;
}

function getErrorRetryability(error: unknown, status: number) {
  if (error instanceof HttpError) return error.retryable;

  return status >= 500;
}

function summarizePermissions(input: unknown) {
  if (input === undefined) return "default";
  if (input === "none" || input === "inherit") return input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "invalid";
  }

  const value = input as Record<string, unknown>;

  return {
    read: summarizePermissionValue(value.read),
    write: summarizePermissionValue(value.write),
    net: summarizePermissionValue(value.net),
    env: summarizePermissionValue(value.env),
    sys: summarizePermissionValue(value.sys),
    ffi: value.ffi,
    run: value.run,
  };
}

function summarizePermissionValue(value: unknown) {
  if (Array.isArray(value)) return { mode: "allowlist", count: value.length };
  return value;
}
