# sapiom2api

An OpenAI-compatible reverse proxy for [Sapiom](https://sapiom.ai)'s OpenRouter service (`https://openrouter.services.sapiom.ai`). Manages a pool of `sk_live_*` API keys, rotates them automatically, validates their health, and provides a password-protected web UI for key management.

## Features

- **OpenAI-compatible API** — drop-in replacement for any OpenAI SDK or tool
- **Key rotation** — round-robin across all active keys per request
- **Streaming support** — SSE keep-alive pings every 20s to survive proxy timeouts
- **Key validation** — test each key against Sapiom API; detect valid / invalid / no-balance states
- **Auto-ban** — batch validate all keys and automatically disable invalid ones
- **One-click purge** — delete all keys marked invalid from the database
- **Web UI** — password-protected key manager with import, search, and status display

## Architecture

```
Client (OpenAI SDK / newapi / etc.)
        │  POST /v1/chat/completions
        ▼
  API Server (:8080)
  ├── /v1/*  →  proxy to openrouter.services.sapiom.ai
  │             (key rotation + x402 payment handling)
  └── /api/* →  key management REST API

  Key Manager UI (/)
  └── password-gated dashboard → calls /api/*
```

## Quick Start

### Requirements

- Node.js 20+
- pnpm
- PostgreSQL (or Replit's built-in DB)

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret for session signing |
| `VITE_APP_PASSWORD` | Password for the Key Manager web UI |
| `GITHUB_TOKEN` | (optional) GitHub PAT for pushing code |

### Install & Run

```bash
pnpm install
pnpm --filter @workspace/db run push     # apply DB schema
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/key-manager run dev
```

## API Usage

The proxy exposes OpenAI-compatible endpoints. Point any OpenAI client to your deployment URL:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-deployment.replit.app/v1",
    api_key="any-value",   # not validated by the proxy
)

response = client.chat.completions.create(
    model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### Supported Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions (streaming supported) |
| `GET`  | `/v1/models` | List available models |
| `POST` | `/v1/embeddings` | Text embeddings |
| `POST` | `/v1/images/generations` | Image generation |

All other `/v1/*` paths are forwarded transparently.

## Key Management UI

Access the dashboard at `/` and enter the password (`VITE_APP_PASSWORD`).

### Importing Keys

Click **Import** and paste keys one per line (plain text) or as JSON:

```
<your-sapiom-api-key-1>
<your-sapiom-api-key-2>
```

### Key Validation

Each key can be tested against `api.sapiom.ai`:

| Status | Meaning |
|--------|---------|
| ✅ Valid | Key authenticated and has balance |
| ⚠️ No Balance | Key authenticated but insufficient balance |
| ❌ Invalid | Key rejected (403) — likely expired or wrong key |
| 🔘 Unreachable | Could not reach Sapiom API |

**Validate All** — checks every active key in batches of 5, persists results to DB.  
**Auto-ban** — invalid keys are automatically set to inactive during batch validation.  
**Clear Invalid** — permanently deletes all keys with `invalid` status.

## Key Management API

All endpoints are under `/api/keys`.

```
GET    /api/keys                    List all keys
POST   /api/keys                    Create a key
POST   /api/keys/import             Bulk import keys
POST   /api/keys/validate-all       Batch validate (auto-ban optional)
DELETE /api/keys/purge-invalid      Delete all invalid keys
GET    /api/keys/:id                Get a key
PATCH  /api/keys/:id                Update a key
DELETE /api/keys/:id                Delete a key
POST   /api/keys/:id/validate       Validate a single key
GET    /api/keys/stats              Get stats (total, active, valid, invalid)
```

### Validate All Options

```json
POST /api/keys/validate-all
{
  "autoBan": true,       // disable invalid keys automatically
  "onlyActive": true,    // skip already-disabled keys
  "concurrency": 5       // parallel checks (1-20)
}
```

## Project Structure

```
.
├── artifacts/
│   ├── api-server/          # Express API + proxy
│   │   └── src/
│   │       ├── routes/
│   │       │   ├── proxy.ts     # OpenAI-compatible proxy with key rotation
│   │       │   └── keys.ts      # Key CRUD + validation
│   │       └── app.ts
│   └── key-manager/         # React + Vite web UI
│       └── src/
│           ├── pages/Dashboard.tsx
│           └── components/
│               ├── KeysTable.tsx
│               └── StatsCards.tsx
└── lib/
    └── db/                  # Drizzle ORM + PostgreSQL schema
        └── src/schema/api-keys.ts
```

## Deployment

### Deploy on Deno Deploy

[![Deploy on Deno](https://deno.com/button)](https://console.deno.com/new?clone=https://github.com/sayrui/split2api)

The project is fully adapted for Deno Deploy. It uses:

- **[Hono](https://hono.dev)** — lightweight web framework that runs natively on Deno
- **[drizzle-orm + postgres.js](https://orm.drizzle.team)** — Deno-compatible ORM  
- **GitHub Actions** — builds the React frontend before each deploy

#### Setup Steps

1. **Create a Deno Deploy project** at [dash.deno.com](https://dash.deno.com) → New Project → select your GitHub repo (`sayrui/split2api`)

2. **Choose "GitHub Actions" mode** (required — the project needs a build step for the frontend)

3. **Set the following Secrets** in your GitHub repo (`Settings → Secrets and variables → Actions`):

   | Secret | Description |
   |--------|-------------|
   | `DATABASE_URL` | PostgreSQL connection string (e.g. [Neon](https://neon.tech) or [Supabase](https://supabase.com)) |
   | `VITE_APP_PASSWORD` | Password for the Key Manager web UI |
   | `DENO_DEPLOY_TOKEN` | Token from Deno Deploy project settings |

4. **Push to `main`** — GitHub Actions will automatically build the frontend and deploy

#### Run the DB migration

After the first deploy, run `drizzle-kit push` against your PostgreSQL instance to create the schema:

```bash
DATABASE_URL=your-db-url npx drizzle-kit push --config lib/db/drizzle.config.ts
```

#### How it works

```
GitHub push → GitHub Actions
  1. pnpm install
  2. vite build (key-manager frontend → ./dist/)
  3. deno deploy (main.ts + dist/ → Deno Deploy)
```

The single `main.ts` entry point serves both:
- **`/api/*`** and **`/v1/*`** — API and OpenAI-compatible proxy
- **`/*`** — Pre-built React frontend (SPA with fallback to `index.html`)

### Deploy on Replit (alternative)

The project also runs on Replit with zero additional config. Click **Deploy** in the Replit UI.

## License

MIT
