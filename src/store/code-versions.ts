import { createHash } from "node:crypto";
import type { CodeBundle, StoredCodeVersion } from "../types.js";
import { HttpError } from "../errors.js";
import * as logger from "../logger.js";
import { prisma } from "./client.js";

const maxCodeVersionCacheEntries = readIntegerEnv("CODE_VERSION_CACHE_MAX", 1_000);
const codeVersionCacheTtlMs = readIntegerEnv("CODE_VERSION_CACHE_TTL_MS", 60_000);
const codeVersionCache = new Map<
  string,
  {
    expiresAt: number;
    value: StoredCodeVersion;
  }
>();

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
      const updated = await prisma.codeVersion.update({
        where: {
          name_version: {
            name: bundle.name,
            version: bundle.version,
          },
        },
        data: {
          code: bundle.code,
          sha256: nextHash,
        },
      });

      logger.info("code_version.updated", {
        codeName: bundle.name,
        codeVersion: bundle.version,
        existingSha256: existing.sha256,
        nextSha256: nextHash,
        codeLength: bundle.code.length,
      });

      return cacheCodeVersion(toStoredCodeVersion(updated));
    }

    logger.info("code_version.reused", {
      codeName: bundle.name,
      codeVersion: bundle.version,
      sha256: existing.sha256,
    });

    return cacheCodeVersion(toStoredCodeVersion(existing));
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

  return cacheCodeVersion(toStoredCodeVersion(stored));
}

export async function loadCodeVersion(
  name: string,
  version: string,
): Promise<StoredCodeVersion> {
  const cached = getCachedCodeVersion(name, version);
  if (cached && await isCachedCodeVersionFresh(cached)) return cached;

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

  return cacheCodeVersion(toStoredCodeVersion(stored));
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

function getCachedCodeVersion(name: string, version: string) {
  if (codeVersionCacheTtlMs <= 0) return null;

  const key = codeVersionCacheKey(name, version);
  const cached = codeVersionCache.get(key);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    codeVersionCache.delete(key);
    return null;
  }

  return cached.value;
}

async function isCachedCodeVersionFresh(value: StoredCodeVersion) {
  const stored = await prisma.codeVersion.findUnique({
    where: {
      name_version: {
        name: value.name,
        version: value.version,
      },
    },
    select: {
      sha256: true,
    },
  });

  if (stored?.sha256 === value.sha256) return true;

  codeVersionCache.delete(codeVersionCacheKey(value.name, value.version));
  return false;
}

function cacheCodeVersion(value: StoredCodeVersion) {
  if (codeVersionCacheTtlMs <= 0 || maxCodeVersionCacheEntries <= 0) {
    return value;
  }

  const key = codeVersionCacheKey(value.name, value.version);
  if (!codeVersionCache.has(key) && codeVersionCache.size >= maxCodeVersionCacheEntries) {
    const oldestKey = codeVersionCache.keys().next().value;
    if (oldestKey !== undefined) codeVersionCache.delete(oldestKey);
  }

  codeVersionCache.set(key, {
    expiresAt: Date.now() + codeVersionCacheTtlMs,
    value,
  });

  return value;
}

function codeVersionCacheKey(name: string, version: string) {
  return `${name}\0${version}`;
}

function readIntegerEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}
