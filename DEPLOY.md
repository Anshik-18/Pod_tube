# Deploying PodNow on Coolify

One app container (Next.js + Socket.IO + the FFmpeg processing worker) and one Postgres on the same
server. Cloudflare R2 stores media; Cloudflare Calls TURN relays calls for guests behind strict firewalls.

> **Run exactly one instance.** Live studio rooms are held in the app's memory, so every participant
> of a studio must reach the same container. Don't scale the app to multiple replicas.

## 1. Postgres

Coolify → your project → **+ New → Database → PostgreSQL 16** (same server as the app).
After it starts, copy its **internal** connection URL (`postgres://user:pass@<service-name>:5432/postgres`).

No SSL is needed on Coolify's private network — use the URL without `?sslmode`. (For a hosted
database such as Neon, append `?sslmode=require`.) The app creates all tables on first start.

## 2. Application

Coolify → **+ New → Application → GitHub** → `Anshik-18/Pod_tube`, branch `main`.

| Setting | Value |
|---|---|
| Build pack | **Dockerfile** (not Nixpacks — the Dockerfile is the tested build, with FFmpeg + x264) |
| Port | `3000` |
| Domain | `https://podnow.bytesbyblinken.com` (HTTPS is required: browsers only allow camera access on HTTPS) |
| Health check | Path `/api/health` (the image also declares a Docker HEALTHCHECK) |
| Replicas | 1 |

Coolify's proxy forwards WebSockets by default; nothing to configure for Socket.IO.

**Disk:** processing needs scratch space of about 2–3× a recording's size (a 1-hour, 3-person
1080p session ≈ 8 GB of chunks). It goes to `/app/.processing` inside the container. If the server's
disk is small, add a **Persistent Storage** volume mounted at `/app/.processing`.

## 3. Environment variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | Internal Postgres URL from step 1 |
| `JWT_SECRET` | 64 random hex chars: `openssl rand -hex 32` (new one for production) |
| `NEXT_PUBLIC_APP_URL` | `https://podnow.bytesbyblinken.com` |
| `STORAGE_TYPE` | `r2` |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token with read/write on the bucket |
| `R2_BUCKET_NAME` | Your bucket |
| `CLOUDFLARE_TURN_KEY_ID` | Cloudflare dashboard → **Calls → TURN Server → Create** → Turn Token ID |
| `CLOUDFLARE_TURN_KEY_API_TOKEN` | The API token shown with it (only shown once) |
| `CRON_SECRET` | `openssl rand -hex 16` — protects `/api/cleanup` |

Optional: `EPISODE_RETENTION_DAYS` (cleanup), `DB_POOL_SIZE`, `PROCESSING_WORK_DIR`.

Without R2 you can keep media on the server's own disk: `STORAGE_TYPE=local`, `ALLOW_LOCAL_STORAGE=true`,
and a **Persistent Storage** volume mounted at `/app/uploads` (otherwise recordings vanish on redeploy).
The app refuses to start with local storage unless you opt in this way.

## 4. R2 CORS (required for uploads)

Browsers upload recording chunks straight to R2, so the bucket must allow your domain.
Cloudflare → R2 → bucket → **Settings → CORS policy**:

```json
[
  {
    "AllowedOrigins": ["https://podnow.bytesbyblinken.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

## 5. Scheduled cleanup (optional)

Coolify → the app → **Scheduled Tasks**, daily:

```bash
wget -qO- --header="Authorization: Bearer $CRON_SECRET" --post-data='{}' http://127.0.0.1:3000/api/cleanup
```

## 6. Deploy and verify

1. Deploy. The log should show `[Migrate] Schema up to date` and `> Ready on http://0.0.0.0:3000`.
2. `https://podnow.bytesbyblinken.com/api/health` → `{"status":"ok","db":"ok"}`.
3. Sign up, create a studio, join from a second device **on a different network** (e.g. a phone on
   mobile data — that exercises TURN), record ~1 minute, stop, and check the project processes.
4. Optional: `/api/health/ffmpeg` shows the FFmpeg build in the container.

Redeploys are safe: the container receives SIGTERM, stops the processing worker cleanly and closes
the database pool. An interrupted processing job is requeued automatically.

## Not configured yet

- **Password-reset email.** "Forgot password" currently only logs the reset link on the server
  (`app/api/auth/forgot-password/route.ts`). Connect an email provider (e.g. Resend) before relying on it.
