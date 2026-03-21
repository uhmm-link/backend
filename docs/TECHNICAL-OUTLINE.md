# uhmm.link — Technical Project Outline (v4)

## Overview

uhmm.link is a human-in-the-loop app for binary judgment (approved/rejected) on content. Creators build stacks and share links; reviewers swipe through cards. **Reviewers never need an account.** Creators can optionally sign in to store projects, stacks, history, and manage assignments.

**Platforms:**
- **iOS app** — Creator + reviewer flows
- **Web app** — Creator + reviewer flows (browser)

**Repo layout:**
- `uhmm-link-mobile` — Expo React Native
- `uhmm-link-backend` — Node.js + Express (relay backend)
- `uhmm-link-cli` — Dev tools (seed, send-deck, load-folder, etc.)

---

## Core Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CREATOR (Mobile App or Web)                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  • OAuth: Apple / Google / Email (optional, for account features)           │
│  • Add cards via:                                                           │
│    (a) Text entries → stored on uhmm.link server                             │
│    (b) Cloud folder → OAuth to Dropbox/Drive → list via API → store URLs    │
│  • Click "Generate link" → uhmm.link/review/{stackId} + QR code             │
│  • Optional password on link; optional expiry                               │
│  • Share link externally (WhatsApp, Slack, etc.)                            │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  uhmm.link RELAY (Node.js + Express + PostgreSQL)                           │
│  • Stores: text cards (content), image cards (public URLs only)             │
│  • Never stores actual image files                                          │
│  • POST /stacks → returns stackId                                           │
│  • GET /stacks/:stackId → cards (text + image URLs)                         │
│  • POST /scores → reviewer submits (stackId + reviewer name + decisions)    │
│  • Returns uhmm.link/scores/{stackId}/{sessionId}                           │
│  • Auto-delete stacks + scores after X days (7, 30, configurable)           │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  REVIEWER (Mobile App or Web)                                               │
│  • Opens uhmm.link/review/{stackId} (or scans QR)                           │
│  • No account required                                                      │
│  • Enters name before starting (scores attributed to them)                  │
│  • Fetches stack → loads cards (text + images from cloud URLs)              │
│  • Swipes → local cache first → "Done" → upload to relay                    │
│  • Gets scores URL → shares with creator                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. UI Structure

### Two main tabs (both creators and reviewers)

| Tab | Purpose |
|-----|---------|
| **Projects / Stacks** | List projects, stacks, cards. Filtered by role. |
| **Scores** | View swipe results. Creators see all assignees; reviewers see only their own. |

### Permissions

| User | Projects/Stacks view | Scores view |
|------|----------------------|-------------|
| **Creator** | Own created stacks; can amend, delete, assign | All scores for stacks they created; can clear (unless in progress) |
| **Reviewer** | Stacks assigned to them | Own scores only |
| **Logged out** | Can create stack, get link; no uhmm.link cloud storage | — |

### Actions (long-press)

- **Remove** — For stacks you didn't create; removes from your view only
- **Delete** — For stacks you created; deletes for everyone
- **Clear** — Reset scores (creator only; disabled if any reviewer has "in progress")

### Status (Scores view)

| Status | Color | Meaning |
|--------|-------|---------|
| **In progress** | Orange | Reviewer has started but not finished |
| **Completed** | Green | All cards reviewed |

*(No "pending" — creator shares link externally; server can't know if it's been shared.)*

---

## 2. Creator Flow

### Adding cards

| Method | Storage | Notes |
|--------|---------|------|
| **Text entries** | uhmm.link server | Actual text stored in DB |
| **Cloud folder** | OAuth → API list → store URLs | Creator connects Dropbox/Drive via OAuth; app lists folder via provider API; stores public URLs only. No image files on uhmm.link. |

### Generate link

- Creator clicks "Generate link"
- Optional: set password, set expiry (e.g. 7 days)
- Relay returns `stackId`
- Creator gets: `https://uhmm.link/review/{stackId}` + QR code
- Creator shares link externally (no email from uhmm.link)

### Assignment (future)

- For now: creator shares unique URL
- Later: assign to users in account history (show URL for now)

---

## 3. Reviewer Flow

1. Opens `https://uhmm.link/review/{stackId}` (or scans QR)
2. If password set: enters password
3. Enters **name** before starting (display name) and gets reviewer identity (`reviewerId`) + session identity (`sessionId`)
4. App fetches stack from relay → array of cards (text + image URLs)
5. Images load directly from Dropbox/Drive using stored URLs
6. Swipes through cards (approved / rejected)
7. Clicks **Done** → scores uploaded to relay
8. Relay returns `https://uhmm.link/scores/{stackId}/{sessionId}`
9. Reviewer shares that URL with creator

### Offline

- Cards cached locally (IndexedDB on web, SQLite on mobile)
- Scores stored locally until online
- Sync when connection restored

---

## 4. Creator (Scores view)

- Opens `https://uhmm.link/scores/{stackId}/{sessionId}` (or lists all sessions for a stack)
- Sees which cards approved/rejected per reviewer
- Lists reviewers with status: **In progress** (orange), **Completed** (green)
- Can **Clear** scores (disabled if any reviewer in progress)

---

## 5. Auth & Accounts

| Feature | Logged in | Logged out |
|---------|-----------|------------|
| Create stack (text) | ✓ | ✓ |
| Create stack (cloud folder) | ✓ | ✓ |
| uhmm.link cloud storage (inline images, etc.) | ✓ | ✗ |
| Projects, stacks, history | ✓ | ✗ |
| Assign to users | ✓ | ✗ |
| Review | ✓ | ✓ (scores stored by name) |

**Auth providers:** OAuth (Apple, Google) + email

---

## 5b. Creator / Reviewer Login Scenarios

Storage and visibility differ based on whether the creator and reviewer are logged in.

| Scenario | Creator | Reviewer | Projects/Stacks/Cards | Scores |
|----------|---------|----------|------------------------|--------|
| **1** | Logged in | Logged in | Stored in both accounts on uhmm.link server | Stored in both accounts |
| **2** | Logged in | Not logged in | Stored in creator's account only | Sent to uhmm.link server, identified by stackId + reviewer name + sessionId. Not in reviewer's account |
| **3** | Not logged in | Logged in | Not in creator's account. Stacks assigned to reviewer are listed in reviewer's account. Consider making viewable via URL (stored elsewhere) | Viewable via URL. Listed in reviewer's account |
| **4** | Not logged in | Not logged in | Not stored in either account | Viewable via URL only. Not in either account |

### Details

- **Scenario 1:** When either user is logged in, projects/stacks/cards and scores are stored in their account on the uhmm.link server.
- **Scenario 2:** Projects/stacks/cards and scores live in the creator's account. Nothing in the reviewer's account; scores are sent to uhmm.link identified by stackId, reviewer name, and sessionId.
- **Scenario 3:** Nothing in the creator's account. Stacks assigned to the reviewer appear in the reviewer's account. Scores are viewable via URL; consider making project/stacks/cards viewable via URL too since they are stored elsewhere.
- **Scenario 4:** Nothing in either account. Scores remain viewable via URL only.

---

## 6. Link Security

| Option | Purpose |
|--------|---------|
| **Password** | Optional. Creator sets when generating link; reviewer enters to open. Protects uhmm.link review page. |
| **Expiry** | Optional. After expiry: "Link expired" message; creator must regenerate. |

*Note: Cloud provider (Drive/Dropbox) "anyone with link" does not require viewer login. Password is for the uhmm.link link only.*

### Short URLs (future)

- Create short URLs (e.g. `https://uhmm.link/ZH4j3k`) that redirect to the full review link.
- Improves shareability (QR codes, messaging, typing).

---

## 7. Relay Backend

### What uhmm.link stores

| Card type | Stored | Not stored |
|-----------|--------|------------|
| Text | Full text | — |
| Image | Public URL (e.g. `https://dl.dropbox.com/s/abc/image.jpg`) | Actual image file |

### Data retention

- Auto-delete stacks + scores after X days (7, 30, configurable)

### Endpoints (summary)

| Method | Path | Description |
|--------|------|-------------|
| POST | /stacks | Create stack (text cards + image URLs) → stackId |
| GET | /stacks/:stackId | Get cards (text + URLs); optional password check |
| POST | /scores | Submit scores (stackId, reviewerId, reviewer name, sessionId, decisions) |
| GET | /scores/:stackId/:sessionId | Get scores for a session |

### Storage / Persistence

- **Default (JSON):** No `DATABASE_URL` → file-based storage in `data/uhmm.json`. Zero setup. Works for local dev and simple deploys.
- **Optional (PostgreSQL):** Set `DATABASE_URL` in `.env` → use PostgreSQL. Requires Postgres running (local or cloud).
- **Opt-in rule:** Storage choice is driven by `DATABASE_URL` only. Postgres installed but no `DATABASE_URL` = still uses JSON.
- **Credentials:** Add `DATABASE_URL=postgresql://user:password@host:port/db` to `.env` (gitignored).

---

## 8. Cloud Integration (OAuth)

- **Dropbox** — OAuth, list folder via API, store file URLs
- **Google Drive** — OAuth, list folder via API, store file URLs
- **Future:** Synology, S3-compatible

*Public folder URL paste (no OAuth) is unreliable for most clouds — Drive/Dropbox require API to list folder contents. OAuth + API is the supported path.*

---

## 9. Tech Stack

| Layer | Technology |
|-------|------------|
| Mobile | React Native + Expo |
| Web | React + Vite |
| Relay API | Node.js + Express |
| Relay DB | PostgreSQL |
| Deploy | Render (or similar) |

---

## 10. Deployment & Business Model

| Deployment | Model |
|-----------|-------|
| **Local / self-hosted** | Free, donation-based |
| **Cloud (uhmm.link)** | Freemium |

---

## 11. Implementation Phases

### Phase 1: MVP
- Inline text cards only
- Web reviewer at uhmm.link/review
- Basic score submission
- Reviewer name + sessionId

### Phase 1.5: Storage abstraction + docs
- Implement JSON/PostgreSQL backend switch; update README with storage setup (JSON default, optional Postgres via `DATABASE_URL`).

### Phase 2: Cloud + accounts
- OAuth (Dropbox first, then Drive)
- Creator accounts (Apple/Google/email)
- Projects/stacks/scores views with permissions

### Phase 3: Polish
- Optional password + expiry on links
- QR code on link generation
- Short URLs (e.g. uhmm.link/ZH4j3k → redirect to review link)
- Auto-delete jobs
- Mobile parity
