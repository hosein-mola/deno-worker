-- CreateTable
CREATE TABLE "CodeWorkspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'typescript',
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "CodeWorkspaceVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "isAutosave" BOOLEAN NOT NULL DEFAULT false,
    "clientRequestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "referer" TEXT,
    "meta" TEXT NOT NULL DEFAULT '{}',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT NOT NULL,
    CONSTRAINT "CodeWorkspaceVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "CodeWorkspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CodeWorker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'deno',
    "queue" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'offline',
    "desiredStatus" TEXT NOT NULL DEFAULT 'running',
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "currentJobId" TEXT,
    "heartbeatAt" DATETIME,
    "startedAt" DATETIME,
    "stoppedAt" DATETIME,
    "pid" INTEGER,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CodeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceVersionId" TEXT NOT NULL,
    "workspaceSlug" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "entryPath" TEXT NOT NULL,
    "functionName" TEXT NOT NULL,
    "args" TEXT NOT NULL DEFAULT '[]',
    "data" TEXT NOT NULL DEFAULT 'null',
    "checkpoint" TEXT NOT NULL DEFAULT 'null',
    "result" TEXT,
    "error" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "queue" TEXT NOT NULL DEFAULT 'default',
    "runtime" TEXT NOT NULL DEFAULT 'deno',
    "orchestrator" TEXT NOT NULL DEFAULT 'deno-worker',
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "requestedAction" TEXT,
    "leaseToken" TEXT,
    "lockedAt" DATETIME,
    "leaseExpiresAt" DATETIME,
    "nextRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdByUserId" TEXT NOT NULL DEFAULT 'local-dev',
    "workerId" TEXT,
    "temporalWorkflowId" TEXT,
    "temporalRunId" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "CodeJob_workspaceVersionId_fkey" FOREIGN KEY ("workspaceVersionId") REFERENCES "CodeWorkspaceVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CodeJob_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "CodeWorker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CodeJobLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" TEXT NOT NULL,
    "workerId" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "meta" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CodeJobLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CodeJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CodeJobLog_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "CodeWorker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CodeWorkspace_createdByUserId_slug_key" ON "CodeWorkspace"("createdByUserId", "slug");

-- CreateIndex
CREATE INDEX "CodeWorkspace_slug_idx" ON "CodeWorkspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "CodeWorkspaceVersion_workspaceId_version_key" ON "CodeWorkspaceVersion"("workspaceId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CodeWorkspaceVersion_workspaceId_clientRequestId_key" ON "CodeWorkspaceVersion"("workspaceId", "clientRequestId");

-- CreateIndex
CREATE INDEX "CodeWorkspaceVersion_workspaceId_createdAt_idx" ON "CodeWorkspaceVersion"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "CodeWorkspaceVersion_snapshotHash_idx" ON "CodeWorkspaceVersion"("snapshotHash");

-- CreateIndex
CREATE INDEX "CodeWorker_queue_status_idx" ON "CodeWorker"("queue", "status");

-- CreateIndex
CREATE INDEX "CodeWorker_status_heartbeatAt_idx" ON "CodeWorker"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "CodeJob_queue_status_nextRunAt_idx" ON "CodeJob"("queue", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "CodeJob_status_nextRunAt_priority_idx" ON "CodeJob"("status", "nextRunAt", "priority");

-- CreateIndex
CREATE INDEX "CodeJob_workerId_status_idx" ON "CodeJob"("workerId", "status");

-- CreateIndex
CREATE INDEX "CodeJob_workspaceVersionId_createdAt_idx" ON "CodeJob"("workspaceVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "CodeJob_leaseExpiresAt_idx" ON "CodeJob"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "CodeJobLog_jobId_createdAt_idx" ON "CodeJobLog"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "CodeJobLog_level_createdAt_idx" ON "CodeJobLog"("level", "createdAt");
