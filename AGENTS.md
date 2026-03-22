# Agent guidance for uhmm.link

Quick reference for AI agents (OpenClaw and others) integrating with uhmm.link.

## Creating stacks with cards

Use **POST /api/deck** — creates project + stack + cards in one call. No auth required.

```json
POST /api/deck
{
  "projectId": "optional-existing-project-id",
  "label": "Stack label",
  "cards": ["text1", "text2", { "content": "text3", "imageUrl": "https://..." }]
}
```

Response includes `stack` (with `id`) and `cards`. Build review URL: `{baseUrl}/review/{projectId}/{stackId}` or `{baseUrl}/review/{stackId}`.

## Fetching stack and cards

**GET /api/stacks/:id** returns stack metadata plus a `cards` array. One call gives everything.

Alternatively: **GET /api/stacks/:id/all-cards** for cards only.

## Auth

- **Reads:** No auth. All GET endpoints work without cookies or headers.
- **Writes** (create stack, add cards, delete): Session cookie `uhmm_session` required when modifying creator-owned resources.

## Full spec

See [docs/API.md](docs/API.md) for the complete endpoint reference.
