import { Pool } from "pg";
import type { StorageBackend, DbState } from "./types";

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS uhmm_state (
  id INT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT single_row CHECK (id = 1)
);
`;

const emptyState: DbState = {
  projects: [],
  stacks: [],
  cards: [],
  scores: [],
  users: [],
  userScoreLinks: [],
  stackAssignments: [],
  creatorSettings: [],
};

function parseState(data: unknown): DbState {
  if (!data || typeof data !== "object") return emptyState;
  const d = data as Record<string, unknown>;
  return {
    projects: Array.isArray(d.projects) ? d.projects : [],
    stacks: Array.isArray(d.stacks) ? d.stacks : [],
    cards: Array.isArray(d.cards) ? d.cards : [],
    scores: Array.isArray(d.scores) ? d.scores : [],
    users: Array.isArray(d.users) ? d.users : [],
    userScoreLinks: Array.isArray(d.userScoreLinks) ? d.userScoreLinks : [],
    stackAssignments: Array.isArray(d.stackAssignments) ? d.stackAssignments : [],
    creatorSettings: Array.isArray(d.creatorSettings) ? d.creatorSettings : [],
  };
}

export function createPostgresBackend(connectionString: string): StorageBackend {
  const pool = new Pool({ connectionString });

  return {
    load: async (): Promise<DbState> => {
      const client = await pool.connect();
      try {
        await client.query(INIT_SQL);
        const res = await client.query("SELECT data FROM uhmm_state WHERE id = 1");
        if (res.rows.length > 0 && res.rows[0].data) {
          return parseState(res.rows[0].data);
        }
        return emptyState;
      } catch (err) {
        console.error("PostgreSQL load error:", err);
        throw err;
      } finally {
        client.release();
      }
    },
    save: async (state: DbState): Promise<void> => {
      const client = await pool.connect();
      try {
        await client.query(INIT_SQL);
        await client.query(
          `INSERT INTO uhmm_state (id, data) VALUES (1, $1::jsonb)
           ON CONFLICT (id) DO UPDATE SET data = $1::jsonb`,
          [JSON.stringify(state)]
        );
      } catch (err) {
        console.error("Failed to persist data:", err);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
