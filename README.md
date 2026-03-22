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

## Exposing your local backend (ngrok)

To use the mobile app or receive webhooks while running locally, expose your backend with ngrok.

### One-time setup

1. Create an account at [ngrok.com](https://ngrok.com)
2. Install ngrok: `brew install ngrok` (or [download](https://ngrok.com/download) from ngrok.com)
3. Add your auth token: `ngrok config add-authtoken <your-token>` (get the token from your [ngrok dashboard](https://dashboard.ngrok.com))

### Each session

1. Start the backend: `uhmm start`
2. In another terminal, run: `ngrok http 3000`
3. Copy the HTTPS URL ngrok shows (e.g. `https://abc123.ngrok-free.app`)
4. Add that URL in the mobile app settings (API URL / base URL)

On the free tier, the ngrok URL changes each time. With a paid plan you can reserve a stable subdomain.

## Repos

- **uhmm-link-mobile** — Expo app (iOS, Android)
- **uhmm-link-cli** — Dev tools (seed, send-deck, load-folder, etc.)
