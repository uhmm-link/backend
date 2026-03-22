# uhmm.link API Reference

Canonical endpoint reference for the uhmm.link backend. AI agents and integrations: see [AGENTS.md](../AGENTS.md) for quick-start guidance.

Base URL: `http://localhost:3000` (dev) or your deployment host. All API routes are under `/api`.

---

## Authentication

| Operation type | Auth required |
|----------------|---------------|
| **Reads** (GET stack, cards, projects, scores) | No |
| **Writes** (create/update/delete stack, add cards, delete project) | Session cookie `uhmm_session` for creator access |

Writes that touch a creator's project/stack require the creator to be logged in (cookie set). Reads work without any headers or cookies.

---

## Stack and cards

### GET /api/stacks/:id

Returns stack metadata plus all cards in one response.

**Auth:** None.

**Response:**
```json
{
  "id": "m69qlkyf3",
  "projectId": "80l6k2s1r",
  "label": "Stack #1",
  "creatorId": "u2",
  "createdAt": "...",
  "cards": [
    {
      "id": "abc123",
      "stackId": "m69qlkyf3",
      "content": "Card text",
      "imageUrl": "https://...",
      "createdAt": "..."
    }
  ]
}
```

### GET /api/stacks/:id/cards

Returns only **pending** cards (no decision yet).

**Auth:** None.

### GET /api/stacks/:id/all-cards

Returns **all** cards (pending + decided). Alternative if you prefer a dedicated cards endpoint.

**Auth:** None.

---

## Agent-friendly: POST /api/deck

**Recommended for AI agents.** Creates a project (if needed), a stack, and cards in one call. No auth required.

**Request:**
```json
{
  "projectId": "80l6k2s1r",
  "label": "My stack label",
  "cards": [
    "First card text",
    "Second card text",
    { "content": "Third card", "imageUrl": "https://example.com/img.png", "meta": { "source": "openclaw" } }
  ]
}
```

- `projectId` — optional. If omitted, uses first existing project or creates one.
- `label` — optional. Stack label.
- `cards` — required, non-empty array. Each item is either a string (content) or `{ content, imageUrl?, meta? }`.

**Response (201):**
```json
{
  "stack": {
    "id": "xyz789",
    "projectId": "80l6k2s1r",
    "label": "My stack label",
    "createdAt": "..."
  },
  "cards": [
    { "id": "c1", "content": "First card text" },
    { "id": "c2", "content": "Second card text" }
  ]
}
```

**Review URL:** `{baseUrl}/review/{projectId}/{stackId}` or `{baseUrl}/review/{stackId}`

---

## Add cards to existing stack

### POST /api/stacks/:stackId/cards

Add one or more cards to a stack.

**Auth:** Requires session cookie (creator access).

**Single card:**
```json
{
  "content": "Card content",
  "imageUrl": "https://example.com/image.jpg",
  "meta": { "source": "manual" }
}
```

**Batch:**
```json
{
  "cards": [
    "Plain text card",
    { "content": "Card with image", "imageUrl": "https://..." }
  ]
}
```

**Response (201):** Single card returns the card object; batch returns `{ cards: [{ id, content }, ...] }`.

---

## Projects and stacks (overview)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/projects | List projects with stacks (query: creatorId, q, limit, offset, section, projectId) |
| GET | /api/projects/:id/stacks | Stacks for a project |
| POST | /api/projects | Create project |
| POST | /api/stacks | Create stack (body: projectId, label?, callbackUrl?) |
| GET | /api/stacks | List stacks (query: projectId) |
| PATCH | /api/stacks/:id | Update stack label/callbackUrl |
| DELETE | /api/stacks/:id | Delete stack |

---

## Scores and review flow

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/scores | Submit reviewer decisions (stackId, reviewerId, reviewerName, sessionId, decisions) |
| GET | /api/scores/:stackId/:sessionId | Get scores for a session |
| GET | /api/stacks/:id/scores | Get scores for a stack |
| GET | /api/stacks/:id/scores-by-reviewer | Scores grouped by reviewer |

---

## Review URL format

- `{baseUrl}/review/{projectId}/{stackId}`
- `{baseUrl}/review/{stackId}` (legacy, when projectId not needed)

Example: `https://uhmm.link/review/80l6k2s1r/m69qlkyf3`
