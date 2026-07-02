import { createHash } from "node:crypto";
import type { RequestHandler, Router } from "express";
import { buildBundle } from "./build-service.js";
import { HttpError } from "./errors.js";
import type { RunService } from "./run-service.js";
import { prisma } from "./store/client.js";

const MAX_SNAPSHOT_BYTES = 2_000_000;
const MAX_BUNDLE_BYTES = 2_000_000;
const DEFAULT_USER_ID = "local-dev";

type JsonObject = Record<string, unknown>;

type WorkspaceRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  language: string;
  currentVersion: number;
  updatedAt: Date;
  createdByUserId: string;
};

type BundleMeta = {
  bundles?: Record<
    string,
    { code?: unknown; hash?: unknown; sizeBytes?: unknown; savedAt?: unknown }
  >;
  description?: unknown;
};

type PersistedBundle = {
  entryPath: string;
  code: string;
  hash: string;
  sizeBytes: number;
  savedAt: string;
};

export function mountWorkspaceApi(router: Router, runService: RunService) {
  router.get("/api/process/code-workspaces", listWorkspaces);
  router.post("/api/process/code-workspaces", createWorkspace);
  router.get("/api/process/code-workspaces/:slug", loadWorkspace);
  router.post("/api/process/code-workspaces/:slug", saveWorkspaceVersion);
  router.get("/api/process/code-workspaces/:slug/versions", listVersions);
  router.get("/api/process/code-workspaces/:slug/versions/:version", loadVersion);
  router.post(
    "/api/process/code-workspaces/:slug/versions/:version/bundle",
    saveBundle,
  );
  router.post(
    "/api/process/code-workspaces/:slug/versions/:version/build",
    buildAndSaveBundle,
  );
  router.post(
    "/api/process/code-workspaces/:slug/versions/:version/run",
    runSavedBundle(runService),
  );
  router.get("/api/process/code-jobs", listCodeJobs);
  router.post("/api/process/code-jobs", createCodeJob(runService));
  router.get("/api/process/code-jobs/:jobId/logs", listCodeJobLogs);
  router.post("/api/process/code-jobs/:jobId/actions", controlCodeJob(runService));
  router.post("/api/process/code-jobs/workers", controlWorkers);
}

const listWorkspaces: RequestHandler = async (req, res) => {
  const userId = getUserIdentity(req);
  const ownerIds = userId === "public" ? ["public"] : [userId, "public"];
  const workspaces = await prisma.codeWorkspace.findMany({
    where: { createdByUserId: { in: ownerIds }, active: true },
    orderBy: { updatedAt: "desc" },
    select: workspaceSelect,
  });

  const deduped = new Map<string, WorkspaceRow>();
  for (const workspace of workspaces) {
    const existing = deduped.get(workspace.slug);
    if (!existing) {
      deduped.set(workspace.slug, workspace);
      continue;
    }

    if (
      (existing.createdByUserId !== userId && workspace.createdByUserId === userId) ||
      workspace.updatedAt > existing.updatedAt
    ) {
      deduped.set(workspace.slug, workspace);
    }
  }

  res.json({ workspaces: Array.from(deduped.values()).map(toWorkspaceDto) });
};

const createWorkspace: RequestHandler = async (req, res) => {
  const body = requireObject(req.body);
  const slug = requireSlug(body.slug);
  const name = requireString(body.name, "name", 120);
  const description =
    body.description === undefined
      ? ""
      : requireString(body.description, "description", 2_000);
  const snapshot = body.initialSnapshot;
  if (snapshot !== undefined) validateSnapshot(snapshot);

  const userId = getUserIdentity(req);
  const existing = await prisma.codeWorkspace.findUnique({
    where: { createdByUserId_slug: { createdByUserId: userId, slug } },
    select: { id: true },
  });
  if (existing) throw new HttpError(409, `Project slug already exists: ${slug}`);

  const snapshotStr = snapshot ? JSON.stringify(snapshot) : null;
  const sizeBytes = snapshotStr ? byteLength(snapshotStr) : 0;
  if (sizeBytes > MAX_SNAPSHOT_BYTES) {
    throw new HttpError(413, "Initial snapshot too large (max 2MB)");
  }

  const created = await prisma.$transaction(async (tx) => {
    const workspace = await tx.codeWorkspace.create({
      data: {
        slug,
        name,
        description,
        language: "typescript",
        createdByUserId: userId,
        updatedByUserId: userId,
      },
    });

    if (!snapshotStr) return { workspace, latest: null };

    const latest = await tx.codeWorkspaceVersion.create({
      data: {
        workspaceId: workspace.id,
        version: 1,
        snapshot: snapshotStr,
        snapshotHash: sha256Hex(snapshotStr),
        message: "Initial version",
        isAutosave: false,
        sizeBytes,
        createdByUserId: userId,
      },
      select: { id: true, version: true },
    });

    const updatedWorkspace = await tx.codeWorkspace.update({
      where: { id: workspace.id },
      data: { currentVersion: 1, updatedByUserId: userId },
    });

    return { workspace: updatedWorkspace, latest };
  });

  res.status(201).json({
    workspace: toWorkspaceDto(created.workspace),
    latest: created.latest,
  });
};

const loadWorkspace: RequestHandler = async (req, res) => {
  const workspace = await findWorkspaceBySlug(routeParam(req.params.slug), getUserIdentity(req));
  if (!workspace) {
    res.json({ workspace: null, latest: null, versions: [] });
    return;
  }

  const [versions, latest] = await Promise.all([
    prisma.codeWorkspaceVersion.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { version: "desc" },
      take: 50,
      select: versionSummarySelect,
    }),
    prisma.codeWorkspaceVersion.findFirst({
      where: { workspaceId: workspace.id },
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        snapshot: true,
        message: true,
        createdAt: true,
      },
    }),
  ]);

  res.json({
    workspace: {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      description: workspace.description,
      language: workspace.language,
      currentVersion: Math.max(
        workspace.currentVersion,
        versions[0]?.version ?? 0,
      ),
      updatedAt: workspace.updatedAt,
    },
    latest,
    versions: versions.map(toVersionSummaryDto),
  });
};

const saveWorkspaceVersion: RequestHandler = async (req, res) => {
  const slug = routeParam(req.params.slug);
  const body = requireObject(req.body);
  validateSnapshot(body.snapshot);
  const message =
    body.message === undefined
      ? undefined
      : requireString(body.message, "message", 2_000);
  const description =
    body.description === undefined
      ? undefined
      : requireString(body.description, "description", 2_000);
  const saveMode =
    body.saveMode === undefined ? "draft" : requireSaveMode(body.saveMode);
  const targetVersion =
    body.targetVersion === undefined
      ? null
      : parsePositiveVersion(body.targetVersion);
  const isAutosave =
    body.isAutosave === undefined ? false : requireBoolean(body.isAutosave, "isAutosave");
  const clientRequestId =
    body.clientRequestId === undefined
      ? undefined
      : requireString(body.clientRequestId, "clientRequestId", 128, 8);
  const snapshotStr = JSON.stringify(body.snapshot);
  const sizeBytes = byteLength(snapshotStr);
  if (sizeBytes > MAX_SNAPSHOT_BYTES) {
    throw new HttpError(413, "Snapshot too large (max 2MB)");
  }

  const userId = getUserIdentity(req);
  let workspace = await findWorkspaceBySlug(slug, userId);
  if (!workspace) {
    workspace = await prisma.codeWorkspace.create({
      data: {
        slug,
        name: slug,
        description: "",
        language: "typescript",
        createdByUserId: userId,
        updatedByUserId: userId,
      },
    });
  }

  if (clientRequestId) {
    const existing = await prisma.codeWorkspaceVersion.findUnique({
      where: {
        workspaceId_clientRequestId: {
          workspaceId: workspace.id,
          clientRequestId,
        },
      },
      select: versionSummarySelect,
    });
    if (existing) {
      res.json({ workspaceId: workspace.id, ...toVersionSummaryDto(existing) });
      return;
    }
  }

  const saved = await prisma.$transaction(async (tx) => {
    const ws = await tx.codeWorkspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { id: true, currentVersion: true },
    });

    if (saveMode === "draft") {
      const latest = await tx.codeWorkspaceVersion.findFirst({
        where: { workspaceId: ws.id },
        orderBy: { version: "desc" },
        select: { id: true, version: true, meta: true },
      });
      const requestedVersion = targetVersion ?? (ws.currentVersion > 0 ? ws.currentVersion : null);

      const existing = requestedVersion
        ? await tx.codeWorkspaceVersion.findUnique({
            where: { workspaceId_version: { workspaceId: ws.id, version: requestedVersion } },
            select: { id: true, version: true, meta: true },
          })
        : null;
      const versionToUpdate = existing ?? latest;
      const version = versionToUpdate?.version ?? 1;
      const existingMeta = versionToUpdate?.meta ?? "{}";
      const meta = writeVersionDescription(existingMeta, description);

      if (versionToUpdate) {
        const row = await tx.codeWorkspaceVersion.update({
          where: { id: versionToUpdate.id },
          data: {
            snapshot: snapshotStr,
            snapshotHash: sha256Hex(snapshotStr),
            ...(message !== undefined ? { message } : {}),
            isAutosave,
            clientRequestId,
            ip: getClientIp(req),
            userAgent: req.get("user-agent") ?? null,
            referer: req.get("referer") ?? null,
            meta,
            sizeBytes,
            createdByUserId: userId,
          },
          select: versionSummarySelect,
        });
        await tx.codeWorkspace.update({
          where: { id: ws.id },
          data: {
            currentVersion: version,
            updatedByUserId: userId,
          },
        });
        return row;
      }

      const initialMeta = writeVersionDescription("{}", description);
      const row = await tx.codeWorkspaceVersion.create({
        data: {
          workspaceId: ws.id,
          version,
          snapshot: snapshotStr,
          snapshotHash: sha256Hex(snapshotStr),
          message: message ?? "",
          isAutosave,
          clientRequestId,
          ip: getClientIp(req),
          userAgent: req.get("user-agent") ?? null,
          referer: req.get("referer") ?? null,
          meta: initialMeta,
          sizeBytes,
          createdByUserId: userId,
        },
        select: versionSummarySelect,
      });
      await tx.codeWorkspace.update({
        where: { id: ws.id },
        data: { currentVersion: version, updatedByUserId: userId },
      });
      return row;
    }

    if (!message) {
      throw new HttpError(400, "message is required to publish a version");
    }

    const latest = await tx.codeWorkspaceVersion.findFirst({
      where: { workspaceId: ws.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = Math.max(ws.currentVersion, latest?.version ?? 0) + 1;
    const row = await tx.codeWorkspaceVersion.create({
      data: {
        workspaceId: ws.id,
        version,
        snapshot: snapshotStr,
        snapshotHash: sha256Hex(snapshotStr),
        message,
        isAutosave: false,
        clientRequestId,
        ip: getClientIp(req),
        userAgent: req.get("user-agent") ?? null,
        referer: req.get("referer") ?? null,
        meta: writeVersionDescription("{}", description ?? ""),
        sizeBytes,
        createdByUserId: userId,
      },
      select: versionSummarySelect,
    });
    await tx.codeWorkspace.update({
      where: { id: ws.id },
      data: { currentVersion: version, updatedByUserId: userId },
    });
    return row;
  });

  res
    .status(saveMode === "publish" ? 201 : 200)
    .json({ workspaceId: workspace.id, ...toVersionSummaryDto(saved) });
};

const listVersions: RequestHandler = async (req, res) => {
  const workspace = await findWorkspaceBySlug(routeParam(req.params.slug), getUserIdentity(req));
  if (!workspace) {
    res.json({ versions: [] });
    return;
  }

  const limit = clampInt(req.query.limit, 1, 100, 50);
  const beforeVersion =
    req.query.beforeVersion === undefined
      ? null
      : clampInt(req.query.beforeVersion, 1, Number.MAX_SAFE_INTEGER, 0);
  const versions = await prisma.codeWorkspaceVersion.findMany({
    where: {
      workspaceId: workspace.id,
      ...(beforeVersion ? { version: { lt: beforeVersion } } : {}),
    },
    orderBy: { version: "desc" },
    take: limit,
    select: versionSummarySelect,
  });

  res.json({ versions: versions.map(toVersionSummaryDto) });
};

const loadVersion: RequestHandler = async (req, res) => {
  const parsedVersion = parsePositiveVersion(routeParam(req.params.version));
  const workspace = await findWorkspaceBySlug(routeParam(req.params.slug), getUserIdentity(req));
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const row = await prisma.codeWorkspaceVersion.findUnique({
    where: {
      workspaceId_version: {
        workspaceId: workspace.id,
        version: parsedVersion,
      },
    },
    select: {
      id: true,
      version: true,
      snapshot: true,
      message: true,
      createdAt: true,
      snapshotHash: true,
      sizeBytes: true,
      meta: true,
    },
  });
  if (!row) throw new HttpError(404, "Version not found");
  res.json({ ...row, description: readVersionDescription(row.meta) });
};

const saveBundle: RequestHandler = async (req, res) => {
  const parsedVersion = parsePositiveVersion(routeParam(req.params.version));
  const body = requireObject(req.body);
  const entryPath = normalizeEntryPath(requireString(body.entryPath, "entryPath", 512, 1));
  const code = requireString(body.code, "code", 2_000_000, 1);

  const workspace = await findWorkspaceBySlug(routeParam(req.params.slug), getUserIdentity(req));
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const saved = await persistBundle(workspace.id, parsedVersion, { entryPath, code });
  res.json(saved);
};

const buildAndSaveBundle: RequestHandler = async (req, res) => {
  const parsedVersion = parsePositiveVersion(routeParam(req.params.version));
  const body = requireObject(req.body);
  const entryPath = normalizeEntryPath(requireString(body.entryPath, "entryPath", 512, 1));
  const files = requireFilesMap(body.files);

  const workspace = await findWorkspaceBySlug(routeParam(req.params.slug), getUserIdentity(req));
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const versionRow = await prisma.codeWorkspaceVersion.findUnique({
    where: {
      workspaceId_version: { workspaceId: workspace.id, version: parsedVersion },
    },
    select: { id: true },
  });
  if (!versionRow) throw new HttpError(404, "Version not found");

  const result = await buildBundle({ entryPath, files });
  if (!result.ok) {
    res.status(400).json({
      ok: false,
      success: false,
      entryPath: result.entryPath,
      error: result.error,
      warnings: result.warnings,
    });
    return;
  }

  const saved = await persistBundle(workspace.id, parsedVersion, {
    entryPath: result.entryPath,
    code: result.output,
  });

  res.json({
    ...saved,
    ok: true,
    output: result.output,
    warnings: result.warnings,
  });
};

function runSavedBundle(runService: RunService): RequestHandler {
  return async (req, res) => {
    const parsedVersion = parsePositiveVersion(routeParam(req.params.version));
    const body = requireObject(req.body);
    const functionName = requireIdentifier(body.functionName, "functionName");
    const requestedEntryPath =
      body.entryPath === undefined
        ? null
        : normalizeEntryPath(requireString(body.entryPath, "entryPath", 512, 1));
    const timeoutMs =
      body.timeoutMs === undefined ? undefined : clampInt(body.timeoutMs, 100, 60_000, 10_000);

    const workspace = await findWorkspaceBySlug(routeParam(req.params.slug), getUserIdentity(req));
    if (!workspace) throw new HttpError(404, "Workspace not found");
    const resolved = await resolveStoredBundle(workspace.id, workspace.slug, parsedVersion, requestedEntryPath);
    if (!resolved) {
      const versionRow = await prisma.codeWorkspaceVersion.findUnique({
        where: { workspaceId_version: { workspaceId: workspace.id, version: parsedVersion } },
        select: { meta: true },
      });
      res.status(404).json({
        success: false,
        error: versionRow
          ? requestedEntryPath
            ? `Bundle not found in database for entry: ${requestedEntryPath}`
            : "Bundle not found in database for this version"
          : "Version not found",
        availableEntries: versionRow ? listAvailableBundleEntries(versionRow.meta) : [],
      });
      return;
    }

    const result = await runService.run({
      bundle: {
        name: workspace.slug,
        version: String(parsedVersion),
        code: prepareCodeForRemoteModuleImport(resolved.bundle.code, functionName),
      },
      functionName,
      data: body.data ?? null,
      permissions: "none",
      timeoutMs,
      metadata: {
        workspaceSlug: workspace.slug,
        version: parsedVersion,
        entryPath: resolved.entryPath,
      },
    });

    res.status(result.success ? 200 : 400).json({
      success: result.success,
      jobId: result.jobId,
      ...(result.success
        ? { result: result.output }
        : {
            error: result.error?.message ?? "Code runner failed",
            errorType: result.error?.type ?? null,
            retryable: result.error?.retryable ?? null,
          }),
      logs: result.logs.map((entry) => entry.message),
      durationMs: result.durationMs,
      meta: {
        used: "remote-runner",
        entryPath: resolved.entryPath,
        requestedEntryPath,
        hash: resolved.bundle.hash,
        sizeBytes: resolved.bundle.sizeBytes,
        savedAt: resolved.bundle.savedAt,
      },
    });
  };
}

const listCodeJobs: RequestHandler = async (_req, res) => {
  const [jobs, workers, logs, workspaces] = await Promise.all([
    prisma.codeJob.findMany({
      orderBy: [{ createdAt: "desc" }],
      take: 50,
      include: { worker: { select: { id: true, name: true, status: true, heartbeatAt: true } } },
    }),
    prisma.codeWorker.findMany({ orderBy: [{ queue: "asc" }, { name: "asc" }] }),
    prisma.codeJobLog.findMany({
      orderBy: [{ createdAt: "desc" }],
      take: 80,
      include: {
        job: { select: { id: true, workspaceSlug: true, entryPath: true, functionName: true } },
      },
    }),
    prisma.codeWorkspace.findMany({
      where: { active: true },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        slug: true,
        name: true,
        currentVersion: true,
        versions: {
          orderBy: { version: "desc" },
          take: 10,
          select: { id: true, version: true, meta: true, createdAt: true },
        },
      },
    }),
  ]);

  res.json({
    jobs,
    workers,
    logs,
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      currentVersion: Math.max(
        workspace.currentVersion,
        workspace.versions[0]?.version ?? 0,
      ),
      versions: workspace.versions.map((version) => ({
        id: version.id,
        version: version.version,
        createdAt: version.createdAt,
        bundleEntries: listAvailableBundleEntries(version.meta),
      })),
    })),
    counts: countJobs(jobs),
    runtime: {
      deno: { available: true, version: "managed by deno-worker service" },
      temporal: { available: false, version: "not used", sdkAvailable: false, mode: "deno-worker" },
    },
    pool: { localActiveWorkers: 0, workerIds: [] },
  });
};

function createCodeJob(runService: RunService): RequestHandler {
  return async (req, res) => {
    const body = requireObject(req.body);
    const userId = getUserIdentity(req);
    const workspaceSlug = requireString(body.workspaceSlug, "workspaceSlug", 128, 1);
    const version = parsePositiveVersion(body.version);
    const entryPath = normalizeEntryPath(requireString(body.entryPath, "entryPath", 512, 1));
    const functionName = requireIdentifier(body.functionName, "functionName");
    const queue = body.queue === undefined ? "default" : requireString(body.queue, "queue", 80, 1);
    const priority = body.priority === undefined ? 0 : clampInt(body.priority, -100, 100, 0);
    const timeoutMs = body.timeoutMs === undefined ? 30_000 : clampInt(body.timeoutMs, 100, 60_000, 30_000);
    const maxAttempts = body.maxAttempts === undefined ? 1 : clampInt(body.maxAttempts, 1, 10, 1);
    const runNow = body.runNow === undefined ? true : requireBoolean(body.runNow, "runNow");
    const workspace = await findWorkspaceBySlug(workspaceSlug, userId);
    if (!workspace) throw new HttpError(404, "Workspace not found");

    const resolved = await resolveStoredBundle(workspace.id, workspace.slug, version, entryPath);
    if (!resolved) throw new HttpError(404, `Bundle not found in database for entry: ${entryPath}`);

    const job = await prisma.codeJob.create({
      data: {
        workspaceVersionId: resolved.versionId,
        workspaceSlug: workspace.slug,
        version,
        entryPath: resolved.entryPath,
        functionName,
        args: "[]",
        data: JSON.stringify(body.data ?? null),
        queue,
        priority,
        timeoutMs,
        maxAttempts,
        runtime: "deno",
        orchestrator: "deno-worker",
        createdByUserId: userId,
        metadata: JSON.stringify({
          requestedEntryPath: entryPath,
          bundleHash: resolved.bundle.hash,
        }),
      },
    });
    await addJobLog(job.id, null, "info", `Job queued for ${workspace.slug} v${version} ${resolved.entryPath}.${functionName}`);

    if (runNow) {
      void executeCodeJob(job.id, runService).catch(async (error) => {
        await markCodeJobFailed(job.id, error);
      });
    }

    res.json({ success: true, job });
  };
}

const listCodeJobLogs: RequestHandler = async (req, res) => {
  const logs = await prisma.codeJobLog.findMany({
    where: { jobId: routeParam(req.params.jobId) },
    orderBy: [{ sequence: "asc" }, { createdAt: "asc" }],
    take: 500,
  });
  res.json({ logs });
};

function controlCodeJob(runService: RunService): RequestHandler {
  return async (req, res) => {
    const action = requireString(requireObject(req.body).action, "action", 16, 1);
    const job = await prisma.codeJob.findUnique({ where: { id: routeParam(req.params.jobId) } });
    if (!job) throw new HttpError(404, "Job not found");

    if (action === "retry") {
      await prisma.codeJob.update({
        where: { id: job.id },
        data: {
          status: "queued",
          requestedAction: null,
          error: null,
          result: null,
          progress: 0,
          attempt: 0,
          nextRunAt: new Date(),
          completedAt: null,
        },
      });
      await addJobLog(job.id, null, "info", "Retry requested by operator.");
      void executeCodeJob(job.id, runService).catch(async (error) => {
        await markCodeJobFailed(job.id, error);
      });
      res.json({ success: true });
      return;
    }

    if (action === "cancel" || action === "pause") {
      await prisma.codeJob.update({
        where: { id: job.id },
        data: {
          status: action === "cancel" ? "cancelled" : "paused",
          requestedAction: null,
          completedAt: action === "cancel" ? new Date() : null,
        },
      });
      await addJobLog(job.id, null, "warn", `${action} requested by operator.`);
      res.json({ success: true });
      return;
    }

    if (action === "resume") {
      await prisma.codeJob.update({
        where: { id: job.id },
        data: { status: "queued", nextRunAt: new Date(), completedAt: null },
      });
      await addJobLog(job.id, null, "info", "Job resumed by operator.");
      void executeCodeJob(job.id, runService).catch(async (error) => {
        await markCodeJobFailed(job.id, error);
      });
      res.json({ success: true });
      return;
    }

    throw new HttpError(400, "Invalid action");
  };
}

const controlWorkers: RequestHandler = async (req, res) => {
  const body = requireObject(req.body);
  const action = requireString(body.action, "action", 16, 1);
  const queue = body.queue === undefined ? "default" : requireString(body.queue, "queue", 80, 1);
  const workerCount = body.workerCount === undefined ? 2 : clampInt(body.workerCount, 1, 8, 2);

  if (!["start", "pause", "resume", "stop"].includes(action)) {
    throw new HttpError(400, "Invalid worker action");
  }

  await prisma.codeWorker.upsert({
    where: { id: `deno-worker-${queue}` },
    create: {
      id: `deno-worker-${queue}`,
      name: `Deno Worker ${queue}`,
      kind: "deno",
      queue,
      desiredStatus: action === "stop" ? "stopped" : action === "pause" ? "paused" : "running",
      status: action === "stop" ? "offline" : action === "pause" ? "paused" : "idle",
      concurrency: workerCount,
      heartbeatAt: new Date(),
      startedAt: action === "stop" ? null : new Date(),
      stoppedAt: action === "stop" ? new Date() : null,
    },
    update: {
      desiredStatus: action === "stop" ? "stopped" : action === "pause" ? "paused" : "running",
      status: action === "stop" ? "offline" : action === "pause" ? "paused" : "idle",
      concurrency: workerCount,
      heartbeatAt: new Date(),
      stoppedAt: action === "stop" ? new Date() : null,
    },
  });

  res.json({ success: true, pool: { localActiveWorkers: action === "stop" ? 0 : workerCount, workerIds: [`deno-worker-${queue}`] } });
};

async function executeCodeJob(jobId: string, runService: RunService) {
  const job = await prisma.codeJob.findUnique({
    where: { id: jobId },
    include: { workspaceVersion: { select: { id: true, meta: true } } },
  });
  if (!job || job.status === "cancelled") return;

  await prisma.codeJob.update({
    where: { id: job.id },
    data: { status: "running", startedAt: new Date(), attempt: { increment: 1 } },
  });
  await addJobLog(job.id, null, "info", `Deno Worker started attempt ${job.attempt + 1}.`);

  const resolved = resolveBundleFromMeta(job.workspaceVersion.meta, job.entryPath);
  if (!resolved || typeof resolved.bundle.code !== "string") {
    throw new Error(`Bundle not found for entry ${job.entryPath}`);
  }

  const result = await runService.run({
    bundle: {
      name: job.workspaceSlug,
      version: String(job.version),
      code: prepareCodeForRemoteModuleImport(String(resolved.bundle.code), job.functionName),
    },
    functionName: job.functionName,
    data: safeJsonParse(job.data, null),
    permissions: "none",
    timeoutMs: job.timeoutMs,
    metadata: {
      databaseJobId: job.id,
      workspaceSlug: job.workspaceSlug,
      version: job.version,
      entryPath: job.entryPath,
      attempt: job.attempt + 1,
    },
  });

  for (const entry of result.logs) {
    await addJobLog(job.id, null, entry.level, entry.message);
  }

  if (result.success) {
    await prisma.codeJob.update({
      where: { id: job.id },
      data: {
        status: "succeeded",
        result: JSON.stringify(result.output ?? null),
        error: null,
        progress: 100,
        completedAt: new Date(),
      },
    });
    await addJobLog(job.id, null, "info", `Job completed in ${result.durationMs}ms.`);
    return;
  }

  const latest = await prisma.codeJob.findUnique({ where: { id: job.id } });
  const shouldRetry = latest ? latest.attempt < latest.maxAttempts : false;
  await prisma.codeJob.update({
    where: { id: job.id },
    data: {
      status: shouldRetry ? "queued" : "failed",
      error: result.error?.message ?? "Code runner failed",
      nextRunAt: shouldRetry ? new Date(Date.now() + 2_000) : undefined,
      completedAt: shouldRetry ? null : new Date(),
    },
  });
  await addJobLog(job.id, null, shouldRetry ? "warn" : "error", result.error?.message ?? "Code runner failed");
  if (shouldRetry) void executeCodeJob(job.id, runService);
}

async function markCodeJobFailed(jobId: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Worker failed unexpectedly";
  await prisma.codeJob.update({
    where: { id: jobId },
    data: { status: "failed", error: message, completedAt: new Date() },
  }).catch(() => null);
  await addJobLog(jobId, null, "error", message).catch(() => null);
}

async function addJobLog(jobId: string, workerId: string | null, level: string, message: string) {
  const count = await prisma.codeJobLog.count({ where: { jobId } });
  return prisma.codeJobLog.create({
    data: { jobId, workerId, level, message, sequence: count + 1, meta: "{}" },
  });
}

async function findWorkspaceBySlug(slug: string, userId: string) {
  const direct = await prisma.codeWorkspace.findUnique({
    where: { createdByUserId_slug: { createdByUserId: userId, slug } },
  });
  if (direct) return direct;
  if (userId !== "public") {
    const publicWorkspace = await prisma.codeWorkspace.findUnique({
      where: { createdByUserId_slug: { createdByUserId: "public", slug } },
    });
    if (publicWorkspace) return publicWorkspace;
  }
  if (userId === DEFAULT_USER_ID) {
    return prisma.codeWorkspace.findFirst({
      where: { slug, active: true },
      orderBy: { updatedAt: "desc" },
    });
  }
  return null;
}

async function resolveStoredBundle(
  workspaceId: string,
  workspaceSlug: string,
  version: number,
  requestedPath: string | null,
) {
  const row = await prisma.codeWorkspaceVersion.findUnique({
    where: { workspaceId_version: { workspaceId, version } },
    select: { id: true, version: true, meta: true },
  });
  if (!row) return null;
  const resolved = resolveBundleFromMeta(row.meta, requestedPath);
  if (!resolved || typeof resolved.bundle.code !== "string") return null;
  const code = String(resolved.bundle.code);
  return {
    versionId: row.id,
    version: row.version,
    workspaceSlug,
    entryPath: resolved.entryPath,
    bundle: {
      code,
      hash: typeof resolved.bundle.hash === "string" ? resolved.bundle.hash : null,
      sizeBytes: typeof resolved.bundle.sizeBytes === "number" ? resolved.bundle.sizeBytes : code.length,
      savedAt: typeof resolved.bundle.savedAt === "string" ? resolved.bundle.savedAt : null,
    },
  };
}

function resolveBundleFromMeta(metaValue: unknown, requestedPath: string | null) {
  const meta = safeJsonParse<BundleMeta>(metaValue, {});
  const bundles = meta.bundles ?? {};
  const entries = Object.entries(bundles).filter(([, bundle]) => typeof bundle?.code === "string");
  if (entries.length === 0) return null;

  if (requestedPath) {
    const exact = bundles[requestedPath];
    if (typeof exact?.code === "string") return { entryPath: requestedPath, bundle: exact };
    const requestedBase = withoutKnownExtension(requestedPath);
    const matched = entries.find(([entryPath]) => withoutKnownExtension(entryPath) === requestedBase);
    if (matched) return { entryPath: matched[0], bundle: matched[1] };
  }

  if (entries.length === 1) return { entryPath: entries[0][0], bundle: entries[0][1] };
  return null;
}

function listAvailableBundleEntries(metaValue: unknown) {
  const meta = safeJsonParse<BundleMeta>(metaValue, {});
  return Object.entries(meta.bundles ?? {})
    .filter(([, bundle]) => typeof bundle?.code === "string")
    .map(([entryPath]) => entryPath);
}

function prepareCodeForRemoteModuleImport(code: string, functionName: string) {
  if (hasEsmExport(code, functionName)) return code;
  if (!/\bmodule\.exports\b|\bexports\.[A-Za-z_$]/.test(code)) return code;
  if (!/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(functionName)) return code;
  const exportKey = JSON.stringify(functionName);
  return [
    "const module = { exports: {} };",
    "let exports = module.exports;",
    "{",
    code,
    "}",
    `const __runnerExport = module.exports?.[${exportKey}] ?? exports?.[${exportKey}];`,
    `export { __runnerExport as ${functionName} };`,
  ].join("\n");
}

function hasEsmExport(code: string, functionName: string) {
  const escaped = escapeRegExp(functionName);
  return (
    new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${escaped}\\b`).test(code) ||
    new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${escaped}\\b`).test(code) ||
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(code)
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countJobs(jobs: Array<{ status: string }>) {
  const counts: Record<string, number> = {
    total: 0,
    queued: 0,
    running: 0,
    paused: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const job of jobs) {
    counts.total += 1;
    counts[job.status] = (counts[job.status] ?? 0) + 1;
  }
  return counts;
}

const workspaceSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  language: true,
  currentVersion: true,
  updatedAt: true,
  createdByUserId: true,
} as const;

const versionSummarySelect = {
  id: true,
  version: true,
  message: true,
  isAutosave: true,
  createdAt: true,
  snapshotHash: true,
  sizeBytes: true,
  meta: true,
} as const;

function toVersionSummaryDto(row: {
  id: string;
  version: number;
  message: string;
  isAutosave: boolean;
  createdAt: Date;
  snapshotHash: string;
  sizeBytes: number;
  meta: string;
}) {
  const { meta, ...rest } = row;
  return { ...rest, description: readVersionDescription(meta) };
}

function toWorkspaceDto(workspace: WorkspaceRow) {
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    description: workspace.description,
    language: workspace.language,
    currentVersion: workspace.currentVersion,
    updatedAt: workspace.updatedAt.toISOString(),
  };
}

function getUserIdentity(req: Parameters<RequestHandler>[0]) {
  const header = req.get("x-code-user-id");
  if (header?.trim()) return header.trim();
  const cookie = req.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (match?.[1]) {
    try {
      const parsed = JSON.parse(decodeURIComponent(match[1])) as JsonObject;
      for (const key of ["userId", "id", "email", "token"]) {
        if (typeof parsed[key] === "string" && parsed[key]) return parsed[key];
      }
    } catch {
      // Ignore malformed session cookies.
    }
  }
  return DEFAULT_USER_ID;
}

function getClientIp(req: Parameters<RequestHandler>[0]) {
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || null;
  return req.get("cf-connecting-ip") ?? req.get("x-real-ip") ?? req.ip ?? null;
}

function requireObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Invalid request");
  }
  return value as JsonObject;
}

function routeParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function requireString(value: unknown, name: string, max: number, min = 0) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return value.trim();
}

function requireSourceString(value: unknown, name: string, max: number, min = 0) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return value;
}

function requireBoolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new HttpError(400, `${name} must be a boolean`);
  return value;
}

function requireSaveMode(value: unknown) {
  if (value !== "draft" && value !== "publish") {
    throw new HttpError(400, "saveMode must be draft or publish");
  }
  return value;
}

function requireIdentifier(value: unknown, name: string) {
  const text = requireString(value, name, 128, 1);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) {
    throw new HttpError(400, `${name} must be a valid exported function name`);
  }
  return text;
}

function requireSlug(value: unknown) {
  const slug = requireString(value, "slug", 80, 2);
  if (!/^[a-z0-9-]+$/.test(slug)) throw new HttpError(400, "slug is invalid");
  return slug;
}

function validateSnapshot(value: unknown) {
  const snapshot = requireObject(value);
  if (snapshot.schemaVersion !== 1) throw new HttpError(400, "Invalid snapshot schemaVersion");
  normalizeEntryPath(requireString(snapshot.entryPath, "entryPath", 1024, 2));
  if (!Array.isArray(snapshot.files) || snapshot.files.length > 2_000) {
    throw new HttpError(400, "Invalid snapshot files");
  }
  for (const file of snapshot.files) {
    const record = requireObject(file);
    normalizeEntryPath(requireString(record.path, "path", 1024, 2));
    requireString(record.content, "content", 500_000);
  }
}

function requireFilesMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "files must be an object");
  }

  const files: Record<string, string> = {};
  let totalBytes = 0;
  for (const [path, content] of Object.entries(value)) {
    const normalizedPath = normalizeEntryPath(requireString(path, "file path", 1024, 1));
    const source = requireSourceString(content, `files[${normalizedPath}]`, 500_000);
    totalBytes += byteLength(source);
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      throw new HttpError(413, "Build files too large (max 2MB)");
    }
    files[normalizedPath] = source;
  }

  return files;
}

async function persistBundle(
  workspaceId: string,
  version: number,
  input: { entryPath: string; code: string },
) {
  const sizeBytes = byteLength(input.code);
  if (sizeBytes > MAX_BUNDLE_BYTES) {
    throw new HttpError(413, "Bundle too large (max 2MB)");
  }

  const bundle: PersistedBundle = {
    entryPath: input.entryPath,
    code: input.code,
    hash: sha256Hex(input.code),
    sizeBytes,
    savedAt: new Date().toISOString(),
  };

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.codeWorkspaceVersion.findUnique({
      where: {
        workspaceId_version: { workspaceId, version },
      },
      select: { id: true, version: true, meta: true },
    });
    if (!row) return null;

    const meta = safeJsonParse<BundleMeta>(row.meta, {});
    const bundles = meta.bundles ?? {};
    bundles[bundle.entryPath] = {
      code: bundle.code,
      hash: bundle.hash,
      sizeBytes: bundle.sizeBytes,
      savedAt: bundle.savedAt,
    };
    return tx.codeWorkspaceVersion.update({
      where: { id: row.id },
      data: { meta: JSON.stringify({ ...meta, bundles }) },
      select: { id: true, version: true },
    });
  });

  if (!updated) throw new HttpError(404, "Version not found");
  return {
    success: true,
    version: updated.version,
    entryPath: bundle.entryPath,
    hash: bundle.hash,
    sizeBytes: bundle.sizeBytes,
    savedAt: bundle.savedAt,
  };
}

function parsePositiveVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isInteger(version) || version <= 0) throw new HttpError(400, "Invalid version");
  return version;
}

function readVersionDescription(meta: string) {
  const parsed = safeJsonParse<BundleMeta>(meta, {});
  return typeof parsed.description === "string" ? parsed.description : "";
}

function writeVersionDescription(meta: string, description: string | undefined) {
  const parsed = safeJsonParse<BundleMeta>(meta, {});
  if (description === undefined) return JSON.stringify(parsed);
  return JSON.stringify({ ...parsed, description });
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeEntryPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function withoutKnownExtension(path: string) {
  return path.replace(/\.(tsx?|jsx?)$/i, "");
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  try {
    return (JSON.parse(value) ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function sha256Hex(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function byteLength(input: string) {
  return new TextEncoder().encode(input).byteLength;
}
