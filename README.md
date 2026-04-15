# Viba Transport Logistics

Dispatch, GPS-ready scheduling, AI call capture, and owner analytics for
**Viba Transportation** (El Paso TX). Node + Express + SQLite. Deploys to
Render's free tier in under 10 minutes.

---

## What's inside

```
viba-app/
├── server.js              Express backend (auth, REST API, Twilio webhook)
├── src/
│   ├── db.js              SQLite schema + migrations
│   └── seed.js            Demo data seeded on first boot
├── public/
│   ├── login.html         Branded sign-in page
│   └── app.html           Operator console / schedule / owner dashboard
├── render.yaml            One-click Render blueprint
├── Dockerfile             Optional — Render auto-detects Node
├── .env.example           Env vars reference
└── package.json
```

### What the app does

1. **Login** (session cookies, bcrypt hashes). Three roles seeded: operator, owner, driver.
2. **Operator console** — task queue driven by the AI receptionist, with
   single-button state advancement (new → dispatched → at pickup → en route → completed).
3. **Schedule** — day timeline per driver, "AI Optimize Routes" button that
   greedy-assigns unassigned trips, and a permanent **Next Available Slot**
   widget for walk-in / call-in triage.
4. **Owner dashboard** — revenue, utilization, top customers, call volume.
5. **Twilio voice webhook** (`POST /api/webhooks/twilio-voice`) — stub that
   returns TwiML. Point your Twilio number at it and swap the body for your
   conversational AI provider (ElevenLabs, Vapi, Retell, etc.).
6. **Trip-capture webhook** (`POST /api/webhooks/trip-captured`) — secured by
   `X-Webhook-Secret`. Your AI agent posts structured trip data here; the
   server creates the trip + operator task.

---

## Run it locally

```bash
cd viba-app
npm install
cp .env.example .env          # edit if you want
npm start
```

Open http://localhost:10000 and sign in with `operator@viba.test` / `viba2026`.

---

## Deploy to Render (free tier) — click-by-click

> You'll need: a **GitHub account** and a **Render account** (both free).
> I can't push to your GitHub or sign into Render for you, so the steps below
> assume you'll do those two clicks yourself.

### 1. Push this folder to GitHub

```bash
cd viba-app
git init
git add .
git commit -m "Initial Viba Transport Logistics app"
```

Then on GitHub:

1. Go to **https://github.com/new**
2. Repository name: `viba-transport-logistics` (or anything you like)
3. Leave it **Public** (required for Render free tier auto-deploy) or Private
   (works too, just connects differently)
4. Click **Create repository**
5. Back in your terminal, run the exact two commands GitHub shows you in the
   "push an existing repository" box. They'll look like:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/viba-transport-logistics.git
   git branch -M main
   git push -u origin main
   ```

### 2. Create the service on Render

1. Go to **https://dashboard.render.com/select-repo?type=blueprint**
2. Click **Connect account** next to GitHub (if you haven't already). Authorize
   Render to read your repos.
3. Find `viba-transport-logistics` in the list and click **Connect**.
4. Render reads `render.yaml` automatically and shows you the plan:
   > **viba-transport-logistics** — Web Service (Node, Free plan)
5. Click **Apply**.
6. Render starts the first build (2–4 minutes). You'll see it run
   `npm ci --omit=dev` then `npm start`.

### 3. Set the demo password (before sharing)

1. When the service goes green, click into it.
2. Left sidebar → **Environment**.
3. Find `DEFAULT_DEMO_PASSWORD`, click **Add Value**, and set it to
   something only you know (this is the password for the seeded demo accounts).
4. Click **Save Changes**. Render redeploys.

> **Note:** the password only applies on the *first* boot when seed data is
> created. If the DB already has users, changing this env var does nothing.
> To reset, delete the service and redeploy (SQLite lives on ephemeral disk
> on the free plan — see next section).

### 4. Visit your site

Render gives you a URL like:

```
https://viba-transport-logistics.onrender.com
```

It's on the free tier so:

- **Cold start:** first request after 15 min of idle takes ~30 s to wake.
- **Ephemeral disk:** SQLite data resets on every redeploy. Great for demos.
  When you're ready for production data, uncomment the `disk:` block in
  `render.yaml` (requires Starter plan, $7/mo).

---

## Going beyond the demo

### Point Twilio at the voice webhook

1. Buy a number at https://console.twilio.com/
2. In **Phone Numbers → Your Number → Voice Configuration**:
   - **A call comes in:** Webhook
   - URL: `https://YOUR-RENDER-URL.onrender.com/api/webhooks/twilio-voice`
   - Method: `HTTP POST`
3. Save. Every inbound call is logged to the `calls` table.

### Wire a conversational AI to capture trips

The `POST /api/webhooks/trip-captured` endpoint accepts:

```json
{
  "customer_name": "Mrs. Alvarez",
  "customer_phone": "+19155550149",
  "pickup": "4200 Mesa St, El Paso TX",
  "dropoff": "Las Palmas Medical",
  "start_time": "2026-04-16T09:50:00",
  "duration_min": 60,
  "notes": "Wheelchair-accessible van"
}
```

with header `X-Webhook-Secret: <your WEBHOOK_SECRET env var value>`.

Your AI provider (Vapi / Retell / Synthflow / custom) should call this
after it's finished gathering trip details from the caller. The server creates
the trip + a task on the operator queue.

### Switch SQLite → Postgres for production

`better-sqlite3` is fine up to ~20 operators. When you're ready for scale:

1. Add a Postgres database in Render (free tier available for 30 days).
2. Replace `better-sqlite3` with `pg` in `package.json`.
3. Rewrite `src/db.js` to use `pg.Pool` — the SQL is standard enough to
   translate directly.
4. Point `DATABASE_URL` in env and redeploy.

---

## API quick reference

All `/api/*` endpoints require an authenticated session except the webhooks.

| Method | Path                          | Purpose                                   |
|--------|-------------------------------|-------------------------------------------|
| POST   | /api/auth/login               | email + password → session cookie         |
| POST   | /api/auth/logout              | clear session                             |
| GET    | /api/auth/me                  | current user                              |
| GET    | /api/drivers                  | list drivers                              |
| POST   | /api/drivers                  | create driver (owner/operator)            |
| PATCH  | /api/drivers/:id              | update availability / fields              |
| GET    | /api/trips?date=YYYY-MM-DD    | list trips (filter by day)                |
| POST   | /api/trips                    | create trip                               |
| PATCH  | /api/trips/:id/state          | advance trip state                        |
| PATCH  | /api/trips/:id/assign         | assign driver                             |
| GET    | /api/schedule?date=...        | day schedule + drivers                    |
| POST   | /api/schedule/optimize        | **AI** route optimizer (greedy)           |
| GET    | /api/schedule/next-available  | next free slot (for walk-ins)             |
| GET    | /api/tasks                    | operator task queue                       |
| PATCH  | /api/tasks/:id/advance        | operator advances a task                  |
| GET    | /api/calls                    | recent calls                              |
| POST   | /api/webhooks/twilio-voice    | **public** — Twilio inbound voice         |
| POST   | /api/webhooks/trip-captured   | **public + secret** — AI agent captures   |
| GET    | /api/activity                 | audit log                                 |
| GET    | /healthz                      | health probe                              |

---

## Security notes

- Passwords hashed with **bcrypt** (10 rounds).
- Sessions stored server-side in SQLite, cookie is httpOnly + SameSite=lax +
  secure in prod.
- Helmet is on (CSP is relaxed for the inline demo UI — tighten it before
  production).
- `DEFAULT_DEMO_PASSWORD` is only used once, on first-ever seed.
- `WEBHOOK_SECRET` gates the AI trip-capture endpoint.
- `SESSION_SECRET` is auto-generated by Render on first deploy.

Before production: rotate all secrets, disable demo seed accounts, and put
Render's paid plan + Postgres in place.
