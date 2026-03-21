# uhmm.link backend

Express API + web UI for uhmm.link. Stores projects, stacks, cards, and scores. Serves the creator dashboard, review flow, and scores pages.

**Full spec:** [docs/TECHNICAL-OUTLINE.md](docs/TECHNICAL-OUTLINE.md)

## Quick start

```bash
npm install
npm run dev    # http://localhost:3000
```

## Storage

- **Default (JSON):** No setup. Data in `data/uhmm.json`. Set `DATA_DIR` to override.
- **PostgreSQL:** Set `DATABASE_URL` in `.env` for production.

## Reset to demo

With JSON storage (no `DATABASE_URL`):

```bash
curl -X POST http://localhost:3000/api/admin/reset-demo
```

Or use the CLI: `uhmm reset-demo` (from uhmm-link-cli).

## Repos

- **uhmm-link-mobile** — Expo app (iOS, Android)
- **uhmm-link-cli** — Dev tools (seed, send-deck, load-folder, etc.)
