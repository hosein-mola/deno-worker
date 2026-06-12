import type { ErrorType } from "./types.js";

export type SerializedError = {
  type: ErrorType | string;
  message: string;
  stack?: string;
  retryable: boolean;
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryable = false,
    public readonly type: ErrorType = status >= 500
      ? "INFRA_ERROR"
      : "VALIDATION_ERROR",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function serializeError(
  error: unknown,
  options: { includeStack?: boolean; retryable?: boolean } = {},
): SerializedError {
  const retryable = options.retryable ?? true;

  if (error instanceof Error) {
    return {
      type: error instanceof HttpError ? error.type : error.name,
      message: error.message,
      stack: options.includeStack ? error.stack : undefined,
      retryable,
    };
  }

  return {
    type: "UNKNOWN_ERROR",
    message: String(error),
    retryable,
  };
}
