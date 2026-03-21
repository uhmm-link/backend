import type { Card, Project, Score, Stack, StackAssignment, UserScoreLink } from "../types";

export interface CreatorSettings {
  creatorId: string;
  callbackUrl?: string | null;
  notificationEmail?: string | null;
}

export interface DbState {
  projects: Project[];
  stacks: Stack[];
  cards: Card[];
  scores: Score[];
  userScoreLinks: UserScoreLink[];
  stackAssignments: StackAssignment[];
  creatorSettings: CreatorSettings[];
}

export interface StorageBackend {
  load(): Promise<DbState>;
  save(state: DbState): Promise<void>;
}
