import type { Card, Project, Stack } from "./types";
import type { CreatorSettings, DbState } from "./storage/types";
import { getBackend } from "./storage";

export type { CreatorSettings, DbState };

function id(): string {
  return Math.random().toString(36).slice(2, 11);
}

const WELCOME_STACKS = [
  {
    label: "How to get started",
    cards: [
      "Swipe RIGHT to approve, LEFT to reject",
      "Create projects, add stacks, share review links with anyone",
      "Reviewers never need an account — just open the link and swipe",
      "Use Dev User 1 in the Account menu to try as a logged-in creator",
    ],
  },
  {
    label: "What to do in terminal",
    cards: [
      "npm run api — start the API at localhost:3000",
      "npm run mobile — start the Expo app (simulator, device, or web)",
      "npm run seed — add more demo projects, stacks, and scores",
      "npm run check-data — verify PostgreSQL or JSON storage",
      "npm run load-folder demo — create a stack from a local folder",
    ],
  },
  {
    label: "Benefits when using premium",
    cards: [
      "Deploy for 24/7 access — no ngrok, stable URL",
      "Use a stable URL for Google OAuth and webhooks",
      "Short links, password on links, expiry (Phase 3 features)",
    ],
  },
];

function seedWelcomeContent(s: DbState): DbState {
  const now = new Date().toISOString();
  const projectId = id();
  const project: Project = {
    id: projectId,
    label: "Welcome to uhmm.link",
    createdAt: now,
    creatorId: null,
    order: 0,
  };
  const newStacks: Stack[] = [];
  const newCards: Card[] = [];

  WELCOME_STACKS.forEach((def, stackOrder) => {
    const stackId = id();
    newStacks.push({
      id: stackId,
      projectId,
      label: def.label,
      createdAt: now,
      creatorId: null,
      order: stackOrder,
    });
    def.cards.forEach((content) => {
      newCards.push({
        id: id(),
        stackId,
        content,
        createdAt: now,
      });
    });
  });

  return {
    ...s,
    projects: [...s.projects, project],
    stacks: [...s.stacks, ...newStacks],
    cards: [...s.cards, ...newCards],
  };
}

let state: DbState = {
  projects: [],
  stacks: [],
  cards: [],
  scores: [],
  users: [],
  userScoreLinks: [],
  stackAssignments: [],
  creatorSettings: [],
};

function runMigrations(s: DbState): DbState {
  let { projects, stacks, cards, scores, users, userScoreLinks, stackAssignments, creatorSettings } = s;

  // Migration: add users array if missing (legacy)
  if (!Array.isArray(users)) users = [];

  // Migration: add creatorId to projects/stacks that don't have it (legacy = anonymous)
  const needsCreatorIdMigration =
    projects.some((p) => !("creatorId" in p)) || stacks.some((s) => !("creatorId" in s));
  if (needsCreatorIdMigration) {
    projects = projects.map((p) => ({ ...p, creatorId: (p as Project & { creatorId?: string }).creatorId ?? null }));
    const projectMap = new Map(projects.map((p) => [p.id, p]));
    stacks = stacks.map((st) => {
      const stack = st as Stack & { creatorId?: string; projectId?: string };
      const proj = projectMap.get(stack.projectId ?? "");
      return { ...stack, creatorId: stack.creatorId ?? proj?.creatorId ?? null };
    });
  }

  // Migration: projects without order → assign order by createdAt
  const needsOrderMigration = projects.some((p) => (p as Project & { order?: number }).order === undefined);
  if (needsOrderMigration) {
    projects = [...projects]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((p, i) => ({ ...p, order: i }));
  }

  // Migration: stacks without projectId → assign to Project #1
  const needsProjectIdMigration = stacks.some((st) => !(st as Stack & { projectId?: string }).projectId);
  if (needsProjectIdMigration) {
    let proj = projects.find((p) => p.label.startsWith("Project #"));
    if (!proj) {
      proj = {
        id: "p" + Math.random().toString(36).slice(2, 11),
        label: "Project #1",
        createdAt: new Date().toISOString(),
      };
      projects = [proj, ...projects];
    }
    stacks = stacks.map((st) => {
      const stack = st as Stack & { projectId?: string };
      if (!stack.projectId) return { ...stack, projectId: proj!.id };
      return stack;
    });
  }

  // Migration: stacks without order -> assign order per project by existing createdAt desc ordering.
  const needsStackOrderMigration = stacks.some((st) => (st as Stack & { order?: number }).order === undefined);
  if (needsStackOrderMigration) {
    const byProject = new Map<string, Stack[]>();
    stacks.forEach((st) => {
      const list = byProject.get(st.projectId) ?? [];
      list.push(st);
      byProject.set(st.projectId, list);
    });
    const orderMap = new Map<string, number>();
    byProject.forEach((projectStacks) => {
      projectStacks
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .forEach((st, idx) => orderMap.set(st.id, idx));
    });
    stacks = stacks.map((st) => ({ ...st, order: (st as Stack & { order?: number }).order ?? orderMap.get(st.id) ?? 0 }));
  }

  return { projects, stacks, cards, scores, users, userScoreLinks, stackAssignments, creatorSettings };
}

let initPromise: Promise<void> | null = null;

export async function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const backend = getBackend();
    const raw = await backend.load();
    state = runMigrations(raw);
    if (state.projects.length === 0) {
      state = seedWelcomeContent(state);
    }
    await backend.save(state);
  })();
  return initPromise;
}

export function getState(): DbState {
  return state;
}

export function persist(newState: DbState): void {
  state = newState;
  const backend = getBackend();
  backend.save(state).catch((err) => console.error("Failed to persist:", err));
}
