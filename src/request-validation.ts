import { createHash } from "node:crypto";
import { HttpError } from "./errors.js";
import type { PermissionSpec, RunHttpRequest } from "./types.js";

const maxNameLength = 128;
const maxVersionLength = 128;
const maxFunctionNameLength = 128;
const maxArgs = 32;

export function validateRunRequest(input: unknown): RunHttpRequest {
  if (!isPlainObject(input)) {
    throw validationError("Request body must be a JSON object");
  }

  const body = input as Partial<RunHttpRequest>;
  const hasBundle = body.bundle !== undefined;
  const hasCodeRef = body.codeRef !== undefined;

  if (hasBundle === hasCodeRef) {
    throw validationError("Exactly one of bundle or codeRef is required");
  }

  if (body.jobId !== undefined) validateNonEmptyString("jobId", body.jobId, 256);
  if (body.functionName !== undefined) {
    validateIdentifierLike("functionName", body.functionName);
  }
  if (!("data" in body)) {
    throw validationError("data is required");
  }
  if (body.args !== undefined) {
    if (!Array.isArray(body.args)) throw validationError("args must be an array");
    if (body.args.length > maxArgs) {
      throw validationError(`args cannot contain more than ${maxArgs} items`);
    }
  }
  if (body.timeoutMs !== undefined && !Number.isFinite(body.timeoutMs)) {
    throw validationError("timeoutMs must be a finite number");
  }
  if (body.metadata !== undefined && !isPlainObject(body.metadata)) {
    throw validationError("metadata must be an object when provided");
  }

  if (body.bundle) validateBundle(body.bundle);
  if (body.codeRef) validateCodeRef(body.codeRef);
  validatePermissions(body.permissions);

  return body as RunHttpRequest;
}

export function hashRunRequest(body: RunHttpRequest) {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

function validateBundle(bundle: unknown) {
  if (!isPlainObject(bundle)) throw validationError("bundle must be an object");

  const value = bundle as Record<string, unknown>;
  validateNonEmptyString("bundle.name", value.name, maxNameLength);
  validateNonEmptyString("bundle.version", value.version, maxVersionLength);
  validateNonEmptyString("bundle.code", value.code, 1_000_000);
}

function validateCodeRef(codeRef: unknown) {
  if (!isPlainObject(codeRef)) throw validationError("codeRef must be an object");

  const value = codeRef as Record<string, unknown>;
  validateNonEmptyString("codeRef.name", value.name, maxNameLength);
  validateNonEmptyString("codeRef.version", value.version, maxVersionLength);
}

function validateIdentifierLike(name: string, value: unknown) {
  validateNonEmptyString(name, value, maxFunctionNameLength);

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value as string)) {
    throw validationError(`${name} must be a valid exported function name`);
  }
}

function validatePermissions(input: PermissionSpec | undefined) {
  if (input === undefined || input === "none" || input === "inherit") return;
  if (!isPlainObject(input)) {
    throw validationError("permissions must be none, inherit, or an object");
  }

  for (const key of ["read", "write", "net", "env", "sys"] as const) {
    validatePermissionValue(`permissions.${key}`, input[key]);
  }

  if (input.ffi !== undefined && input.ffi !== false) {
    throw validationError("permissions.ffi can only be false");
  }
  if (input.run !== undefined && input.run !== false) {
    throw validationError("permissions.run can only be false");
  }
}

function validatePermissionValue(name: string, value: unknown) {
  if (value === undefined || typeof value === "boolean") return;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return;
  }

  throw validationError(`${name} must be a boolean or string array`);
}

function validateNonEmptyString(name: string, value: unknown, maxLength: number) {
  if (typeof value !== "string" || value.trim() === "") {
    throw validationError(`${name} must be a non-empty string`);
  }

  if (value.length > maxLength) {
    throw validationError(`${name} cannot exceed ${maxLength} characters`);
  }
}

function validationError(message: string) {
  return new HttpError(400, message, false, "VALIDATION_ERROR");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}
