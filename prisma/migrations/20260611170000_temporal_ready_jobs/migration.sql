PRAGMA foreign_keys=OFF;

CREATE TABLE "new_JobRecord" (
    "jobId" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "codeName" TEXT NOT NULL,
    "codeVersion" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "requestHash" TEXT NOT NULL,
    "requestSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "result" JSONB,
    "errorType" TEXT,
    "runnerId" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "heartbeatAt" DATETIME,
    "finishedAt" DATETIME
);

INSERT INTO "new_JobRecord" (
    "jobId",
    "status",
    "codeName",
    "codeVersion",
    "request",
    "requestHash",
    "requestSchemaVersion",
    "result",
    "errorType",
    "runnerId",
    "attempts",
    "queuedAt",
    "startedAt",
    "heartbeatAt",
    "finishedAt"
)
SELECT
    "jobId",
    "status",
    "codeName",
    "codeVersion",
    "request",
    '',
    1,
    "result",
    json_extract("result", '$.error.type'),
    NULL,
    CASE WHEN "status" IN ('running', 'completed', 'failed', 'crashed', 'timed_out') THEN 1 ELSE 0 END,
    "startedAt",
    CASE WHEN "status" = 'running' THEN "startedAt" ELSE NULL END,
    CASE WHEN "status" = 'running' THEN "startedAt" ELSE NULL END,
    "finishedAt"
FROM "JobRecord";

DROP TABLE "JobRecord";
ALTER TABLE "new_JobRecord" RENAME TO "JobRecord";

CREATE INDEX "JobRecord_status_idx" ON "JobRecord"("status");
CREATE INDEX "JobRecord_codeName_codeVersion_idx" ON "JobRecord"("codeName", "codeVersion");
CREATE INDEX "JobRecord_requestHash_idx" ON "JobRecord"("requestHash");
CREATE INDEX "JobRecord_queuedAt_idx" ON "JobRecord"("queuedAt");
CREATE INDEX "JobRecord_startedAt_idx" ON "JobRecord"("startedAt");

PRAGMA foreign_keys=ON;
