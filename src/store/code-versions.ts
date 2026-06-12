import { createHash } from "node:crypto";
import type { CodeBundle, StoredCodeVersion } from "../types.js";
import { HttpError } from "../errors.js";
import * as logger from "../logger.js";
import { prisma } from "./client.js";

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function saveCodeVersion(
  bundle: CodeBundle,
): Promise<StoredCodeVersion> {
  const nextHash = sha256(bundle.code);
  const existing = await prisma.codeVersion.findUnique({
    where: {
      name_version: {
        name: bundle.name,
        version: bundle.version,
      },
    },
  });

  if (existing) {
    if (existing.sha256 !== nextHash) {
      logger.warn("code_version.conflict", {
        codeName: bundle.name,
        codeVersion: bundle.version,
        existingSha256: existing.sha256,
        nextSha256: nextHash,
      });

      throw new HttpError(
        409,
        `Version conflict: ${bundle.name}@${bundle.version} already exists with different code`,
        false,
        "CODE_VERSION_CONFLICT",
      );
    }

    logger.info("code_version.reused", {
      codeName: bundle.name,
      codeVersion: bundle.version,
      sha256: existing.sha256,
    });

    return toStoredCodeVersion(existing);
  }

  const stored = await prisma.codeVersion.create({
    data: {
      name: bundle.name,
      version: bundle.version,
      code: bundle.code,
      sha256: nextHash,
    },
  });

  logger.info("code_version.created", {
    codeName: bundle.name,
    codeVersion: bundle.version,
    sha256: nextHash,
    codeLength: bundle.code.length,
  });

  return toStoredCodeVersion(stored);
}

export async function loadCodeVersion(
  name: string,
  version: string,
): Promise<StoredCodeVersion> {
  const stored = await prisma.codeVersion.findUnique({
    where: {
      name_version: {
        name,
        version,
      },
    },
  });

  if (!stored) {
    logger.warn("code_version.not_found", {
      codeName: name,
      codeVersion: version,
    });

    throw new HttpError(
      404,
      `Code version not found: ${name}@${version}`,
      false,
      "CODE_VERSION_NOT_FOUND",
    );
  }

  logger.info("code_version.loaded", {
    codeName: name,
    codeVersion: version,
    sha256: stored.sha256,
  });

  return toStoredCodeVersion(stored);
}

function toStoredCodeVersion(input: {
  name: string;
  version: string;
  code: string;
  sha256: string;
  createdAt: Date;
}): StoredCodeVersion {
  return {
    name: input.name,
    version: input.version,
    code: input.code,
    sha256: input.sha256,
    createdAt: input.createdAt.toISOString(),
  };
}
