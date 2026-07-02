export type PermissionSpec =
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

export type CodeBundle = {
  name: string;
  version: string;
  code: string;
};

export type CodeRef = {
  name: string;
  version: string;
};

export type RunHttpRequest = {
  jobId?: string;
  bundle?: CodeBundle;
  codeRef?: CodeRef;
  functionName?: string;
  data: unknown;
  args?: unknown[];
  permissions?: PermissionSpec;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
};

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "crashed"
  | "cancelled";

export type ErrorType =
  | "VALIDATION_ERROR"
  | "CODE_VERSION_CONFLICT"
  | "CODE_VERSION_NOT_FOUND"
  | "JOB_CONFLICT"
  | "JOB_ALREADY_RUNNING"
  | "POOL_BUSY"
  | "TIMEOUT"
  | "WORKER_PROCESS_CRASHED"
  | "DENO_RUNNER_ERROR"
  | "DENO_WORKER_ERROR"
  | "DENO_WORKER_MESSAGE_ERROR"
  | "FUNCTION_NOT_FOUND"
  | "USER_CODE_ERROR"
  | "PERMISSION_ERROR"
  | "OUTPUT_TOO_LARGE"
  | "INFRA_ERROR"
  | "UNKNOWN_ERROR";

export type StoredCodeVersion = {
  name: string;
  version: string;
  code: string;
  sha256: string;
  createdAt: string;
};

export type DenoPoolJob = {
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

export type DenoPoolResult = {
  jobId: string;
  success: boolean;
  output?: unknown;
  error?: {
    type: ErrorType | string;
    message: string;
    stack?: string;
    retryable: boolean;
  };
  logs: Array<{
    level: "info" | "warn" | "error" | "debug";
    message: string;
  }>;
  durationMs: number;
};

export type DbQueryRequestMessage = {
  type: "db.query";
  requestId: string;
  jobId: string;
  code: string;
  query: string;
  params?: unknown[] | Record<string, unknown> | null;
  timeoutMs?: number;
};

export type DbQueryResponseMessage = {
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
