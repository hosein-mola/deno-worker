-- CreateTable
CREATE TABLE "CodeVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "JobRecord" (
    "jobId" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "codeName" TEXT NOT NULL,
    "codeVersion" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "result" JSONB,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "CodeVersion_name_idx" ON "CodeVersion"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CodeVersion_name_version_key" ON "CodeVersion"("name", "version");

-- CreateIndex
CREATE INDEX "JobRecord_status_idx" ON "JobRecord"("status");

-- CreateIndex
CREATE INDEX "JobRecord_codeName_codeVersion_idx" ON "JobRecord"("codeName", "codeVersion");

-- CreateIndex
CREATE INDEX "JobRecord_startedAt_idx" ON "JobRecord"("startedAt");
