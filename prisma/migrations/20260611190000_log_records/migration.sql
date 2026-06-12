CREATE TABLE "LogRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL,
    "level" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "LogRecord_ts_idx" ON "LogRecord"("ts");
CREATE INDEX "LogRecord_level_idx" ON "LogRecord"("level");
CREATE INDEX "LogRecord_event_idx" ON "LogRecord"("event");
CREATE INDEX "LogRecord_createdAt_idx" ON "LogRecord"("createdAt");
