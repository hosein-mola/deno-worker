import type { AppConfig } from "./config.js";

export function createOpenApiDocument(config: AppConfig) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Durable Deno Pool API",
      version: "1.0.0",
      description:
        "Run user-provided JavaScript/TypeScript code inside a durable Deno runner pool.",
    },
    servers: [
      {
        url: config.publicBaseUrl ?? `http://localhost:${config.port}`,
      },
    ],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          operationId: "getHealth",
          responses: {
            "200": {
              description: "Service and pool status.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/HealthResponse",
                  },
                },
              },
            },
          },
        },
      },
      "/run": {
        post: {
          summary: "Run a code bundle or stored code version",
          operationId: "runCode",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RunHttpRequest",
                },
                examples: {
                  bundle: {
                    summary: "Run a new code bundle",
                    value: {
                      jobId: "example-job-1",
                      bundle: {
                        name: "hello",
                        version: "1.0.0",
                        code: "export function run(input, ctx) { ctx.log(\"ok\"); return { ok: true, input }; }",
                      },
                      functionName: "run",
                      data: {
                        x: 1,
                      },
                      permissions: "none",
                      timeoutMs: 5000,
                    },
                  },
                  codeRef: {
                    summary: "Run an existing code version",
                    value: {
                      jobId: "example-job-2",
                      codeRef: {
                        name: "hello",
                        version: "1.0.0",
                      },
                      functionName: "run",
                      data: {
                        fromRef: true,
                      },
                      permissions: "none",
                      timeoutMs: 5000,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Code executed successfully.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/DenoPoolResult",
                  },
                },
              },
            },
            "400": {
              description:
                "Validation failure, user-code failure, timeout, pool busy, or infrastructure error.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/DenoPoolResult",
                  },
                },
              },
            },
            "409": {
              description: "Job idempotency conflict or active duplicate job.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
            "413": {
              description: "Request body is larger than MAX_REQUEST_BYTES.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
            "500": {
              description: "Unexpected service error.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
          },
        },
      },
      "/api/process/code-workspaces/{slug}/versions/{version}/build": {
        post: {
          summary: "Build and persist a workspace version bundle",
          operationId: "buildProcessWorkspaceVersion",
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "version",
              in: "path",
              required: true,
              schema: { type: "integer", minimum: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/BuildWorkspaceBundleRequest",
                },
                example: {
                  entryPath: "/src/main.ts",
                  files: {
                    "/src/main.ts":
                      "import { helper } from './helper'; export function run(input) { return helper(input); }",
                    "/src/helper.ts": "export function helper(input) { return { ok: true, input }; }",
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Bundle built by the remote service and stored on the workspace version.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/BuildWorkspaceBundleResponse",
                  },
                },
              },
            },
            "400": {
              description: "Invalid payload or esbuild compilation failure.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/BuildWorkspaceBundleError",
                  },
                },
              },
            },
            "404": {
              description: "Workspace or version was not found.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
            "413": {
              description: "Source files or output bundle exceeded the configured service limit.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        HealthResponse: {
          type: "object",
          required: [
            "ok",
            "poolSize",
            "aliveRunners",
            "idleRunners",
            "queuedJobs",
            "closing",
          ],
          properties: {
            ok: {
              type: "boolean",
              example: true,
            },
            poolSize: {
              type: "integer",
              example: 4,
            },
            aliveRunners: {
              type: "integer",
              example: 4,
            },
            idleRunners: {
              type: "integer",
              example: 3,
            },
            queuedJobs: {
              type: "integer",
              example: 0,
            },
            closing: {
              type: "boolean",
              example: false,
            },
          },
        },
        RunHttpRequest: {
          type: "object",
          required: ["data"],
          oneOf: [
            {
              required: ["bundle"],
            },
            {
              required: ["codeRef"],
            },
          ],
          properties: {
            jobId: {
              type: "string",
              maxLength: 256,
              description:
                "Optional idempotency key. Reuse the same value for safe retry of the same normalized request.",
            },
            bundle: {
              $ref: "#/components/schemas/CodeBundle",
            },
            codeRef: {
              $ref: "#/components/schemas/CodeRef",
            },
            functionName: {
              type: "string",
              default: "run",
              example: "run",
            },
            data: {},
            args: {
              type: "array",
              items: {},
              default: [],
            },
            permissions: {
              $ref: "#/components/schemas/PermissionSpec",
              default: "none",
            },
            timeoutMs: {
              type: "integer",
              minimum: 100,
              maximum: 60000,
              default: 10000,
            },
            metadata: {
              type: "object",
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        CodeBundle: {
          type: "object",
          required: ["name", "version", "code"],
          properties: {
            name: {
              type: "string",
              example: "hello",
            },
            version: {
              type: "string",
              example: "1.0.0",
            },
            code: {
              type: "string",
              example:
                "export function run(input, ctx) { ctx.log(\"ok\"); return { ok: true, input }; }",
            },
          },
          additionalProperties: false,
        },
        CodeRef: {
          type: "object",
          required: ["name", "version"],
          properties: {
            name: {
              type: "string",
              example: "hello",
            },
            version: {
              type: "string",
              example: "1.0.0",
            },
          },
          additionalProperties: false,
        },
        BuildWorkspaceBundleRequest: {
          type: "object",
          required: ["entryPath", "files"],
          properties: {
            entryPath: {
              type: "string",
              minLength: 1,
              maxLength: 512,
              example: "/src/main.ts",
            },
            files: {
              type: "object",
              additionalProperties: {
                type: "string",
                maxLength: 500000,
              },
              description:
                "Virtual file system map keyed by absolute workspace paths. Relative imports are resolved inside this map; package imports remain external.",
            },
          },
          additionalProperties: false,
        },
        BuildWorkspaceBundleResponse: {
          type: "object",
          required: [
            "ok",
            "success",
            "version",
            "entryPath",
            "hash",
            "sizeBytes",
            "savedAt",
            "output",
            "warnings",
          ],
          properties: {
            ok: { type: "boolean", const: true },
            success: { type: "boolean", const: true },
            version: { type: "integer", minimum: 1 },
            entryPath: { type: "string", example: "/src/main.ts" },
            hash: { type: "string" },
            sizeBytes: { type: "integer" },
            savedAt: { type: "string", format: "date-time" },
            output: {
              type: "string",
              description: "Compiled ESM bundle that was persisted on the version.",
            },
            warnings: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        BuildWorkspaceBundleError: {
          type: "object",
          required: ["ok", "success", "entryPath", "error", "warnings"],
          properties: {
            ok: { type: "boolean", const: false },
            success: { type: "boolean", const: false },
            entryPath: { type: "string" },
            error: { type: "string" },
            warnings: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        PermissionSpec: {
          oneOf: [
            {
              type: "string",
              enum: ["none", "inherit"],
            },
            {
              type: "object",
              properties: {
                read: {
                  $ref: "#/components/schemas/PermissionValue",
                },
                write: {
                  $ref: "#/components/schemas/PermissionValue",
                },
                net: {
                  $ref: "#/components/schemas/PermissionValue",
                },
                env: {
                  $ref: "#/components/schemas/PermissionValue",
                },
                sys: {
                  $ref: "#/components/schemas/PermissionValue",
                },
                ffi: {
                  type: "boolean",
                  const: false,
                },
                run: {
                  type: "boolean",
                  const: false,
                },
              },
              additionalProperties: false,
            },
          ],
        },
        PermissionValue: {
          oneOf: [
            {
              type: "boolean",
            },
            {
              type: "array",
              items: {
                type: "string",
              },
            },
          ],
        },
        DenoPoolResult: {
          type: "object",
          required: ["jobId", "success", "logs", "durationMs"],
          properties: {
            jobId: {
              type: "string",
            },
            success: {
              type: "boolean",
            },
            output: {},
            error: {
              $ref: "#/components/schemas/SerializedError",
            },
            logs: {
              type: "array",
              items: {
                $ref: "#/components/schemas/LogEntry",
              },
            },
            durationMs: {
              type: "integer",
            },
          },
        },
        LogEntry: {
          type: "object",
          required: ["level", "message"],
          properties: {
            level: {
              type: "string",
              enum: ["info", "warn", "error", "debug"],
            },
            message: {
              type: "string",
            },
          },
        },
        SerializedError: {
          type: "object",
          required: ["type", "message", "retryable"],
          properties: {
            type: {
              type: "string",
              example: "WORKER_PROCESS_CRASHED",
            },
            message: {
              type: "string",
            },
            stack: {
              type: "string",
            },
            retryable: {
              type: "boolean",
            },
          },
        },
        ErrorResponse: {
          type: "object",
          required: ["success", "error"],
          properties: {
            success: {
              type: "boolean",
              const: false,
            },
            error: {
              $ref: "#/components/schemas/SerializedError",
            },
          },
        },
      },
    },
  };
}

export function createSwaggerHtml(config: AppConfig) {
  const jsonPath = JSON.stringify(config.openApiJsonPath);
  const cdnUrl = config.swaggerUiCdnUrl.replace(/\/+$/, "");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Durable Deno Pool API Docs</title>
    <link rel="stylesheet" href="${escapeHtml(cdnUrl)}/swagger-ui.css">
    <style>
      body { margin: 0; background: #fff; }
      .swagger-ui .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${escapeHtml(cdnUrl)}/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: ${jsonPath},
        dom_id: "#swagger-ui",
        deepLinking: true,
        persistAuthorization: true,
        tryItOutEnabled: true,
      });
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
