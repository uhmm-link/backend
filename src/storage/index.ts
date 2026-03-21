import type { StorageBackend } from "./types";
import { createJsonBackend } from "./json";
import { createPostgresBackend } from "./postgres";

export function getBackend(): StorageBackend {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    return createPostgresBackend(url);
  }
  return createJsonBackend();
}
