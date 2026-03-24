import * as fs from "fs";
import * as path from "path";
import type { StorageBackend, DbState } from "./types";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "uhmm.json");

function loadRaw(): DbState {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const data = JSON.parse(raw) as DbState & { projects?: DbState["projects"] };
      const projects = Array.isArray(data.projects) ? data.projects : [];
      const stacks = Array.isArray(data.stacks) ? data.stacks : [];
      const cards = Array.isArray(data.cards) ? data.cards : [];
      const scores = Array.isArray((data as { scores?: DbState["scores"] }).scores)
        ? (data as DbState).scores
        : [];
      const userScoreLinks = Array.isArray((data as { userScoreLinks?: DbState["userScoreLinks"] }).userScoreLinks)
        ? (data as DbState).userScoreLinks
        : [];
      const stackAssignments = Array.isArray((data as { stackAssignments?: DbState["stackAssignments"] }).stackAssignments)
        ? (data as DbState).stackAssignments
        : [];
      const creatorSettings = Array.isArray((data as { creatorSettings?: DbState["creatorSettings"] }).creatorSettings)
        ? (data as DbState).creatorSettings
        : [];
      const users = Array.isArray((data as { users?: DbState["users"] }).users) ? (data as DbState).users : [];
      return { projects, stacks, cards, scores, users, userScoreLinks, stackAssignments, creatorSettings };
    }
  } catch (_) {
    // Corrupt or invalid file — start fresh
  }
  return {
    projects: [],
    stacks: [],
    cards: [],
    scores: [],
    users: [],
    userScoreLinks: [],
    stackAssignments: [],
    creatorSettings: [],
  };
}

function saveRaw(state: DbState): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to persist data:", err);
  }
}

export function createJsonBackend(): StorageBackend {
  return {
    load: () => Promise.resolve(loadRaw()),
    save: (state) => {
      saveRaw(state);
      return Promise.resolve();
    },
  };
}
