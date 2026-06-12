import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { Prisma, PrismaClient } from "@prisma/client";
import type { LogEntry } from "../logger.js";
import * as logger from "../logger.js";

const databaseUrl = process.env.DATABASE_URL ?? "file:./data/deno-worker.db";
const adapter = new PrismaBetterSqlite3({ url: databaseUrl });

export const prisma = new PrismaClient({ adapter });

export async function connectStore() {
  logger.info("store.connecting", {
    databaseUrl: redactDatabaseUrl(databaseUrl),
  });

  await ensureDatabaseDirectory(databaseUrl);
  await prisma.$connect();
  await configureSqlite();
  logger.registerLogWriter(saveLogRecord);

  logger.info("store.connected", {
    databaseUrl: redactDatabaseUrl(databaseUrl),
  });
}

async function ensureDatabaseDirectory(url: string) {
  if (url === ":memory:") return;

  const path = url.replace(/^file:/, "");
  await mkdir(dirname(path), { recursive: true });
}

async function configureSqlite() {
  await prisma.$executeRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$executeRawUnsafe("PRAGMA busy_timeout = 5000");
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");

  logger.info("store.sqlite_configured", {
    journalMode: "WAL",
    busyTimeoutMs: 5000,
    foreignKeys: true,
  });
}

function redactDatabaseUrl(url: string) {
  if (url.startsWith("file:") || url === ":memory:") return url;
  return "[redacted]";
}

async function saveLogRecord(entry: LogEntry) {
  await prisma.logRecord.create({
    data: {
      ts: new Date(entry.ts),
      level: entry.level,
      event: entry.event,
      service: entry.service,
      fields: toJsonValue(entry.fields),
    },
  });
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (item === undefined) return null;
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Error) {
        return {
          name: item.name,
          message: item.message,
          stack: process.env.NODE_ENV === "production" ? undefined : item.stack,
        };
      }
      return item;
    }),
  ) as Prisma.InputJsonValue;
}
