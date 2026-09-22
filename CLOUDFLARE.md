# Cloudflare D1 backend for DayFlow

The web app stays a static `index.html` client. **Remote sync** stores the entire `state` object as JSON in **D1** via a tiny **Cloudflare Worker**. One store is meant for **you on multiple devices** (same Worker URL + same Store ID everywhere). localStorage is only an offline cache.

## Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) logged in (`wrangler login`).

## 1. Create the D1 database

From the `cloudflare/` folder:

```bash
cd cloudflare
npm install
wrangler d1 create dayflow
```

Copy the printed `database_id` into `wrangler.toml` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`).

## 2. Apply migrations

```bash
npx wrangler d1 migrations apply dayflow --local   # optional: local dev DB
npx wrangler d1 migrations apply dayflow           # remote
```

## 3. Deploy the Worker

```bash
npm run deploy
```

Note your Worker URL, e.g. `https://dayflow-d1-api.<subdomain>.workers.dev`.

## 4. Provision a store (opaque ID)

Do this **once**. Reuse the same ID on phone, laptop, etc.

```bash
curl -X POST https://YOUR_WORKER.workers.dev/api/v1/stores
```

Or in DayFlow: **Settings → Cloudflare D1 → New store… → Copy ID**.

Treat `id` as a **secret**: anyone who knows it can read/write that store.

## 5. Enable sync on each device

**Settings → Cloudflare D1**:

- **Worker API URL** (no trailing slash)
- **Store ID** (identical on every device)
- Tap **Save** — the page reloads

Behavior:

1. Opening or returning to the app loads D1 if this device has no unsaved edits.
2. Edits save locally immediately and push to D1 (debounced; flushed when you leave the tab).
3. If two devices save at once, the Worker rejects the stale write with an **atomic** `UPDATE … WHERE updated_at = ?` (409). The app **merges** both copies, then retries.
4. If D1 is empty, this device uploads its local data (first seed).
5. Offline: localStorage cache; retry after ~8s, on reconnect, on poll (~40s), and when the tab is shown again.

`updated_at` is milliseconds since epoch (CAS token, not a display clock).

## Security note

Store ID is the bearer secret. Fine for a personal app. For anything shared, add Cloudflare Access or tokens.

## Local Worker dev

```bash
npm run dev
```

Point **Worker API URL** at `http://127.0.0.1:8787` (or the URL Wrangler prints).
