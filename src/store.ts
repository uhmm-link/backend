import { getState, persist } from "./db";
import { persistInlineImage } from "./uploads";
import type { Card, Project, Score, Stack, StackAssignment, UserScoreLink } from "./types";
import type { StoredUser } from "./storage/types";

function id(): string {
  return Math.random().toString(36).slice(2, 11);
}

function nextProjectLabel(): string {
  const projects = getState().projects.filter((p) => p.label.startsWith("Project #"));
  const nums = projects.map((p) => parseInt(p.label.replace("Project #", ""), 10)).filter((n) => !isNaN(n));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `Project #${next}`;
}

function nextStackLabel(projectId: string): string {
  const stacks = getState().stacks.filter((s) => s.projectId === projectId && s.label.startsWith("Stack #"));
  const nums = stacks.map((s) => parseInt(s.label.replace("Stack #", ""), 10)).filter((n) => !isNaN(n));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `Stack #${next}`;
}

function nextStackOrder(projectId: string): number {
  const stacks = getState().stacks.filter((s) => s.projectId === projectId);
  const maxOrder = stacks.reduce((m, s) => Math.max(m, s.order ?? -1), -1);
  return maxOrder + 1;
}

export function createUser(data: {
  email: string;
  passwordHash: string;
  passwordSalt: string;
  name?: string;
  userType?: "human" | "agent";
}): StoredUser {
  const s = getState();
  const users = s.users ?? [];
  const userId = `user_${id()}`;
  const user: StoredUser = {
    id: userId,
    email: data.email.trim().toLowerCase(),
    passwordHash: data.passwordHash,
    passwordSalt: data.passwordSalt,
    name: data.name?.trim(),
    userType: data.userType,
    createdAt: new Date().toISOString(),
  };
  persist({ ...s, users: [...users, user] });
  return user;
}

export function getUserByEmail(email: string): StoredUser | undefined {
  const norm = email?.trim().toLowerCase();
  return (getState().users ?? []).find((u) => u.email === norm);
}

export function getUserById(id: string): StoredUser | undefined {
  return (getState().users ?? []).find((u) => u.id === id);
}

export function createProject(label?: string, creatorId?: string | null): Project {
  const s = getState();
  const creatorProjects = s.projects.filter((p) => (p.creatorId ?? null) === (creatorId ?? null));
  const maxOrder = creatorProjects.reduce((m, p) => Math.max(m, p.order ?? -1), -1);
  const proj: Project = {
    id: id(),
    label: label?.trim() || nextProjectLabel(),
    createdAt: new Date().toISOString(),
    creatorId: creatorId ?? null,
    order: maxOrder + 1,
  };
  persist({
    ...s,
    projects: [...s.projects, proj],
  });
  return proj;
}

export function listProjects(creatorId?: string | null): Project[] {
  const projects = getState().projects;
  // When creatorId not provided, return all projects (for local/anonymous use)
  const filtered =
    creatorId != null && creatorId !== ""
      ? projects.filter((p) => (p.creatorId ?? null) === creatorId)
      : projects;
  return [...filtered].sort((a, b) => {
    const orderA = a.order ?? Infinity;
    const orderB = b.order ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export function getProject(id: string): Project | undefined {
  return getState().projects.find((p) => p.id === id);
}

export function reorderProjects(projectIds: string[], creatorId?: string | null): boolean {
  const s = getState();
  const creatorProjects = s.projects.filter((p) => (p.creatorId ?? null) === (creatorId ?? null));
  const idSet = new Set(projectIds);
  if (projectIds.length !== idSet.size || projectIds.some((id) => !creatorProjects.find((p) => p.id === id))) {
    return false;
  }
  const orderByProjectId = new Map<string, number>();
  projectIds.forEach((id, i) => orderByProjectId.set(id, i));
  const projects = s.projects.map((p) => {
    const ord = orderByProjectId.get(p.id);
    return ord !== undefined ? { ...p, order: ord } : p;
  });
  persist({ ...s, projects });
  return true;
}

export function updateProjectLabel(projectId: string, label: string): string | null {
  const s = getState();
  const idx = s.projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  const trimmed = label?.trim?.() || "";
  if (!trimmed) return null;
  const projects = [...s.projects];
  projects[idx] = { ...projects[idx], label: trimmed };
  persist({ ...s, projects });
  return trimmed;
}

export function updateProjectCallbackUrl(projectId: string, callbackUrl: string | null): boolean {
  const s = getState();
  const idx = s.projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return false;
  const projects = [...s.projects];
  const val = callbackUrl?.trim() || null;
  projects[idx] = { ...projects[idx], callbackUrl: val ?? undefined };
  persist({ ...s, projects });
  return true;
}

export function getCreatorSettings(creatorId: string | null | undefined): { callbackUrl?: string | null; notificationEmail?: string | null; shareBaseUrl?: string | null } {
  if (!creatorId) return {};
  const settings = getState().creatorSettings?.find((cs) => cs.creatorId === creatorId);
  return {
    callbackUrl: settings?.callbackUrl ?? undefined,
    notificationEmail: settings?.notificationEmail ?? undefined,
    shareBaseUrl: settings?.shareBaseUrl ?? undefined,
  };
}

export function updateCreatorCallbackUrl(creatorId: string | null | undefined, callbackUrl: string | null): boolean {
  if (!creatorId) return false;
  const s = getState();
  const settings = s.creatorSettings ?? [];
  const idx = settings.findIndex((cs) => cs.creatorId === creatorId);
  const val = callbackUrl?.trim() || null;
  let creatorSettings: typeof s.creatorSettings;
  if (idx >= 0) {
    creatorSettings = [...settings];
    creatorSettings[idx] = { ...creatorSettings[idx], callbackUrl: val ?? undefined };
  } else {
    creatorSettings = [...settings, { creatorId, callbackUrl: val ?? undefined }];
  }
  persist({ ...s, creatorSettings });
  return true;
}

export function updateCreatorSettings(
  creatorId: string | null | undefined,
  patch: { callbackUrl?: string | null; notificationEmail?: string | null; shareBaseUrl?: string | null }
): boolean {
  if (!creatorId) return false;
  const s = getState();
  const settings = s.creatorSettings ?? [];
  const idx = settings.findIndex((cs) => cs.creatorId === creatorId);
  const callbackUrl =
    patch.callbackUrl !== undefined ? (patch.callbackUrl?.trim() || null) : undefined;
  const notificationEmail =
    patch.notificationEmail !== undefined ? (patch.notificationEmail?.trim() || null) : undefined;
  const shareBaseUrl =
    patch.shareBaseUrl !== undefined ? (patch.shareBaseUrl?.trim() || null) : undefined;
  let creatorSettings: typeof s.creatorSettings;
  if (idx >= 0) {
    creatorSettings = [...settings];
    creatorSettings[idx] = {
      ...creatorSettings[idx],
      ...(callbackUrl !== undefined ? { callbackUrl: callbackUrl ?? undefined } : {}),
      ...(notificationEmail !== undefined ? { notificationEmail: notificationEmail ?? undefined } : {}),
      ...(shareBaseUrl !== undefined ? { shareBaseUrl: shareBaseUrl ?? undefined } : {}),
    };
  } else {
    creatorSettings = [
      ...settings,
      {
        creatorId,
        ...(callbackUrl !== undefined ? { callbackUrl: callbackUrl ?? undefined } : {}),
        ...(notificationEmail !== undefined ? { notificationEmail: notificationEmail ?? undefined } : {}),
        ...(shareBaseUrl !== undefined ? { shareBaseUrl: shareBaseUrl ?? undefined } : {}),
      },
    ];
  }
  persist({ ...s, creatorSettings });
  return true;
}

/** Resolve webhook URL: project → account (project overrides account if populated). */
export function getResolvedCallbackUrl(stack: Stack): string | null {
  const proj = getProject(stack.projectId);
  const projectUrl = proj?.callbackUrl?.trim();
  if (projectUrl) return projectUrl;
  const creatorId = proj?.creatorId ?? stack.creatorId;
  const accountUrl = getCreatorSettings(creatorId).callbackUrl?.trim();
  return accountUrl || null;
}

export function updateStackLabel(stackId: string, label: string): string | null {
  const s = getState();
  const idx = s.stacks.findIndex((st) => st.id === stackId);
  if (idx < 0) return null;
  const trimmed = label?.trim?.() || "";
  if (!trimmed) return null;
  const stacks = [...s.stacks];
  stacks[idx] = { ...stacks[idx], label: trimmed };
  persist({ ...s, stacks });
  return trimmed;
}

export function createStack(projectId: string, label?: string): Stack {
  const proj = getProject(projectId);
  if (!proj) throw new Error("Project not found");
  const stack: Stack = {
    id: id(),
    projectId,
    label: label?.trim() || nextStackLabel(projectId),
    createdAt: new Date().toISOString(),
    creatorId: proj.creatorId ?? null,
    order: nextStackOrder(projectId),
  };
  const s = getState();
  persist({
    ...s,
    stacks: [...s.stacks, stack],
  });
  return stack;
}

/** Create stack with specific id (for local folder stacks). */
export function createStackWithId(
  projectId: string,
  stackId: string,
  label?: string
): Stack | null {
  const proj = getProject(projectId);
  if (!proj) return null;
  const existing = getStack(stackId);
  if (existing) return existing;
  const stack: Stack = {
    id: stackId,
    projectId,
    label: label?.trim() || stackId,
    createdAt: new Date().toISOString(),
    order: nextStackOrder(projectId),
  };
  const s = getState();
  persist({
    ...s,
    stacks: [...s.stacks, stack],
  });
  return stack;
}

export function getStack(id: string): Stack | undefined {
  return getState().stacks.find((s) => s.id === id);
}

export function listStacks(projectId?: string): Stack[] {
  const stacks = projectId
    ? getState().stacks.filter((s) => s.projectId === projectId)
    : getState().stacks;
  return [...stacks].sort((a, b) => {
    const orderA = a.order ?? Infinity;
    const orderB = b.order ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

export function reorderStacks(projectId: string, stackIds: string[]): boolean {
  const s = getState();
  const projectStacks = s.stacks.filter((st) => st.projectId === projectId);
  const idSet = new Set(stackIds);
  if (
    stackIds.length !== idSet.size ||
    stackIds.length !== projectStacks.length ||
    stackIds.some((id) => !projectStacks.find((st) => st.id === id))
  ) {
    return false;
  }
  const orderByStackId = new Map<string, number>();
  stackIds.forEach((id, i) => orderByStackId.set(id, i));
  const stacks = s.stacks.map((st) => {
    const ord = orderByStackId.get(st.id);
    return ord !== undefined ? { ...st, order: ord } : st;
  });
  persist({ ...s, stacks });
  return true;
}

export function getScoreCount(stackId: string): number {
  return (getState().scores ?? []).filter((sc) => sc.stackId === stackId).length;
}

export function listProjectsWithStacks(creatorId?: string | null): (Project & { stacks: (Stack & { scoreCount: number })[] })[] {
  const projects = listProjects(creatorId);
  return projects.map((p) => ({
    ...p,
    stacks: listStacks(p.id).map((s) => ({ ...s, scoreCount: getScoreCount(s.id) })),
  }));
}

/** Add assignment linking stack to reviewer (idempotent). */
export function addStackAssignment(
  stackId: string,
  projectId: string,
  reviewerId: string,
  reviewerName: string
): boolean {
  const stack = getStack(stackId);
  if (!stack || stack.projectId !== projectId) return false;
  const s = getState();
  const assignments = s.stackAssignments ?? [];
  const exists = assignments.some((a) => a.stackId === stackId && a.reviewerId === reviewerId);
  if (exists) return true;
  const assignment: StackAssignment = {
    stackId,
    projectId,
    reviewerId,
    reviewerName,
    assignedAt: new Date().toISOString(),
  };
  persist({ ...s, stackAssignments: [...assignments, assignment] });
  return true;
}

/** Get stack IDs assigned to a reviewer. */
export function getAssignedStackIds(reviewerId: string): Set<string> {
  const assignments = getState().stackAssignments ?? [];
  return new Set(
    assignments.filter((a) => a.reviewerId === reviewerId).map((a) => a.stackId)
  );
}

/** Projects for a user: own projects + projects where user submitted scores as reviewer
 * or has an assignment. For reviewer projects, includes stacks reviewed or assigned.
 * Each stack includes scoreCount. */
export function listProjectsWithStacksForUser(
  userId: string,
  reviewerName?: string | null
): (Project & { stacks: (Stack & { scoreCount: number })[] })[] {
  const own = listProjectsWithStacks(userId);
  if (!userId?.trim()) return own;
  const stackIdsReviewed = new Set<string>();
  const projectIdsByStack = new Map<string, string>();
  for (const sc of getState().scores ?? []) {
    if (sc.reviewerId === userId) {
      stackIdsReviewed.add(sc.stackId);
      const stack = getStack(sc.stackId);
      if (stack?.projectId) projectIdsByStack.set(sc.stackId, stack.projectId);
    }
  }
  const assignedStackIds = getAssignedStackIds(userId);
  for (const stackId of assignedStackIds) {
    const stack = getStack(stackId);
    if (stack?.projectId) {
      projectIdsByStack.set(stackId, stack.projectId);
    }
  }
  const projectToStacks = new Map<string, string[]>();
  for (const [stackId, projectId] of projectIdsByStack) {
    const arr = projectToStacks.get(projectId) ?? [];
    if (!arr.includes(stackId)) arr.push(stackId);
    projectToStacks.set(projectId, arr);
  }
  const ownIds = new Set(own.map((p) => p.id));
  const reviewerProjects = [...projectToStacks.entries()]
    .filter(([projectId]) => !ownIds.has(projectId))
    .map(([projectId, stackIds]) => {
      const proj = getProject(projectId);
      if (!proj) return null;
      const stacks = stackIds
        .map((id) => getStack(id))
        .filter((s): s is Stack => !!s)
        .map((s) => {
          const sessions = getSessionsByStack(s.id);
          const mySession = sessions.find((sess) => sess.reviewerId === userId);
          const hasScoresFromMe = !!mySession;
          return {
            ...s,
            scoreCount: getScoreCount(s.id),
            hasScoresFromMe,
            mySessionId: mySession?.sessionId as string | undefined,
          };
        });
      return { ...proj, stacks };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  return [...own, ...reviewerProjects];
}

export function createCard(
  stackId: string,
  data: { content: string; imageUrl?: string; meta?: Record<string, string> }
): Card | null {
  const stack = getStack(stackId);
  if (!stack) return null;
  const cardId = id();
  let imageUrl = data.imageUrl;
  if (imageUrl) {
    try {
      imageUrl = persistInlineImage(stackId, cardId, imageUrl);
    } catch (err) {
      // Keep original URL if file persistence fails unexpectedly.
      console.error("Failed to persist inline image:", err);
    }
  }
  const card: Card = {
    id: cardId,
    stackId,
    content: data.content,
    imageUrl,
    meta: data.meta,
    createdAt: new Date().toISOString(),
  };
  const s = getState();
  persist({
    ...s,
    cards: [...s.cards, card],
  });
  return card;
}

export function getCardsByStack(stackId: string): Card[] {
  return getState().cards
    .filter((c) => c.stackId === stackId && !c.decision)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
}

export function getCard(id: string): Card | undefined {
  return getState().cards.find((c) => c.id === id);
}

export function getScoresByStack(stackId: string): Card[] {
  return getState().cards
    .filter((c) => c.stackId === stackId && c.decision)
    .sort(
      (a, b) =>
        new Date(b.decidedAt ?? 0).getTime() -
        new Date(a.decidedAt ?? 0).getTime()
    );
}

export function getAllCardsByStack(stackId: string): Card[] {
  return getState().cards
    .filter((c) => c.stackId === stackId)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
}

export function getAllCardsByProject(projectId: string): Card[] {
  const stackIds = getState().stacks
    .filter((s) => s.projectId === projectId)
    .map((s) => s.id);
  return getState().cards
    .filter((c) => stackIds.includes(c.stackId))
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
}

export function deleteProject(projectId: string): boolean {
  const s = getState();
  const proj = s.projects.find((p) => p.id === projectId);
  if (!proj) return false;
  const stackIds = s.stacks.filter((st) => st.projectId === projectId).map((st) => st.id);
  const cards = s.cards.filter((c) => !stackIds.includes(c.stackId));
  const stacks = s.stacks.filter((st) => st.projectId !== projectId);
  const projects = s.projects.filter((p) => p.id !== projectId);
  persist({ ...s, projects, stacks, cards });
  return true;
}

export function clearProject(projectId: string): boolean {
  const s = getState();
  const stackIds = s.stacks.filter((st) => st.projectId === projectId).map((st) => st.id);
  if (stackIds.length === 0) return true;
  const stackIdSet = new Set(stackIds);
  const cards = s.cards.map((c) =>
    stackIdSet.has(c.stackId)
      ? { ...c, decision: undefined, decidedAt: undefined }
      : c
  );
  const scores = (s.scores ?? []).filter((sc) => !stackIdSet.has(sc.stackId));
  persist({ ...s, cards, scores });
  return true;
}

export function deleteStack(stackId: string): boolean {
  const s = getState();
  const stack = s.stacks.find((st) => st.id === stackId);
  if (!stack) return false;
  const stacks = s.stacks.filter((st) => st.id !== stackId);
  const cards = s.cards.filter((c) => c.stackId !== stackId);
  const scores = (s.scores ?? []).filter((sc) => sc.stackId !== stackId);
  persist({ ...s, stacks, cards, scores });
  return true;
}

export function clearStack(stackId: string): boolean {
  const s = getState();
  const stack = s.stacks.find((st) => st.id === stackId);
  if (!stack) return false;
  const cards = s.cards.map((c) =>
    c.stackId === stackId ? { ...c, decision: undefined, decidedAt: undefined } : c
  );
  const scores = (s.scores ?? []).filter((sc) => sc.stackId !== stackId);
  persist({ ...s, cards, scores });
  return true;
}

export function deleteCards(stackId: string, cardIds: string[]): number {
  const s = getState();
  const idSet = new Set(cardIds);
  const toRemove = s.cards.filter((c) => c.stackId === stackId && idSet.has(c.id));
  if (toRemove.length === 0) return 0;
  const removeIds = new Set(toRemove.map((c) => c.id));
  const cards = s.cards.filter((c) => !removeIds.has(c.id));
  const scores = (s.scores ?? []).filter((sc) => !removeIds.has(sc.cardId));
  persist({ ...s, cards, scores });
  return toRemove.length;
}

export function recordDecision(
  cardId: string,
  decision: "approved" | "rejected"
): Card | null {
  const s = getState();
  const idx = s.cards.findIndex((c) => c.id === cardId);
  if (idx < 0) return null;
  const card = s.cards[idx];
  const updated: Card = {
    ...card,
    decision,
    decidedAt: new Date().toISOString(),
  };
  const cards = [...s.cards];
  cards[idx] = updated;
  persist({ ...s, cards });
  return updated;
}

export function recordScoresBatch(
  stackId: string,
  reviewerId: string,
  reviewerName: string,
  sessionId: string,
  decisions: { cardId: string; decision: "approved" | "rejected"; decidedAt?: string; swipeTimeMs?: number | null }[]
): boolean {
  const stack = getStack(stackId);
  if (!stack) return false;
  const now = new Date().toISOString();
  const newScores: Score[] = decisions.map((d) => ({
    sessionId,
    stackId,
    reviewerId,
    reviewerName,
    cardId: d.cardId,
    decision: d.decision,
    decidedAt: d.decidedAt ?? now,
    swipeTimeMs: d.swipeTimeMs ?? undefined,
  }));
  const s = getState();
  const existingScores = s.scores ?? [];
  persist({
    ...s,
    scores: [...existingScores, ...newScores],
  });
  return true;
}

export function getScoresBySession(stackId: string, sessionId: string): Score[] {
  return (getState().scores ?? [])
    .filter((sc) => sc.stackId === stackId && sc.sessionId === sessionId)
    .sort(
      (a, b) =>
        new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime()
    );
}

export function getSessionsByStack(stackId: string): { sessionId: string; reviewerId: string; reviewerName: string }[] {
  const seen = new Set<string>();
  return (getState().scores ?? [])
    .filter((sc) => sc.stackId === stackId)
    .filter((sc) => {
      const key = sc.sessionId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((sc) => ({ sessionId: sc.sessionId, reviewerId: sc.reviewerId, reviewerName: sc.reviewerName }));
}

export function clearSession(stackId: string, sessionId: string): boolean {
  const s = getState();
  const stack = s.stacks.find((st) => st.id === stackId);
  if (!stack) return false;
  const scores = (s.scores ?? []).filter(
    (sc) => !(sc.stackId === stackId && sc.sessionId === sessionId)
  );
  persist({ ...s, scores });
  return true;
}

export interface ExportRow {
  projectLabel: string;
  stackLabel: string;
  reviewerName: string;
  cardId: string;
  content: string;
  decision: string;
  decidedAt: string;
  createdAt: string;
}

export function getExportRows(
  projectIds: string[],
  stackIds: string[],
  sessions: { stackId: string; sessionId: string }[]
): ExportRow[] {
  const s = getState();
  const key = (stackId: string, sessionId: string) => `${stackId}:${sessionId}`;
  const include = new Set<string>();

  for (const pid of projectIds) {
    const stacks = s.stacks.filter((st) => st.projectId === pid);
    for (const st of stacks) {
      include.add(key(st.id, "direct"));
      for (const sc of s.scores ?? []) {
        if (sc.stackId === st.id) include.add(key(sc.stackId, sc.sessionId));
      }
    }
  }
  for (const sid of stackIds) {
    include.add(key(sid, "direct"));
    for (const sc of s.scores ?? []) {
      if (sc.stackId === sid) include.add(key(sc.stackId, sc.sessionId));
    }
  }
  for (const { stackId, sessionId } of sessions) {
    include.add(key(stackId, sessionId));
  }

  const rows: ExportRow[] = [];
  const cardMap = new Map(s.cards.map((c) => [c.id, c]));

  for (const k of include) {
    const [stackId, sessionId] = k.split(":");
    const stack = s.stacks.find((st) => st.id === stackId);
    if (!stack) continue;
    const project = s.projects.find((p) => p.id === stack.projectId);
    const projectLabel = project?.label ?? "";
    const stackLabel = stack.label;

    if (sessionId === "direct") {
      const cards = s.cards.filter((c) => c.stackId === stackId && c.decision);
      for (const c of cards) {
        rows.push({
          projectLabel,
          stackLabel,
          reviewerName: "Direct",
          cardId: c.id,
          content: c.content ?? "",
          decision: c.decision ?? "",
          decidedAt: c.decidedAt ?? "",
          createdAt: c.createdAt ?? "",
        });
      }
    } else {
      const rawScores = getScoresBySession(stackId, sessionId);
      const reviewerName = rawScores[0]?.reviewerName ?? "";
      for (const sc of rawScores) {
        const card = cardMap.get(sc.cardId);
        rows.push({
          projectLabel,
          stackLabel,
          reviewerName,
          cardId: sc.cardId,
          content: card?.content ?? "",
          decision: sc.decision,
          decidedAt: sc.decidedAt,
          createdAt: card?.createdAt ?? "",
        });
      }
    }
  }

  return rows;
}

/** Full export: raw decisions per reviewer. Used for JSON full and CSV full. */
export interface ExportFullRow {
  projectLabel: string;
  stackId: string;
  stackLabel: string;
  reviewerId: string;
  reviewerName: string;
  cardId: string;
  content: string;
  imageUrl?: string;
  decision: string;
  swipeTimeMs: number | null;
}

export function getExportDataFull(
  projectIds: string[],
  stackIds: string[],
  sessions: { stackId: string; sessionId: string }[]
): ExportFullRow[] {
  const s = getState();
  const cardMap = new Map(s.cards.map((c) => [c.id, c]));
  const key = (stackId: string, sessionId: string) => `${stackId}:${sessionId}`;
  const include = new Set<string>();

  for (const pid of projectIds) {
    const stacks = s.stacks.filter((st) => st.projectId === pid);
    for (const st of stacks) {
      include.add(key(st.id, "direct"));
      for (const sc of s.scores ?? []) {
        if (sc.stackId === st.id) include.add(key(sc.stackId, sc.sessionId));
      }
    }
  }
  for (const sid of stackIds) {
    include.add(key(sid, "direct"));
    for (const sc of s.scores ?? []) {
      if (sc.stackId === sid) include.add(key(sc.stackId, sc.sessionId));
    }
  }
  for (const { stackId, sessionId } of sessions) {
    include.add(key(stackId, sessionId));
  }

  const rows: ExportFullRow[] = [];

  for (const k of include) {
    const [stackId, sessionId] = k.split(":");
    const stack = s.stacks.find((st) => st.id === stackId);
    if (!stack) continue;
    const project = s.projects.find((p) => p.id === stack.projectId);
    const projectLabel = project?.label ?? "";
    const stackLabel = stack.label;
    if (sessionId === "direct") {
      const reviewerId = "direct";
      const cards = s.cards.filter((c) => c.stackId === stackId && c.decision);
      for (const c of cards) {
        rows.push({
          projectLabel,
          stackId,
          stackLabel,
          reviewerId,
          reviewerName: "Direct",
          cardId: c.id,
          content: c.content ?? "",
          imageUrl: c.imageUrl,
          decision: c.decision ?? "",
          swipeTimeMs: null,
        });
      }
    } else {
      const rawScores = getScoresBySession(stackId, sessionId);
      const reviewerId = rawScores[0]?.reviewerId ?? sessionId;
      const reviewerName = rawScores[0]?.reviewerName ?? "";
      for (const sc of rawScores) {
        const card = cardMap.get(sc.cardId);
        rows.push({
          projectLabel,
          stackId,
          stackLabel,
          reviewerId,
          reviewerName,
          cardId: sc.cardId,
          content: card?.content ?? "",
          imageUrl: card?.imageUrl,
          decision: sc.decision,
          swipeTimeMs: sc.swipeTimeMs ?? null,
        });
      }
    }
  }

  return rows;
}

/** Aggregated export: per-card stats. Used for JSON aggregated and CSV aggregated. */
export interface ExportAggregatedRow {
  projectLabel: string;
  stackId: string;
  stackLabel: string;
  cardId: string;
  content: string;
  approvals: number;
  rejections: number;
  total: number;
  approvalRate: number;
  avgSwipeTimeMs: number | null;
}

export function getExportDataAggregated(
  projectIds: string[],
  stackIds: string[],
  sessions: { stackId: string; sessionId: string }[]
): ExportAggregatedRow[] {
  const s = getState();
  const cardMap = new Map(s.cards.map((c) => [c.id, c]));
  const fullRows = getExportDataFull(projectIds, stackIds, sessions);
  const byKey = new Map<string, { approvals: number; rejections: number; total: number; stackLabel: string; stackId: string }>();

  for (const r of fullRows) {
    const k = `${r.stackId}:${r.cardId}`;
    const cur = byKey.get(k) ?? { approvals: 0, rejections: 0, total: 0, stackLabel: r.stackLabel, stackId: r.stackId };
    cur.total += 1;
    if (r.decision === "approved") cur.approvals += 1;
    else if (r.decision === "rejected") cur.rejections += 1;
    byKey.set(k, cur);
  }

  const rows: ExportAggregatedRow[] = [];
  for (const [k, v] of byKey) {
    const [stackId, cardId] = k.split(":");
    const stack = s.stacks.find((st) => st.id === stackId);
    const project = stack ? s.projects.find((p) => p.id === stack.projectId) : undefined;
    const card = cardMap.get(cardId);
    rows.push({
      projectLabel: project?.label ?? "",
      stackId,
      stackLabel: v.stackLabel,
      cardId,
      content: card?.content ?? "",
      approvals: v.approvals,
      rejections: v.rejections,
      total: v.total,
      approvalRate: v.total > 0 ? v.approvals / v.total : 0,
      avgSwipeTimeMs: null,
    });
  }
  return rows;
}

export function getUserScoreLinks(userId: string): UserScoreLink[] {
  return (getState().userScoreLinks ?? []).filter((l) => l.userId === userId);
}

/** Links for "Added via URL" display: excludes links where the stack's project is owned by the user.
 * When the user owns the project, scores appear under their project — not in "Added via URL". */
export function getUserScoreLinksForDisplay(userId: string): UserScoreLink[] {
  return getUserScoreLinks(userId).filter((link) => {
    const stack = getStack(link.stackId);
    if (!stack?.projectId) return true;
    const proj = getProject(stack.projectId);
    if (!proj) return true;
    return (proj.creatorId ?? null) !== userId;
  });
}

export function addUserScoreLink(userId: string, stackId: string, sessionId: string): boolean {
  const stack = getStack(stackId);
  if (!stack) return false;
  const rawScores = getScoresBySession(stackId, sessionId);
  if (rawScores.length === 0) return false;
  const links = getState().userScoreLinks ?? [];
  const exists = links.some((l) => l.userId === userId && l.stackId === stackId && l.sessionId === sessionId);
  if (exists) return true;
  const link: UserScoreLink = {
    userId,
    stackId,
    sessionId,
    addedAt: new Date().toISOString(),
  };
  persist({ ...getState(), userScoreLinks: [...links, link] });
  return true;
}

export function removeUserScoreLink(userId: string, stackId: string, sessionId: string): boolean {
  const s = getState();
  const links = (s.userScoreLinks ?? []).filter(
    (l) => !(l.userId === userId && l.stackId === stackId && l.sessionId === sessionId)
  );
  if (links.length === (s.userScoreLinks ?? []).length) return false;
  persist({ ...s, userScoreLinks: links });
  return true;
}

type ProjectWithStacks = Project & { stacks: (Stack & { scoreCount: number })[] };

/** Filter projects by search string. Matches project label, stack label, card content, or reviewer name. */
export function filterProjectsBySearch(
  projects: ProjectWithStacks[],
  q: string
): ProjectWithStacks[] {
  if (!q?.trim()) return projects;
  const lower = q.trim().toLowerCase();

  return projects
    .map((p) => {
      const projectMatches = (p.label ?? "").toLowerCase().includes(lower);
      const filteredStacks = p.stacks.filter((s) => {
        const stackMatches = (s.label ?? "").toLowerCase().includes(lower);
        const cards = getAllCardsByStack(s.id);
        const cardMatches = cards.some((c) => (c.content ?? "").toLowerCase().includes(lower));
        const sessions = getSessionsByStack(s.id);
        const reviewerMatches = sessions.some((r) => (r.reviewerName ?? "").toLowerCase().includes(lower));
        const hasDirect = getScoresByStack(s.id).length > 0;
        const directMatches = hasDirect && "direct".includes(lower);
        return stackMatches || cardMatches || reviewerMatches || directMatches;
      });

      if (projectMatches) return { ...p, stacks: p.stacks };
      if (filteredStacks.length > 0) return { ...p, stacks: filteredStacks };
      return null;
    })
    .filter((p): p is ProjectWithStacks => p !== null);
}

/** One-time migration: convert inline data URLs to persisted upload paths. */
export function migrateInlineImages(stackId?: string): { scanned: number; converted: number } {
  const s = getState();
  let scanned = 0;
  let converted = 0;
  const cards = s.cards.map((c) => {
    if (stackId && c.stackId !== stackId) return c;
    if (!c.imageUrl) return c;
    scanned += 1;
    if (!/^data:/i.test(c.imageUrl)) return c;
    try {
      const imageUrl = persistInlineImage(c.stackId, c.id, c.imageUrl);
      if (imageUrl !== c.imageUrl) {
        converted += 1;
        return { ...c, imageUrl };
      }
    } catch (err) {
      console.error("Failed to migrate inline image for card:", c.id, err);
    }
    return c;
  });
  if (converted > 0) {
    persist({ ...s, cards });
  }
  return { scanned, converted };
}
