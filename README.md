# browser-renderer

Tiny puppeteer-backed HTTP service for rendering JavaScript pages to HTML. Designed for crawler / scraper use cases (Sitepulse broken-links checks, etc.).

## Endpoints

### `POST /content`

Renders a URL and returns the post-JS HTML.

```bash
curl -X POST http://localhost:3000/content \
  -H "Authorization: Bearer $RENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

Response:

```json
{ "content": "<html>...</html>" }
```

Body params:

| Field       | Default         | Description                                                       |
|-------------|-----------------|-------------------------------------------------------------------|
| `url`       | (required)      | URL to render                                                     |
| `waitUntil` | `networkidle2`  | Puppeteer goto wait condition                                     |
| `timeout`   | `30000`         | Navigation timeout (ms), capped at 60000                          |
| `userAgent` | (none)          | Override the User-Agent header                                    |

### `GET /healthz`

Returns 200 when browser is alive, 503 otherwise. Includes `active`, `renders`, `uptimeMs`.

## Performance defaults

- Single shared Chrome instance, fresh page per request
- Browser leases prevent Chrome recycling while a request is opening or using a page
- Auto-recycle Chrome after `BROWSER_MAX_RENDERS` (default 1000) or `BROWSER_MAX_AGE_MS` (default 1 hour) — prevents memory leaks
- Aborts image / media / font / stylesheet requests by default — link extraction doesn't need them, ~3–5× faster
- `MAX_CONCURRENT` semaphore returns 503 instead of OOMing when overloaded
- Graceful SIGTERM: drains in-flight requests up to 30s before closing browser

## Environment variables

See `.env.example`. Copy to `.env` before booting.

| Var                     | Default     | Description                                                |
|-------------------------|-------------|------------------------------------------------------------|
| `RENDER_TOKEN`          | (unset)     | Bearer token. If unset, endpoint is open. **Always set in prod.** |
| `MAX_CONCURRENT`        | `40`        | Hard cap on parallel renders                               |
| `NAV_TIMEOUT_MS`        | `30000`     | Default goto timeout                                       |
| `BROWSER_MAX_RENDERS`   | `1000`      | Recycle Chrome after N renders                             |
| `BROWSER_MAX_AGE_MS`    | `3600000`   | Recycle Chrome after N ms uptime                           |

## Local dev

```bash
docker compose up --build
curl http://localhost:3000/healthz
```

## Deploy via Ploi (Docker server)

1. Push this repo to GitHub.
2. In Ploi, create the site on your Docker server pointing at this repo.
3. Set environment variables in Ploi's UI (or paste an `.env`):
   - `RENDER_TOKEN=<long random>`
   - `MAX_CONCURRENT=40` (tune per box size — see sizing below)
4. Enable auto-deploy on push.
5. Ploi runs `docker compose up -d --build` on each deploy.

### Locking down access

Render service must NOT be public. Two options:

**Option A — Hetzner private network (recommended):**
- Attach Sitepulse app server + render server to the same Hetzner private network
- In Ploi → Server → Firewall: allow port `3000` only from the app server's private IP
- Sitepulse calls `http://<render-private-ip>:3000`

**Option B — Cloudflare Tunnel:**
- Install `cloudflared` on the render box, route `render.yourdomain.com` → `localhost:3000`
- Block port 3000 in Ploi firewall entirely
- Add Cloudflare Access policy on the hostname for double auth

Either way: `RENDER_TOKEN` is **mandatory** as second factor.

## Box sizing (Hetzner reference)

| Plan    | vCPU / RAM   | Approx concurrent renders | Cost/mo |
|---------|--------------|---------------------------|---------|
| CPX31   | 4 shared / 8GB  | ~15                    | €15     |
| CCX23   | 8 dedicated / 32GB | ~50                 | €29     |
| CCX33   | 16 dedicated / 64GB | ~120                | €57     |

Shared CPU plans (CX, CPX) work for low volume but throttle under sustained load. **Dedicated (CCX) recommended for production.**

Set `MAX_CONCURRENT` to ~80% of theoretical headroom. Leave room for spikes.

## Load testing

```bash
RENDER_URL=http://localhost:3000 \
RENDER_TOKEN=your-token \
TARGET_URL=https://example.com \
DURATION=30 \
CONCURRENCY=20 \
npm run loadtest
```

Watch:
- `non2xx` — should be near zero (503s = you exceeded `MAX_CONCURRENT`)
- p99 latency — should be under your `NAV_TIMEOUT_MS`
- `docker stats` in another terminal — memory/CPU under load

## AWS speed profile

The Lambda deployment is tuned for the kind of AWS credits where speed matters more
than squeezing every cent:

- `FunctionMemorySize=4096` by default. Lambda allocates CPU with memory, so Chromium
  usually navigates and serializes faster at 4 GB than at 2 GB.
- `ProvisionedConcurrentExecutions=0` by default. At low volume this avoids a
  steady monthly warm-capacity charge; set it to `1` only if first-render latency
  matters.
- `EphemeralStorage=2048` gives Chromium more scratch space without changing the
  code path.
- `BROWSER_MAX_RENDERS=250` and `BROWSER_MAX_AGE_MS=3600000` keep warm browsers
  useful for longer while still recycling them before leaks accumulate.

Deploy a faster baseline:

```bash
sam deploy \
  --parameter-overrides \
    RenderToken="$RENDER_TOKEN" \
    FunctionMemorySize=4096 \
    ProvisionedConcurrentExecutions=0 \
    BrowserMaxRenders=250 \
    BrowserMaxAgeMs=3600000
```

For user-facing checks where cold starts are painful, try
`ProvisionedConcurrentExecutions=1`. For bursty checks, try `2` or `3`. If
p95/p99 latency is still high, test `FunctionMemorySize=6144` before adding more
warm concurrency. Provisioned concurrency is the one setting here that creates a
steady hourly cost, so keep it at `0` for low-volume background rendering.

Quick comparison loop against the Lambda Function URL:

```bash
for c in 1 2 5 10; do
  RENDER_URL="$BROWSER_RENDERER_URL" \
  RENDER_TOKEN="$RENDER_TOKEN" \
  TARGET_URL=https://example.com \
  CONCURRENCY="$c" \
  DURATION=45 \
  npm run loadtest
done
```

Use the same target URL when comparing memory sizes. Watch CloudWatch `Duration`,
`InitDuration`, `Throttles`, `ConcurrentExecutions`, and `ProvisionedConcurrencyUtilization`.
The sweet spot is the smallest memory size where p95 stops materially improving
and warm concurrency utilization stays below about 70%.

## Scaling out

When one box runs out of headroom:
1. **Vertical first** — bump CCX23 → CCX33 (€29 → €57 doubles capacity)
2. **Horizontal** — second box, simple round-robin via Caddy / HAProxy on the app side
3. **Geo-split** — render box per region, route by site TLD or check region
