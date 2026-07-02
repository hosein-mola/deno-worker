import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import * as logger from "./logger.js";
import { initStore } from "./store.js";

const config = loadConfig();

logger.info("server.starting", {
  port: config.port,
  poolSize: config.poolSize,
  maxRequestBytes: config.maxRequestBytes,
  queueTimeoutMs: config.queueTimeoutMs,
  runnerResponseGraceMs: config.runnerResponseGraceMs,
  dbWorkerPoolSize: config.dbWorkerPoolSize,
  dbQueryQueueTimeoutMs: config.dbQueryQueueTimeoutMs,
  dbQueryQueueLimit: config.dbQueryQueueLimit,
  dbConnectionCacheTtlMs: config.dbConnectionCacheTtlMs,
  shutdownGraceMs: config.shutdownGraceMs,
  allowInheritPermissions: config.allowInheritPermissions,
  openApiEnabled: config.openApiEnabled,
  openApiJsonPath: config.openApiJsonPath,
  swaggerUiPath: config.swaggerUiPath,
  nodeEnv: process.env.NODE_ENV,
  logLevel: process.env.LOG_LEVEL ?? "info",
});

await initStore();

const { app, close } = createApp(config);

const server = app.listen(config.port, () => {
  const baseUrl = `http://localhost:${config.port}`;

  logger.info("server.listening", {
    port: config.port,
    url: baseUrl,
    docsUrl: config.openApiEnabled
      ? `${baseUrl}${config.swaggerUiPath}`
      : undefined,
    poolSize: config.poolSize,
  });

  logger.info("server.quick_commands", {
    health: {
      label: "Health check",
      command: `curl ${baseUrl}/health`,
    },
    openApiJson: config.openApiEnabled
      ? {
          label: "OpenAPI JSON",
          command: `curl ${baseUrl}${config.openApiJsonPath}`,
        }
      : undefined,
    swaggerUi: config.openApiEnabled
      ? {
          label: "Swagger UI",
          url: `${baseUrl}${config.swaggerUiPath}`,
          command: `curl ${baseUrl}${config.swaggerUiPath}`,
        }
      : undefined,
  });
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("server.shutdown.started", {
    signal,
    shutdownGraceMs: config.shutdownGraceMs,
  });

  server.close((error) => {
    if (error) {
      logger.error("server.http_close_failed", {
        error: logger.serializeLogError(error),
      });
      return;
    }

    logger.info("server.http_closed");
  });

  await close(config.shutdownGraceMs);
  logger.info("server.shutdown.finished", {
    signal,
  });
  await logger.flushLogs();
  process.exit(0);
}

process.on("SIGTERM", (signal) => {
  void shutdown(signal);
});

process.on("SIGINT", (signal) => {
  void shutdown(signal);
});
