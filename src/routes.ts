import { createHash } from "crypto";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { Router, Request, Response } from "express";
import * as store from "./store";
import { getUploadsDir } from "./uploads";
import { registerAuthRoutes, getAuthenticatedUser } from "./auth";

const api = Router();
const STACKS_DIR = path.join(__dirname, "..", "data", "stacks");
const UPLOADS_DIR = getUploadsDir();
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)$/i;
const TEXT_EXT = /\.(txt|md|json|csv|log)$/i;

registerAuthRoutes(api);

function resolveCardImageUrl(rawImageUrl: string | undefined, baseUrl: string): string | undefined {
    if (!rawImageUrl)
        return undefined;
    if (/^data:/i.test(rawImageUrl))
        return undefined;
    if (/^https?:\/\//i.test(rawImageUrl))
        return rawImageUrl;
    return rawImageUrl.startsWith("/") ? `${baseUrl}${rawImageUrl}` : rawImageUrl;
}

type WebhookDeliveryLog = {
    id: string;
    createdAt: string;
    url: string;
    event: string;
    status: "pending" | "delivered" | "failed";
    attempts: number;
    lastError?: string;
    nextRetryAt?: string;
    deliveredAt?: string;
};
type EmailDeliveryLog = {
    id: string;
    createdAt: string;
    to: string;
    subject: string;
    event: string;
    status: "pending" | "delivered" | "failed";
    attempts: number;
    lastError?: string;
    nextRetryAt?: string;
    deliveredAt?: string;
};

const webhookDeliveryLogs: WebhookDeliveryLog[] = [];
const WEBHOOK_LOG_LIMIT = 100;
const emailDeliveryLogs: EmailDeliveryLog[] = [];
const EMAIL_LOG_LIMIT = 100;

function actorId(req: Request): string | undefined {
    return getAuthenticatedUser(req)?.id || undefined;
}

function effectiveCreatorId(req: Request, fallback?: string | null): string | undefined {
    const userId = actorId(req);
    if (userId)
        return userId;
    return fallback?.trim() || undefined;
}

function hasAccessToProject(req: Request, projectId: string): boolean {
    const userId = actorId(req);
    if (!userId)
        return true; // keep anonymous flow
    const proj = store.getProject(projectId);
    if (!proj)
        return false;
    return !proj.creatorId || proj.creatorId === userId;
}

function hasAccessToStack(req: Request, stackId: string): boolean {
    const stack = store.getStack(stackId);
    if (!stack)
        return false;
    return hasAccessToProject(req, stack.projectId);
}

function pushWebhookLog(entry: WebhookDeliveryLog): void {
    webhookDeliveryLogs.unshift(entry);
    if (webhookDeliveryLogs.length > WEBHOOK_LOG_LIMIT)
        webhookDeliveryLogs.pop();
}
function pushEmailLog(entry: EmailDeliveryLog): void {
    emailDeliveryLogs.unshift(entry);
    if (emailDeliveryLogs.length > EMAIL_LOG_LIMIT)
        emailDeliveryLogs.pop();
}
function isValidEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function deliverWebhookWithRetries(url: string, payload: unknown, event: string): Promise<void> {
    const maxAttempts = 3;
    const baseDelayMs = 1000;
    const log: WebhookDeliveryLog = {
        id: Math.random().toString(36).slice(2, 11),
        createdAt: new Date().toISOString(),
        url,
        event,
        status: "pending",
        attempts: 0,
    };
    pushWebhookLog(log);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        log.attempts = attempt;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
            }
            log.status = "delivered";
            log.deliveredAt = new Date().toISOString();
            delete log.nextRetryAt;
            return;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Webhook failed";
            log.lastError = message;
            if (attempt >= maxAttempts) {
                log.status = "failed";
                delete log.nextRetryAt;
                return;
            }
            const delayMs = baseDelayMs * attempt;
            log.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}
async function sendNotificationEmail(opts: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    event: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    const relayUrl = process.env.NOTIFICATION_EMAIL_WEBHOOK_URL?.trim();
    if (!relayUrl) {
        throw new Error("NOTIFICATION_EMAIL_WEBHOOK_URL is not configured");
    }
    const res = await fetch(relayUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            to: opts.to,
            subject: opts.subject,
            text: opts.text,
            html: opts.html,
            event: opts.event,
            metadata: opts.metadata ?? {},
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
    }
}
async function deliverEmailWithRetries(opts: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    event: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    const maxAttempts = 3;
    const delays = [10000, 30000];
    const log: EmailDeliveryLog = {
        id: Math.random().toString(36).slice(2, 11),
        createdAt: new Date().toISOString(),
        to: opts.to,
        subject: opts.subject,
        event: opts.event,
        status: "pending",
        attempts: 0,
    };
    pushEmailLog(log);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        log.attempts = attempt;
        try {
            await sendNotificationEmail(opts);
            log.status = "delivered";
            log.deliveredAt = new Date().toISOString();
            delete log.nextRetryAt;
            return;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Email delivery failed";
            log.lastError = message;
            if (attempt >= maxAttempts) {
                log.status = "failed";
                delete log.nextRetryAt;
                return;
            }
            const delayMs = delays[attempt - 1] ?? 60000;
            log.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}

// List projects with nested stacks (each stack includes cardCount)
// Query: creatorId — when provided, returns user's projects + projects where user reviewed (reviewerName).
// Query: reviewerName — display name for reviewer; when provided with creatorId, includes projects user reviewed.
// Query: q — search string; filters by project label, stack label, card content, or reviewer name.
// Query: limit — max projects to return (for pagination).
// Query: offset — skip N projects (for pagination). When limit/offset used, response is { projects, total }.
// Query: section — "my" (own projects) or "other" (reviewer projects); filters before pagination.
// Query: projectId — return only this project (for see-all stacks view).
// Query: sparse — when "1", return stackCount only (no stacks array); use GET /projects/:id/stacks to load stacks.
api.get("/projects", (req: Request, res: Response) => {
    const creatorId = effectiveCreatorId(req, (req.query.creatorId as string) || undefined);
    const reviewerName = (req.query.reviewerName as string)?.trim() || undefined;
    const q = (req.query.q as string)?.trim() || undefined;
    const limit = parseInt((req.query.limit as string) || "0", 10);
    const offset = parseInt((req.query.offset as string) || "0", 10);
    const section = (req.query.section as string)?.trim() || undefined;
    const projectId = (req.query.projectId as string)?.trim() || undefined;
    const sparse = req.query.sparse === "1";
    const usePagination = limit > 0 && !projectId;
    let projects = creatorId
        ? store.listProjectsWithStacksForUser(creatorId, reviewerName)
        : store.listProjectsWithStacks(creatorId);
    if (q) {
        projects = store.filterProjectsBySearch(projects, q);
    }
    if (projectId) {
        projects = projects.filter((p) => p.id === projectId);
    }
    else if (section === "my" && creatorId) {
        projects = projects.filter((p) => (p.creatorId ?? null) === creatorId);
    }
    else if (section === "other" && creatorId) {
        projects = projects.filter((p) => (p.creatorId ?? null) !== creatorId);
    }
    const total = projects.length;
    if (usePagination) {
        projects = projects.slice(offset, offset + limit);
    }
    if (sparse) {
        const sparseProjects = projects.map((p) => ({
            id: p.id,
            label: p.label,
            createdAt: p.createdAt,
            creatorId: p.creatorId,
            stackCount: p.stacks.length,
        }));
        if (usePagination) {
            res.json({ projects: sparseProjects, total });
        }
        else {
            res.json(sparseProjects);
        }
        return;
    }
    const withCounts = projects.map((p) => {
        const totalStackCount = store.listStacks(p.id).length;
        return {
            ...p,
            stackCount: totalStackCount,
            stacks: p.stacks.map((s) => ({
                ...s,
                cardCount: store.getAllCardsByStack(s.id).length,
                scoreCount: store.getScoreCount(s.id),
            })),
        };
    });
    if (usePagination) {
        res.json({ projects: withCounts, total });
    }
    else {
        res.json(withCounts);
    }
});

// Get stacks for a project (for sparse mode: load when project expanded)
api.get("/projects/:id/stacks", (req: Request, res: Response) => {
    if (!hasAccessToProject(req, req.params.id))
        return res.status(403).json({ error: "Forbidden" });
    const proj = store.getProject(req.params.id);
    if (!proj)
        return res.status(404).json({ error: "Project not found" });
    const stacks = store.listStacks(req.params.id).map((s) => ({
        ...s,
        scoreCount: store.getScoreCount(s.id),
        cardCount: store.getAllCardsByStack(s.id).length,
    }));
    res.json(stacks);
});

// Create project
// Body: creatorId (optional) — when creator is logged in, pass their id. When omitted, project is anonymous.
api.post("/projects", (req: Request, res: Response) => {
    const body = req.body;
    const creatorId = effectiveCreatorId(req, body?.creatorId);
    const project = store.createProject(body?.label?.trim(), creatorId);
    res.status(201).json(project);
});

// Update project label and/or callbackUrl
api.patch("/projects/:id", (req: Request, res: Response) => {
    if (!hasAccessToProject(req, req.params.id))
        return res.status(403).json({ error: "Forbidden" });
    const body = req.body;
    const proj = store.getProject(req.params.id);
    if (!proj)
        return res.status(404).json({ error: "Project not found" });
    const updates: Record<string, unknown> = {};
    if (body?.label !== undefined) {
        const label = body.label?.trim();
        if (!label)
            return res.status(400).json({ error: "label cannot be empty" });
        const updated = store.updateProjectLabel(req.params.id, label);
        if (!updated)
            return res.status(404).json({ error: "Project not found" });
        updates.label = updated;
    }
    if (body?.callbackUrl !== undefined) {
        const ok = store.updateProjectCallbackUrl(req.params.id, body.callbackUrl);
        if (!ok)
            return res.status(404).json({ error: "Project not found" });
        updates.callbackUrl = body.callbackUrl?.trim() || null;
    }
    if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: "No updates provided" });
    res.json({ ok: true, ...updates });
});

// Get creator (account) settings — query: creatorId
api.get("/settings/creator", (req: Request, res: Response) => {
    const creatorId = effectiveCreatorId(req, (req.query.creatorId as string) || undefined);
    const settings = store.getCreatorSettings(creatorId);
    res.json(settings);
});

// Update creator (account) settings — query: creatorId, body: { callbackUrl?, notificationEmail? }
api.patch("/settings/creator", (req: Request, res: Response) => {
    const creatorId = effectiveCreatorId(req, (req.query.creatorId as string) || undefined);
    if (!creatorId)
        return res.status(400).json({ error: "creatorId is required" });
    const body = req.body;
    const hasCallback = body?.callbackUrl !== undefined;
    const hasNotificationEmail = body?.notificationEmail !== undefined;
    if (!hasCallback && !hasNotificationEmail) {
        return res.status(400).json({ error: "No updates provided" });
    }
    const notificationEmail = hasNotificationEmail ? (body?.notificationEmail?.trim() || null) : undefined;
    if (typeof notificationEmail === "string" && !isValidEmail(notificationEmail)) {
        return res.status(400).json({ error: "notificationEmail must be a valid email" });
    }
    const ok = store.updateCreatorSettings(creatorId, {
        ...(hasCallback ? { callbackUrl: body?.callbackUrl ?? null } : {}),
        ...(hasNotificationEmail ? { notificationEmail } : {}),
    });
    if (!ok)
        return res.status(400).json({ error: "Could not update settings" });
    const settings = store.getCreatorSettings(creatorId);
    res.json({
        ok: true,
        callbackUrl: settings.callbackUrl ?? null,
        notificationEmail: settings.notificationEmail ?? null,
    });
});

// Reorder projects (body: { projectIds: string[] })
api.patch("/projects/reorder", (req: Request, res: Response) => {
    const body = req.body;
    const projectIds = Array.isArray(body?.projectIds) ? body.projectIds : [];
    const creatorId = effectiveCreatorId(req, (req.query.creatorId as string) || undefined);
    if (projectIds.length === 0)
        return res.status(400).json({ error: "projectIds is required" });
    const ok = store.reorderProjects(projectIds, creatorId);
    if (!ok)
        return res.status(400).json({ error: "Invalid projectIds" });
    res.json({ ok: true });
});

// Reorder stacks inside a project (body: { stackIds: string[] })
api.patch("/projects/:id/stacks/reorder", (req: Request, res: Response) => {
    const projectId = req.params.id;
    if (!hasAccessToProject(req, projectId))
        return res.status(403).json({ error: "Forbidden" });
    const body = req.body;
    const stackIds = Array.isArray(body?.stackIds) ? body.stackIds : [];
    if (stackIds.length === 0)
        return res.status(400).json({ error: "stackIds is required" });
    const ok = store.reorderStacks(projectId, stackIds);
    if (!ok)
        return res.status(400).json({ error: "Invalid stackIds" });
    res.json({ ok: true });
});

// Delete project
api.delete("/projects/:id", (req: Request, res: Response) => {
    if (!hasAccessToProject(req, req.params.id))
        return res.status(403).json({ error: "Forbidden" });
    const ok = store.deleteProject(req.params.id);
    if (!ok)
        return res.status(404).json({ error: "Project not found" });
    res.status(204).send();
});

// Clear project (reset all scores/decisions)
api.post("/projects/:id/clear", (req: Request, res: Response) => {
    if (!hasAccessToProject(req, req.params.id))
        return res.status(403).json({ error: "Forbidden" });
    const ok = store.clearProject(req.params.id);
    if (!ok)
        return res.status(404).json({ error: "Project not found" });
    res.json({ ok: true });
});

// Download project as CSV
api.get("/projects/:id/csv", (req: Request, res: Response) => {
    if (!hasAccessToProject(req, req.params.id))
        return res.status(403).json({ error: "Forbidden" });
    const proj = store.getProject(req.params.id);
    if (!proj)
        return res.status(404).json({ error: "Project not found" });
    const cards = store.getAllCardsByProject(req.params.id);
    const header = "id,stackId,content,decision,decidedAt,createdAt\n";
    const rows = cards.map((c) => `${c.id},${c.stackId},"${(c.content || "").replace(/"/g, '""')}",${c.decision ?? ""},${c.decidedAt ?? ""},${c.createdAt}`);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${proj.label.replace(/[^a-z0-9]/gi, "_")}.csv"`);
    res.send(header + rows.join("\n"));
});

// Push a deck: POST { projectId?, label?, cards: ["content1", ...] or [{ content, imageUrl?, meta? }] }
// If no projectId, creates Project #1 and Stack #1
api.post("/deck", (req: Request, res: Response) => {
    const body = req.body;
    const cards = body?.cards;
    if (!Array.isArray(cards) || cards.length === 0) {
        return res.status(400).json({ error: "cards must be a non-empty array" });
    }
    let projectId = body?.projectId?.trim();
    if (!projectId) {
        const projects = store.listProjects();
        const proj = projects[0] ?? store.createProject();
        projectId = proj.id;
    }
    const stack = store.createStack(projectId, body?.label?.trim());
    const created: { id: string; content: string }[] = [];
    for (const c of cards) {
        const content = typeof c === "string" ? c : c?.content;
        if (!content?.trim())
            continue;
        const meta = typeof c === "object" && c?.meta ? c.meta : undefined;
        const imageUrl = typeof c === "object" && c?.imageUrl ? c.imageUrl : undefined;
        const card = store.createCard(stack.id, { content: content.trim(), imageUrl, meta });
        if (card)
            created.push({ id: card.id, content: card.content });
    }
    res.status(201).json({ stack, cards: created });
});

// List stacks (flat, for backward compat)
api.get("/stacks", (req: Request, res: Response) => {
    const projectId = req.query.projectId as string | undefined;
    if (projectId && !hasAccessToProject(req, projectId))
        return res.status(403).json({ error: "Forbidden" });
    res.json(store.listStacks(projectId));
});

// Create stack (requires projectId)
api.post("/stacks", (req: Request, res: Response) => {
    const body = req.body;
    if (!body?.projectId?.trim()) {
        return res.status(400).json({ error: "projectId is required" });
    }
    if (!hasAccessToProject(req, body.projectId)) {
        return res.status(403).json({ error: "Forbidden" });
    }
    const stack = store.createStack(body.projectId, body.label?.trim(), body.callbackUrl);
    res.status(201).json(stack);
});

// Create stack from local folder (dev simulation)
api.post("/stacks/from-folder", async (req: Request, res: Response) => {
    const body = req.body;
    const folderId = body?.folderId?.trim();
    if (!folderId)
        return res.status(400).json({ error: "folderId is required" });
    const dir = path.join(STACKS_DIR, folderId);
    try {
        const files = await readdir(dir);
        const sorted = files
            .filter((f) => TEXT_EXT.test(f) || IMAGE_EXT.test(f))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (sorted.length === 0) {
            return res.status(400).json({ error: "No .txt or image files in folder" });
        }
        let projectId = body?.projectId?.trim();
        if (!projectId) {
            const projects = store.listProjects();
            const proj = projects[0] ?? store.createProject();
            projectId = proj.id;
        }
        if (!hasAccessToProject(req, projectId)) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const stack = store.createStackWithId(projectId, folderId, body?.label || folderId);
        if (!stack)
            return res.status(400).json({ error: "Project not found" });
        for (const file of sorted) {
            const ext = path.extname(file).toLowerCase();
            if (TEXT_EXT.test(file)) {
                const content = await readFile(path.join(dir, file), "utf-8");
                store.createCard(stack.id, { content: content.trim(), meta: { source: file } });
            }
            else if (IMAGE_EXT.test(file)) {
                const fileUrl = `${baseUrl}/api/stacks/${stack.id}/files/${encodeURIComponent(file)}`;
                store.createCard(stack.id, { content: file, imageUrl: fileUrl, meta: { source: file } });
            }
        }
        res.status(201).json({
            stack,
            link: stack.projectId ? `${baseUrl}/review/${stack.projectId}/${stack.id}` : `${baseUrl}/review/${stack.id}`,
            cards: store.getAllCardsByStack(stack.id).length,
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "Folder not found";
        res.status(400).json({ error: msg });
    }
});

// Serve files from local stack folder
api.get("/stacks/:id/files/:filename", (req: Request, res: Response) => {
    const { id, filename } = req.params;
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeFilename = filename.replace(/\.\./g, "");
    const filePath = path.resolve(STACKS_DIR, safeId, safeFilename);
    const stacksDirResolved = path.resolve(STACKS_DIR);
    if (!filePath.startsWith(stacksDirResolved)) {
        return res.status(403).json({ error: "Invalid path" });
    }
    res.sendFile(filePath, (err) => {
        if (err)
            res.status(404).json({ error: "File not found" });
    });
});

// Serve uploaded inline images persisted on the API host.
api.get("/uploads/:stackId/:filename", (req: Request, res: Response) => {
    const { stackId, filename } = req.params;
    const safeStackId = stackId.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeFilename = filename.replace(/\.\./g, "");
    const filePath = path.resolve(UPLOADS_DIR, safeStackId, safeFilename);
    const uploadsDirResolved = path.resolve(UPLOADS_DIR);
    if (!filePath.startsWith(uploadsDirResolved)) {
        return res.status(403).json({ error: "Invalid path" });
    }
    res.sendFile(filePath, (err) => {
        if (err)
            res.status(404).json({ error: "File not found" });
    });
});

// Get stack (includes cards array for single-call convenience)
api.get("/stacks/:id", (req: Request, res: Response) => {
    const stack = store.getStack(req.params.id);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const cards = store.getAllCardsByStack(req.params.id);
    res.json({ ...stack, cards });
});

// Delete stack
api.delete("/stacks/:id", (req: Request, res: Response) => {
    if (!hasAccessToStack(req, req.params.id))
        return res.status(403).json({ error: "Forbidden" });
    const ok = store.deleteStack(req.params.id);
    if (!ok)
        return res.status(404).json({ error: "Stack not found" });
    res.status(204).send();
});

// Update stack label and/or callbackUrl
api.patch("/stacks/:id", (req: Request, res: Response) => {
    if (!hasAccessToStack(req, req.params.id))
        return res.status(403).json({ error: "Forbidden" });
    const body = req.body;
    const stack = store.getStack(req.params.id);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const updates: Record<string, unknown> = {};
    if (body?.label !== undefined) {
        const label = body.label?.trim();
        if (!label)
            return res.status(400).json({ error: "label cannot be empty" });
        const updated = store.updateStackLabel(req.params.id, label);
        if (!updated)
            return res.status(404).json({ error: "Stack not found" });
        updates.label = updated;
    }
    if (body?.callbackUrl !== undefined) {
        const ok = store.updateStackCallbackUrl(req.params.id, body.callbackUrl);
        if (!ok)
            return res.status(404).json({ error: "Stack not found" });
        updates.callbackUrl = body.callbackUrl?.trim() || null;
    }
    if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: "No updates provided" });
    res.json({ ok: true, ...updates });
});

// Clear stack (reset all scores/decisions)
api.post("/stacks/:id/clear", (req: Request, res: Response) => {
    if (!hasAccessToStack(req, req.params.id))
        return res.status(403).json({ error: "Forbidden" });
    const ok = store.clearStack(req.params.id);
    if (!ok)
        return res.status(404).json({ error: "Stack not found" });
    res.json({ ok: true });
});

// Clear reviewer session (reset scores for one reviewer)
api.post("/stacks/:stackId/sessions/:sessionId/clear", (req: Request, res: Response) => {
    if (!hasAccessToStack(req, req.params.stackId))
        return res.status(403).json({ error: "Forbidden" });
    const ok = store.clearSession(req.params.stackId, req.params.sessionId);
    if (!ok)
        return res.status(404).json({ error: "Stack not found" });
    res.json({ ok: true });
});

// Download reviewer session as CSV
api.get("/stacks/:stackId/sessions/:sessionId/csv", (req: Request, res: Response) => {
    const { stackId, sessionId } = req.params;
    if (!hasAccessToStack(req, stackId))
        return res.status(403).json({ error: "Forbidden" });
    const stack = store.getStack(stackId);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const rawScores = store.getScoresBySession(stackId, sessionId);
    const cards = store.getAllCardsByStack(stackId);
    const cardMap = new Map(cards.map((c) => [c.id, c]));
    const header = "cardId,stackId,content,decision,decidedAt,createdAt,reviewerName\n";
    const rows = rawScores.map((sc) => {
        const card = cardMap.get(sc.cardId);
        const content = (card?.content ?? "").replace(/"/g, '""');
        return `${sc.cardId},${stackId},"${content}",${sc.decision},${sc.decidedAt},${card?.createdAt ?? ""},${sc.reviewerName}`;
    });
    const reviewerName = rawScores[0]?.reviewerName ?? "reviewer";
    const safeName = reviewerName.replace(/[^a-z0-9]/gi, "_");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${stack.label.replace(/[^a-z0-9]/gi, "_")}_${safeName}.csv"`);
    res.send(header + rows.join("\n"));
});

// Download stack as CSV
api.get("/stacks/:id/csv", (req: Request, res: Response) => {
    if (!hasAccessToStack(req, req.params.id))
        return res.status(403).json({ error: "Forbidden" });
    const stack = store.getStack(req.params.id);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const cards = store.getAllCardsByStack(req.params.id);
    const header = "id,stackId,content,decision,decidedAt,createdAt\n";
    const rows = cards.map((c) => `${c.id},${c.stackId},"${(c.content || "").replace(/"/g, '""')}",${c.decision ?? ""},${c.decidedAt ?? ""},${c.createdAt}`);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${stack.label.replace(/[^a-z0-9]/gi, "_")}.csv"`);
    res.send(header + rows.join("\n"));
});

// Get pending cards for a stack
api.get("/stacks/:id/cards", (req: Request, res: Response) => {
    const stack = store.getStack(req.params.id);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const list = store.getCardsByStack(req.params.id);
    res.json(list);
});

// Get all cards for a stack (pending + decided)
api.get("/stacks/:id/all-cards", (req: Request, res: Response) => {
    const stack = store.getStack(req.params.id);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const list = store.getAllCardsByStack(req.params.id);
    res.json(list);
});

// Get scores (decided cards) for a stack
api.get("/stacks/:id/scores", (req: Request, res: Response) => {
    const stack = store.getStack(req.params.id);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const scores = store.getScoresByStack(req.params.id);
    res.json({ stack, scores });
});

// Get scores grouped by reviewer (reviewer flow) + direct decisions (creator flow)
api.get("/stacks/:id/scores-by-reviewer", (req: Request, res: Response) => {
    const stackId = req.params.id;
    const stack = store.getStack(stackId);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const cards = store.getAllCardsByStack(stackId);
    const cardMap = new Map(cards.map((c) => [c.id, c]));
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const sessions = store.getSessionsByStack(stackId);
    const reviewers = sessions.map((sess) => {
        const rawScores = store.getScoresBySession(stackId, sess.sessionId);
        const scores = rawScores.map((sc) => ({
            cardId: sc.cardId,
            decision: sc.decision,
            content: cardMap.get(sc.cardId)?.content ?? "",
            imageUrl: resolveCardImageUrl(cardMap.get(sc.cardId)?.imageUrl, baseUrl),
            decidedAt: sc.decidedAt,
        }));
        return { reviewerId: sess.reviewerId, reviewerName: sess.reviewerName, sessionId: sess.sessionId, scores };
    });
    const directCards = store.getScoresByStack(stackId);
    const directScores = directCards.map((c) => ({
        cardId: c.id,
        decision: c.decision,
        content: c.content ?? "",
        imageUrl: resolveCardImageUrl(c.imageUrl, baseUrl),
        decidedAt: c.decidedAt ?? "",
    }));
    res.json({ stack, reviewers, directScores });
});

// Add card to stack
api.post("/stacks/:stackId/cards", (req: Request, res: Response) => {
    const { stackId } = req.params;
    if (!hasAccessToStack(req, stackId))
        return res.status(403).json({ error: "Forbidden" });
    const stack = store.getStack(stackId);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const body = req.body;
    if (body?.cards && Array.isArray(body.cards)) {
        const created: { id: string; content: string }[] = [];
        const seen = new Set<string>();
        const existing = store.getAllCardsByStack(stackId);
        const existingKeys = new Set(existing.map((ec) => ec.content + "|" + (ec.imageUrl ? createHash("md5").update(ec.imageUrl).digest("hex") : "")));
        for (const c of body.cards) {
            const content = typeof c === "string" ? c : c?.content;
            if (!content?.trim())
                continue;
            const meta = typeof c === "object" && c?.meta ? c.meta : undefined;
            const imageUrl = typeof c === "object" && c?.imageUrl ? c.imageUrl : undefined;
            const key = content.trim() + "|" + (imageUrl ? createHash("md5").update(imageUrl).digest("hex") : "");
            if (seen.has(key) || existingKeys.has(key))
                continue;
            seen.add(key);
            existingKeys.add(key);
            const card = store.createCard(stackId, { content: content.trim(), imageUrl, meta });
            if (card)
                created.push({ id: card.id, content: card.content });
        }
        return res.status(201).json({ cards: created });
    }
    if (!body?.content?.trim()) {
        return res.status(400).json({ error: "content is required" });
    }
    const card = store.createCard(stackId, {
        content: body.content.trim(),
        imageUrl: body.imageUrl,
        meta: body.meta,
    });
    res.status(201).json(card);
});

// Delete cards from a stack
api.post("/stacks/:stackId/cards/delete", (req: Request, res: Response) => {
    const { stackId } = req.params;
    if (!hasAccessToStack(req, stackId))
        return res.status(403).json({ error: "Forbidden" });
    const body = req.body;
    const cardIds = Array.isArray(body?.cardIds) ? body.cardIds : [];
    if (cardIds.length === 0) {
        return res.status(400).json({ error: "cardIds must be a non-empty array" });
    }
    const deleted = store.deleteCards(stackId, cardIds);
    if (deleted === 0)
        return res.status(404).json({ error: "No matching cards found" });
    res.json({ deleted });
});

// Create assignment (reviewer opens link, enters name, clicks Start)
api.post("/assignments", (req: Request, res: Response) => {
    const body = req.body;
    const stackId = body?.stackId?.trim();
    const reviewerId = body?.reviewerId?.trim();
    const reviewerName = body?.reviewerName?.trim();
    if (!stackId)
        return res.status(400).json({ error: "stackId is required" });
    if (!reviewerId)
        return res.status(400).json({ error: "reviewerId is required" });
    if (!reviewerName)
        return res.status(400).json({ error: "reviewerName is required" });
    const stack = store.getStack(stackId);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const projectId = stack.projectId;
    const ok = store.addStackAssignment(stackId, projectId, reviewerId, reviewerName);
    if (!ok)
        return res.status(400).json({ error: "Invalid stack or projectId" });
    res.status(201).json({ ok: true, stackId, projectId });
});

// Record decision on a card (creator flow)
api.post("/cards/:cardId/decision", (req: Request, res: Response) => {
    const body = req.body;
    const decision = body?.decision;
    if (!decision || !["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ error: "decision must be approved or rejected" });
    }
    const card = store.recordDecision(req.params.cardId, decision);
    if (!card)
        return res.status(404).json({ error: "Card not found" });
    res.json(card);
});

// Submit scores batch (reviewer flow)
api.post("/scores", (req: Request, res: Response) => {
    const body = req.body;
    const stackId = body?.stackId?.trim();
    const reviewerId = body?.reviewerId?.trim();
    const reviewerName = body?.reviewerName?.trim();
    const sessionId = body?.sessionId?.trim();
    const decisions = body?.decisions;
    if (!stackId)
        return res.status(400).json({ error: "stackId is required" });
    if (!reviewerId)
        return res.status(400).json({ error: "reviewerId is required" });
    if (!reviewerName)
        return res.status(400).json({ error: "reviewerName is required" });
    if (!sessionId)
        return res.status(400).json({ error: "sessionId is required" });
    if (!Array.isArray(decisions) || decisions.length === 0) {
        return res.status(400).json({ error: "decisions must be a non-empty array" });
    }
    const valid = decisions
        .filter((d: { cardId?: string; decision?: string }) => d?.cardId && d.decision && ["approved", "rejected"].includes(d.decision))
        .map((d: { cardId: string; decision: string; decidedAt?: string; swipeTimeMs?: number }) => ({
            cardId: d.cardId,
            decision: d.decision as "approved" | "rejected",
            decidedAt: typeof d.decidedAt === "string" ? d.decidedAt : undefined,
            swipeTimeMs: typeof d.swipeTimeMs === "number" ? d.swipeTimeMs : undefined,
        }));
    if (valid.length === 0) {
        return res.status(400).json({ error: "No valid decisions" });
    }
    const sid = stackId;
    const rid = reviewerId;
    const rname = reviewerName;
    const sessId = sessionId;
    const ok = store.recordScoresBatch(sid, rid, rname, sessId, valid);
    if (!ok)
        return res.status(404).json({ error: "Stack not found" });
    const stack = store.getStack(stackId);
    const projectId = stack?.projectId ?? "";
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const scoresUrl = projectId
        ? `${baseUrl}/scores/${projectId}/${stackId}/${sessionId}`
        : `${baseUrl}/scores/${stackId}/${sessionId}`;
    const approved = valid.filter((d) => d.decision === "approved").length;
    const rejected = valid.filter((d) => d.decision === "rejected").length;
    const callbackUrl = stack ? store.getResolvedCallbackUrl(stack) : null;
    if (callbackUrl) {
        const proj = projectId ? store.getProject(projectId) : null;
        const rawScores = store.getScoresBySession(stackId, sessionId);
        const cards = store.getAllCardsByStack(stackId);
        const cardMap = new Map(cards.map((c) => [c.id, c]));
        const scores = [...rawScores]
            .sort((a, b) => new Date(a.decidedAt).getTime() - new Date(b.decidedAt).getTime())
            .map((sc) => {
                const card = cardMap.get(sc.cardId);
                const rawImageUrl = card?.imageUrl;
                const imageUrl = resolveCardImageUrl(rawImageUrl, baseUrl);
                const hasInlineImage = !!rawImageUrl && /^data:/i.test(rawImageUrl);
                return {
                    cardId: sc.cardId,
                    content: card?.content ?? "",
                    imageUrl,
                    hasInlineImage,
                    decision: sc.decision,
                    decidedAt: sc.decidedAt,
                    swipeTimeMs: sc.swipeTimeMs ?? null,
                };
            });
        const payload = {
            event: "review.completed",
            completedAt: new Date().toISOString(),
            projectId: projectId || undefined,
            projectLabel: proj?.label,
            stackId,
            stackLabel: stack?.label,
            reviewerId,
            sessionId,
            reviewerName,
            scoresUrl,
            decisionsCount: valid.length,
            approved,
            rejected,
            scores,
        };
        void deliverWebhookWithRetries(callbackUrl, payload, "review.completed");
    }
    const creatorIdForNotifications = stack?.creatorId ?? (projectId ? store.getProject(projectId)?.creatorId : undefined);
    const notificationEmail = store.getCreatorSettings(creatorIdForNotifications).notificationEmail?.trim();
    if (notificationEmail && isValidEmail(notificationEmail)) {
        const subject = `uhmm.link review completed: ${stack?.label || stackId}`;
        const text = [
            "A review has been completed.",
            "",
            `Project: ${projectId || "n/a"}`,
            `Stack: ${stack?.label || stackId}`,
            `Reviewer: ${reviewerName}`,
            `Approved: ${approved}`,
            `Rejected: ${rejected}`,
            "",
            `Scores URL: ${scoresUrl}`,
        ].join("\n");
        void deliverEmailWithRetries({
            to: notificationEmail,
            subject,
            text,
            event: "review.completed",
            metadata: { stackId, sessionId, projectId: projectId || null, reviewerId, reviewerName, approved, rejected, scoresUrl },
        });
    }
    res.status(201).json({ scoresUrl });
});

// Export selected scores (project, stack, reviewer checkboxes)
// Body: projectIds, stackIds, sessions, exportType
// exportType: "download" | "json-full" | "json-aggregated" | "csv-full" | "csv-aggregated"
// Default "download" = legacy CSV with projectLabel, stackLabel, etc.
api.post("/scores/export", (req: Request, res: Response) => {
    const body = req.body;
    const projectIds = Array.isArray(body?.projectIds) ? body.projectIds : [];
    const stackIds = Array.isArray(body?.stackIds) ? body.stackIds : [];
    const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
    const exportType = body?.exportType?.trim() || "download";
    if (exportType === "download") {
        const rows = store.getExportRows(projectIds, stackIds, sessions);
        const header = "projectLabel,stackLabel,reviewerName,cardId,content,decision,decidedAt,createdAt\n";
        const csvRows = rows.map((r) => `"${(r.projectLabel || "").replace(/"/g, '""')}","${(r.stackLabel || "").replace(/"/g, '""')}","${(r.reviewerName || "").replace(/"/g, '""')}",${r.cardId},"${(r.content || "").replace(/"/g, '""')}",${r.decision},${r.decidedAt},${r.createdAt}`);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", 'attachment; filename="scores_export.csv"');
        return res.send(header + csvRows.join("\n"));
    }
    if (exportType === "json-full") {
        const fullRows = store.getExportDataFull(projectIds, stackIds, sessions);
        type ReviewEntry = {
            reviewerId: string;
            reviewerName: string;
            decisions: Array<{ cardId: string; decision: string; swipeTimeMs?: number | null; imageUrl?: string }>;
        };
        type StackEntry = { label: string; reviews: Map<string, ReviewEntry> };
        const byStack = new Map<string, StackEntry>();
        for (const r of fullRows) {
            let stack = byStack.get(r.stackId);
            if (!stack) {
                stack = { label: r.stackLabel, reviews: new Map() };
                byStack.set(r.stackId, stack);
            }
            let review = stack.reviews.get(r.reviewerId);
            if (!review) {
                review = { reviewerId: r.reviewerId, reviewerName: r.reviewerName, decisions: [] };
                stack.reviews.set(r.reviewerId, review);
            }
            review.decisions.push({ cardId: r.cardId, decision: r.decision, swipeTimeMs: r.swipeTimeMs, imageUrl: r.imageUrl });
        }
        const result = Array.from(byStack.entries()).map(([stackId, { label, reviews }]) => ({
            stackId,
            label,
            reviews: Array.from(reviews.values()).map((rev) => ({
                reviewerId: rev.reviewerId,
                reviewerName: rev.reviewerName,
                totalSwipeTimeMs: null,
                decisions: rev.decisions,
            })),
        }));
        res.setHeader("Content-Type", "application/json");
        return res.json(result.length === 1 ? result[0] : result);
    }
    if (exportType === "json-aggregated") {
        const aggRows = store.getExportDataAggregated(projectIds, stackIds, sessions);
        const fullRows = store.getExportDataFull(projectIds, stackIds, sessions);
        const reviewersPerStack = new Map<string, Set<string>>();
        for (const r of fullRows) {
            let set = reviewersPerStack.get(r.stackId);
            if (!set) {
                set = new Set();
                reviewersPerStack.set(r.stackId, set);
            }
            set.add(r.reviewerId);
        }
        const byStack = new Map<string, { label: string; totalReviewers: number; cards: { cardId: string; approvals: number; rejections: number; total: number; approvalRate: number; avgSwipeTimeMs?: number | null }[] }>();
        for (const r of aggRows) {
            let stack = byStack.get(r.stackId);
            if (!stack) {
                stack = {
                    label: r.stackLabel,
                    totalReviewers: reviewersPerStack.get(r.stackId)?.size ?? 0,
                    cards: [],
                };
                byStack.set(r.stackId, stack);
            }
            stack.cards.push({
                cardId: r.cardId,
                approvals: r.approvals,
                rejections: r.rejections,
                total: r.total,
                approvalRate: r.approvalRate,
                avgSwipeTimeMs: r.avgSwipeTimeMs,
            });
        }
        const result = Array.from(byStack.entries()).map(([stackId, { label, totalReviewers, cards }]) => ({
            stackId,
            label,
            totalReviewers,
            cards,
        }));
        res.setHeader("Content-Type", "application/json");
        return res.json(result.length === 1 ? result[0] : result);
    }
    if (exportType === "csv-full") {
        const fullRows = store.getExportDataFull(projectIds, stackIds, sessions);
        const header = "projectLabel,stackLabel,stackId,cardId,reviewerId,reviewerName,content,imageUrl,decision,swipeTimeMs\n";
        const escape = (v: string | null | undefined) => `"${(v || "").replace(/"/g, '""')}"`;
        const csvRows = fullRows.map((r) => `${escape(r.projectLabel)},${escape(r.stackLabel)},${escape(r.stackId)},${escape(r.cardId)},${escape(r.reviewerId)},${escape(r.reviewerName)},${escape(r.content)},${escape(r.imageUrl)},${escape(r.decision)},${r.swipeTimeMs ?? ""}`);
        res.setHeader("Content-Type", "text/csv");
        return res.send(header + csvRows.join("\n"));
    }
    if (exportType === "csv-aggregated") {
        const aggRows = store.getExportDataAggregated(projectIds, stackIds, sessions);
        const header = "projectLabel,stackLabel,stackId,cardId,content,approvals,rejections,total,approvalRate,avgSwipeTimeMs\n";
        const escape = (v: string | null | undefined) => `"${(v || "").replace(/"/g, '""')}"`;
        const csvRows = aggRows.map((r) => `${escape(r.projectLabel)},${escape(r.stackLabel)},${escape(r.stackId)},${escape(r.cardId)},${escape(r.content)},${r.approvals},${r.rejections},${r.total},${r.approvalRate},${r.avgSwipeTimeMs ?? ""}`);
        res.setHeader("Content-Type", "text/csv");
        return res.send(header + csvRows.join("\n"));
    }
    return res.status(400).json({ error: "Invalid exportType" });
});

// Add scores URL to user's account
// Accepts: /scores/{projectId}/{stackId}/{sessionId} or legacy /scores/{stackId}/{sessionId}
api.post("/scores/add", (req: Request, res: Response) => {
    const body = req.body;
    const creatorId = effectiveCreatorId(req, body?.creatorId);
    const url = body?.url?.trim();
    if (!creatorId)
        return res.status(400).json({ error: "creatorId is required" });
    if (!url)
        return res.status(400).json({ error: "url is required" });
    const match4 = url.match(/\/scores\/([^/]+)\/([^/]+)\/([^/]+)/) || url.match(/scores\/([^/]+)\/([^/]+)\/([^/]+)/);
    const match2 = url.match(/\/scores\/([^/]+)\/([^/]+)/) || url.match(/scores\/([^/]+)\/([^/]+)/);
    let stackId: string;
    let sessionId: string;
    if (match4) {
        [, , stackId, sessionId] = match4;
    }
    else if (match2) {
        [, stackId, sessionId] = match2;
    }
    else {
        return res.status(400).json({ error: "Invalid scores URL. Use format: .../scores/{projectId}/{stackId}/{sessionId} or .../scores/{stackId}/{sessionId}" });
    }
    const ok = store.addUserScoreLink(creatorId, stackId, sessionId);
    if (!ok)
        return res.status(404).json({ error: "Scores not found or invalid URL" });
    res.status(201).json({ ok: true, stackId, sessionId });
});

// Get score links added by user (for "Added via URL" display — excludes links to own projects)
api.get("/scores/added", (req: Request, res: Response) => {
    const creatorId = effectiveCreatorId(req, (req.query.creatorId as string) || undefined);
    if (!creatorId)
        return res.status(400).json({ error: "creatorId is required" });
    const links = store.getUserScoreLinksForDisplay(creatorId);
    res.json(links);
});

// Remove score link from user's account
api.post("/scores/remove", (req: Request, res: Response) => {
    const body = req.body;
    const creatorId = effectiveCreatorId(req, body?.creatorId);
    const stackId = body?.stackId?.trim();
    const sessionId = body?.sessionId?.trim();
    if (!creatorId || !stackId || !sessionId) {
        return res.status(400).json({ error: "creatorId, stackId, and sessionId are required" });
    }
    const ok = store.removeUserScoreLink(creatorId, stackId, sessionId);
    if (!ok)
        return res.status(404).json({ error: "Link not found" });
    res.json({ ok: true });
});

// Get project aggregated scores (all stacks, all reviewers)
api.get("/scores/project/:projectId", (req: Request, res: Response) => {
    const { projectId } = req.params;
    if (!hasAccessToProject(req, projectId))
        return res.status(403).json({ error: "Forbidden" });
    const project = store.getProject(projectId);
    if (!project)
        return res.status(404).json({ error: "Project not found" });
    const stacks = store.listStacks(projectId).map((s) => ({
        ...s,
        scoreCount: store.getScoreCount(s.id),
    }));
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const stacksWithScores = stacks.map((stack) => {
        const cards = store.getAllCardsByStack(stack.id);
        const cardMap = new Map(cards.map((c) => [c.id, c]));
        const sessions = store.getSessionsByStack(stack.id);
        const reviewers = sessions.map((sess) => {
            const rawScores = store.getScoresBySession(stack.id, sess.sessionId);
            const scores = rawScores.map((sc) => ({
                cardId: sc.cardId,
                decision: sc.decision,
                content: cardMap.get(sc.cardId)?.content ?? "",
                imageUrl: resolveCardImageUrl(cardMap.get(sc.cardId)?.imageUrl, baseUrl),
            }));
            return { reviewerName: sess.reviewerName, sessionId: sess.sessionId, scores };
        });
        const directCards = store.getScoresByStack(stack.id);
        const directScores = directCards.map((c) => ({
            cardId: c.id,
            decision: c.decision,
            content: c.content ?? "",
            imageUrl: resolveCardImageUrl(c.imageUrl, baseUrl),
        }));
        return { ...stack, reviewers, directScores };
    });
    res.json({ project, stacks: stacksWithScores });
});

// Get scores for a session (with card content)
api.get("/scores/:stackId/:sessionId", (req: Request, res: Response) => {
    const { stackId, sessionId } = req.params;
    const rawScores = store.getScoresBySession(stackId, sessionId);
    const stack = store.getStack(stackId);
    if (!stack)
        return res.status(404).json({ error: "Stack not found" });
    const cards = store.getAllCardsByStack(stackId);
    const cardMap = new Map(cards.map((c) => [c.id, c]));
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const scores = rawScores.map((s) => ({
        ...s,
        content: cardMap.get(s.cardId)?.content ?? "",
        imageUrl: resolveCardImageUrl(cardMap.get(s.cardId)?.imageUrl, baseUrl),
    }));
    res.json({ stack, scores });
});

// --- Webhook test (dev/debug) — remove before production ---
const webhookTestPayloads: { receivedAt: string; body: unknown }[] = [];
const WEBHOOK_TEST_MAX = 20;
api.post("/webhook-test", (req: Request, res: Response) => {
    const payload = { receivedAt: new Date().toISOString(), body: req.body };
    webhookTestPayloads.unshift(payload);
    if (webhookTestPayloads.length > WEBHOOK_TEST_MAX)
        webhookTestPayloads.pop();
    res.status(200).send("OK");
});
api.get("/webhook-test", (_req: Request, res: Response) => {
    res.json(webhookTestPayloads);
});

// Recent webhook delivery attempts for debugging.
api.get("/webhooks/deliveries", (_req: Request, res: Response) => {
    res.json(webhookDeliveryLogs);
});
// Recent email delivery attempts for debugging.
api.get("/emails/deliveries", (_req: Request, res: Response) => {
    res.json(emailDeliveryLogs);
});

// Reset to demo data from fixtures/demo.json (JSON storage only).
api.post("/admin/reset-demo", async (req: Request, res: Response) => {
    if (process.env.DATABASE_URL) {
        return res.status(400).json({ error: "reset-demo only works with JSON storage (no DATABASE_URL)" });
    }
    try {
        const fs = await import("fs");
        const demoPath = path.join(__dirname, "..", "fixtures", "demo.json");
        if (!fs.existsSync(demoPath)) {
            return res.status(404).json({ error: "fixtures/demo.json not found" });
        }
        const raw = fs.readFileSync(demoPath, "utf-8");
        const data = JSON.parse(raw);
        const state = {
            projects: data.projects ?? [],
            stacks: data.stacks ?? [],
            cards: data.cards ?? [],
            scores: data.scores ?? [],
            userScoreLinks: data.userScoreLinks ?? [],
            stackAssignments: data.stackAssignments ?? [],
            creatorSettings: data.creatorSettings ?? [],
        };
        const { persist } = await import("./db.js");
        persist(state);
        res.json({ ok: true, message: "Reset to demo data" });
    } catch (err) {
        console.error("reset-demo failed:", err);
        res.status(500).json({ error: String(err) });
    }
});

// One-time utility: migrate existing inline data:image cards to stored upload paths.
// Optional body: { stackId?: string }
api.post("/admin/migrate-inline-images", (req: Request, res: Response) => {
    const stackId = req.body?.stackId?.trim() || undefined;
    const result = store.migrateInlineImages(stackId);
    res.json({ ok: true, stackId: stackId ?? null, ...result });
});

// Seed extra demo data for mobile/web parity using existing card patterns.
// Optional body: { creatorId?: string, projects?: number, stacksPerProject?: number, cardsPerStack?: number }
api.post("/admin/seed-web-test-data", (req: Request, res: Response) => {
    const creatorId = (req.body?.creatorId?.trim() || "u1") as string;
    const projectsToCreate = Math.max(1, Math.min(20, Number(req.body?.projects ?? 4)));
    const stacksPerProject = Math.max(1, Math.min(20, Number(req.body?.stacksPerProject ?? 6)));
    const cardsPerStack = Math.max(1, Math.min(100, Number(req.body?.cardsPerStack ?? 18)));

    const labelPool = [
        "Q1 batch",
        "Q2 batch",
        "Drafts",
        "Mockups",
        "Open tickets",
        "Archive",
        "Pending",
        "Final review",
    ];
    const projectPool = [
        "Email drafts",
        "Social posts",
        "Content review",
        "Design feedback",
        "Support tickets",
        "Localization",
    ];

    const userProjects = store.listProjectsWithStacks(creatorId);
    const allStacks = userProjects.flatMap((p) => p.stacks);
    const templateCards = allStacks.flatMap((s) => store.getAllCardsByStack(s.id));
    const imagePool = templateCards.map((c) => c.imageUrl).filter((u): u is string => Boolean(u));
    const textPool = templateCards
        .map((c) => c.content?.trim())
        .filter((t): t is string => Boolean(t))
        .filter((t) => !/^https?:\/\//i.test(t));

    const fallbackTexts = [
        "Homepage hero variation A",
        "Checkout CTA copy option B",
        "Pricing card layout option C",
        "Onboarding step screenshot",
        "Accessibility color contrast check",
        "Localization screenshot candidate",
    ];

    const created = { projects: 0, stacks: 0, cards: 0, imageCards: 0 };
    const stamp = new Date().toISOString().slice(0, 10);

    for (let p = 0; p < projectsToCreate; p += 1) {
        const projectLabel = `${projectPool[p % projectPool.length]} ${stamp} #${p + 1}`;
        const project = store.createProject(projectLabel, creatorId);
        created.projects += 1;
        for (let s = 0; s < stacksPerProject; s += 1) {
            const stackLabel = `${labelPool[s % labelPool.length]} ${s + 1}`;
            const stack = store.createStack(project.id, stackLabel);
            created.stacks += 1;
            for (let c = 0; c < cardsPerStack; c += 1) {
                const text =
                    textPool[(p * stacksPerProject * cardsPerStack + s * cardsPerStack + c) % Math.max(1, textPool.length)] ||
                    fallbackTexts[c % fallbackTexts.length];
                const maybeImage = imagePool.length > 0 && c % 2 === 0
                    ? imagePool[(p * stacksPerProject * cardsPerStack + s * cardsPerStack + c) % imagePool.length]
                    : undefined;
                const card = store.createCard(stack.id, { content: text, imageUrl: maybeImage });
                if (card) {
                    created.cards += 1;
                    if (card.imageUrl)
                        created.imageCards += 1;
                }
            }
        }
    }

    res.json({
        ok: true,
        creatorId,
        created,
        source: {
            templateCards: templateCards.length,
            imageTemplates: imagePool.length,
            textTemplates: textPool.length,
        },
    });
});

export { api };
