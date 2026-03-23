export type Decision = "approved" | "rejected";

export interface Score {
  sessionId: string;
  stackId: string;
  reviewerId: string;
  reviewerName: string;
  cardId: string;
  decision: Decision;
  decidedAt: string;
  /** Time in ms from card shown to decision. Optional, from client. */
  swipeTimeMs?: number | null;
}

export interface Card {
  id: string;
  stackId: string;
  content: string;
  imageUrl?: string;
  meta?: Record<string, string>;
  createdAt: string;
  decision?: Decision;
  decidedAt?: string;
}

export interface Project {
  id: string;
  label: string;
  createdAt: string;
  /** When null/undefined, project is anonymous (creator was logged out). */
  creatorId?: string | null;
  /** Sort order (lower = first). Omitted for legacy projects. */
  order?: number;
  /** Webhook URL for score delivery. Overrides account default. */
  callbackUrl?: string | null;
}

export interface Stack {
  id: string;
  projectId: string;
  label: string;
  createdAt: string;
  /** Inherited from project. When null/undefined, stack is anonymous. */
  creatorId?: string | null;
  /** Sort order within a project (lower = first). */
  order?: number;
}

export interface CreateStackBody {
  projectId: string;
  label?: string;
}

export interface CreateCardBody {
  content: string;
  imageUrl?: string;
  meta?: Record<string, string>;
}

export interface RecordDecisionBody {
  decision: Decision;
}

/** Links a scores URL (stackId/sessionId) to a user's account. */
export interface UserScoreLink {
  userId: string;
  stackId: string;
  sessionId: string;
  addedAt: string;
}

/** Links a stack to a reviewer (created when reviewer opens link and enters name). */
export interface StackAssignment {
  stackId: string;
  projectId: string;
  reviewerId: string;
  reviewerName: string;
  assignedAt: string;
}
