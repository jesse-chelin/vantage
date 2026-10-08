# Vantage

A local console for total management of a Mac, apps, storage, services,
network, security, monitoring, notifications, and AI, in a Linear-style web UI.

Everything is local, loopback-only, and guarded by a per-run token. All shell
actions use fixed binaries and validated arguments (no arbitrary command
strings).

## Quick start

```sh
cd ~/Projects/ai-dashboard
npm start            # → http://127.0.0.1:8790
```

It runs at login via the launchd agent `local.ai-dashboard`.

```sh
launchctl kickstart -k gui/$(id -u)/local.ai-dashboard   # restart
launchctl bootout gui/$(id -u)/local.ai-dashboard        # remove
```

Terminal scan: `npm run scan` (or `node bin/scan.js --json`).

## What it covers

| View | Details |
| --- | --- |
| **Overview** | Machine specs, disk, AI footprint breakdown, quick actions |
| **Monitor** | Live CPU / unified memory / swap / disk, trend charts (15m–7d), top processes |
| **Disk** | Reclaimable-space engine + interactive treemap + home/cache/download sizes |
| **Models** | Ollama models, load/unload/delete/benchmark, usage tracking, leaderboard |
| **Image Gen** | ComfyUI queue, gallery with prompt metadata, HuggingFace downloader |
| **Runtimes** | whisper.cpp, llama.cpp, MLX, ggml |
| **Agent Stack** | OpenClaw config: routing, plugins, skills, agents, workflows (secrets redacted) |
| **Activity** | OpenClaw analytics from its SQLite: runs, tool calls, errors, automations, skills, backups |
| **Services** | launchd services, endpoint health probes, log viewer, jump-to-log |
| **Network** | Live throughput + history, interfaces, connections by process, routing/DNS, ping & port diagnostics |
| **Security** | Network exposure, posture, tunnels, secret presence, remediation hints |
| **Alerts** | Notification settings (macOS + Telegram) |
| **Homebrew** | Formulae, casks, outdated packages (upgrade one / all), cleanup |
| **Store** | Search & install/uninstall formulae and casks; curated app catalogue |
| **Applications** | App sizes; click any app for a detail panel with actions |
| **Packages** | Global npm/Python packages + cache pruning |

## Monitoring

A background sampler runs in the server every 15s and persists CPU, unified
memory, swap, disk, Ollama's in-memory footprint, top processes and model-usage
to `data/metrics.db` (SQLite via built-in `node:sqlite`; 14-day retention).

The **Monitor** view charts this with selectable ranges and lets you quit
runaway processes (pid + name are re-validated to avoid reuse).

## Disk & reclaim

The **Disk** view finds recoverable space, orphaned Ollama blobs, incomplete
`.aria2` downloads, Trash, npm/pip/Homebrew caches, stale ComfyUI outputs, with
one-click actions, plus a lazy squarified treemap you can drill into.

> macOS hides protected folders (much of `~/Library`, `~/.Trash`) from
> unprivileged processes. Grant **Full Disk Access** to `/opt/homebrew/bin/node`
> for complete totals.

## Health & logs

**Services** probes each endpoint over HTTP (Ollama, ComfyUI, gateway, miniapp,
dashboard) with latency and status, shows launchd restart counts / last exit
codes, and streams logs with a Follow toggle.

## Security audit

Flags anything bound to non-loopback addresses (e.g. the OpenClaw miniapp on
`*:8788`), reports FileVault / firewall / Gatekeeper / SIP / auto-update
posture, surfaces Tailscale & cloudflared tunnels, and lists which secrets are
present (names only, never values).

## Notifications

Dedicated **Alerts** view: macOS banners and Telegram messages on low disk,
job completion/failure and service outages, with a configurable threshold and
cooldown. The Telegram chat id is auto-detected from OpenClaw; the bot token is
read from the OpenClaw env files.

## Model ops

Load / unload / delete models, **benchmark** a model's tokens/sec (leaderboard),
track last-loaded usage, unload everything to free unified memory, search and
download HuggingFace models into ComfyUI, and quantize GGUF files with
`llama-quantize`.

## Agent ops

Read-only analytics over `openclaw.sqlite`: 24h runs/tool-calls/errors, recent
audit activity, top tools, automations (cron) with next/last run, skill usage,
backups and sessions. (Config writes are intentionally not exposed, edit
`~/.openclaw/openclaw.json` directly and restart the gateway.)

## Interface

- **Motion**: a top progress bar tracks every request, async panels use
  skeleton loaders, views fade/rise in with staggered rows, and buttons,
  switches, segmented controls and the copy button have micro-interactions.
  Everything honours `prefers-reduced-motion`.
- **Inline action states**: every action/refresh/search button shows its own
  state, **busy** (inline spinner), **success** (✓) and **error** (⚠ with the
  message on hover). Job-backed buttons stay busy until the job finishes, then
  flip to success/failure.
- **Side panel**: clicking an Application, a Store item, a Homebrew chip or the
  workspace header opens a right-hand detail panel with actions. Clickable rows
  are everywhere: models, services, ports, disk folders & reclaim items, files,
  network interfaces & connections, security bindings & issues, agent events /
  automations / skills / backups / sessions, npm & Python packages, runtime
  model files, ComfyUI checkpoints & model groups, and trending HF models.
  Panels are nestable, and their actions show inline busy/success/error states.
  Panels are information-rich: models show agent roles and last-used; **Python
  and npm packages** show the installed vs latest version (outdated flag),
  summary, author/license, dependencies, install location and file count
  (looking up PyPI / the npm registry); **checkpoints** read the safetensors
  header for parameters, tensor count, precision and workflow reference;
  **apps** show code-signing authority and quarantine; **files** show type,
  permissions and timestamps. Outdated **Python and npm** packages expose an
  inline **Update** button (`pip install --upgrade` / `npm install -g @latest`),
  run as tracked jobs. The Packages page header lists every outdated pip/npm
  package with per-package **Update** and **Update all**.
- **Profile & preferences**: click the workspace header (top of the sidebar) for
  user/machine info and appearance settings, **accent colour**, **compact
  density** and **reduce motion** (stored in `localStorage`).
- **Command palette (⌘K)**: navigate, run actions, and search applications,
  models and Homebrew formulae (async).
- **Keyboard shortcuts**: `⌘K` palette · `/` filter · `r` rescan ·
  `g` then `o/m/d/s/a` to jump · `?` shortcuts · `Esc` close.

## Browser app (PWA) & capabilities

Vantage runs as a plain web app at `http://127.0.0.1:8790`, a secure context
(loopback), so most browser APIs work without HTTPS. Opened in Chrome/Edge or
Safari it progressively enhances itself:

- **Installable PWA.** `public/manifest.webmanifest` + `public/sw.js` provide an
  offline app shell and an install prompt (⌘K → "Install Vantage as an app", or the
  browser's Add to Dock). A navigation that misses the network falls back to the
  cached shell.
- **Browser notifications + app badge.** Job finished / failed banners when the tab
  isn't focused, plus a Dock/tab badge count (Profile → Behaviour).
- **Screen wake lock** while tracked jobs run, so long benchmarks/quantizes don't
  let the display sleep.
- **Clipboard read**, a "Paste" button on form fields, and ⌘K → "Paste clipboard
  into filter".
- **File System Access exports** (Chromium): save the inventory or a screen capture
  straight to a chosen path; other browsers fall back to a normal download.
- **Authoritative Touch ID for destructive actions** (opt-in): registering a
  platform authenticator stores its public key server-side; every `danger: high`
  action then requires a signed WebAuthn assertion that the **server verifies**
  before the action runs (`lib/webauthn.js`, backed by the dependency-free CBOR
  decoder in `lib/cbor.js`). **Open via `http://localhost:8790`, not `127.0.0.1`** –
  passkeys are not permitted on IP-literal origins. The per-run token remains the
  transport guard.
- **Drag-and-drop ingest**: drop up to 20 files onto the window (≤48 MB each); they
  are copied into `data/uploads/` and shown in a detail panel (type, size,
  permissions) with a Reveal action.
- **Web Push**: subscribe an installed PWA for real push notifications (VAPID +
  RFC 8291 `aes128gcm`, implemented dependency-free in `lib/push.js`); the notifier
  mirrors alerts to subscribed browsers (`/api/push/*`).
- **Idle pause**: metric/network/log polling stops while you are away (Idle Detection
  where available, otherwise tab visibility).
- **Share / full screen / screen capture** via ⌘K.

Everything is feature-detected and opt-in; none of it is required for the dashboard
to function. The server-side macOS permissions (Full Disk Access for `node`, etc.)
are unchanged.

## Settings & onboarding

A full-page **Settings** surface (open it from the Vantage header, or ⌘K → "Open
settings") consolidates everything that used to be scattered across panels and
views. It is generated from a declarative registry (`lib/settings.js`) and backed
by one aggregate endpoint, `/api/settings`, so defaults, validation and the UI
can't drift apart. Sections: General, Appearance (with live preview), Notifications,
Security (Touch ID), Capabilities, Data (export/import/reset), Advanced, About.

A first-run **onboarding wizard** walks through welcome → your Mac → your stack →
appearance → alerts → Touch ID → get-the-app → done. It is progressive, skippable
and resumable (state lives in `data/onboarding.json`), and re-runnable from
Settings → About. Appearance and behaviour preferences are mirrored server-side
(`data/prefs.json`) so they follow you across browsers.

### Native Mac app

`native/` builds a WKWebView shell (`native/build.sh`) that runs the same dashboard
with macOS integration and a JS↔native bridge (`window.vantageNative`) providing
equivalents for the web APIs:

- Native notifications (UserNotifications) attributed to **Vantage**, not Script Editor
- Save/Open panels (replacing File System Access), clipboard, and a Dock **badge**
- Screen wake lock (IOPMAssertion) and idle detection
- Menu-bar extra (Rescan · Clean up · Open Monitor) plus the native window/vibrancy

It loads `http://localhost:8790/?app=1` so Touch ID/WebAuthn uses the `localhost` RP
ID. **Web Push isn't available in WKWebView**, native notifications replace it.

## Safety model

- Loopback-only; per-run token required for all mutations; cross-origin rejected.
- No arbitrary shell; fixed binaries + validated arguments.
- Deletion uses the Trash where possible; blob pruning is explicit + confirmed.
- Destructive actions require a confirmation sheet.
- `READ_ONLY=1 npm start` disables all management.

## Network

The **Network** view samples interface counters every 15s (stored alongside the
other metrics) and adds:

- **Live download/upload rates** and throughput history (15m → 7d).
- **Interfaces** with IP, MAC, link speed and status.
- **Active connections** grouped by process.
- **Routing & DNS**: default gateway, DNS servers, search domains, reachability.
- **Diagnostics**: ping the gateway / 1.1.1.1 / huggingface.co, and check any
  `host:port` connectivity.

## Pausing OpenClaw

The top bar has a one-click **Pause / Resume OpenClaw** control (also in ⌘K).
Pausing stops the `gateway`, `miniapp` and `miniapp-refresh` services and
**unloads all Ollama models** to free unified memory; resuming starts exactly
the services that were running and clears the pause state. State is kept in
`data/openclaw-pause.json`. Actions: `openclaw.pause`, `openclaw.resume`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8790` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `READ_ONLY` | `0` | Set `1` to disable management |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama API |

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/session` | Token + read-only flag |
| `GET` | `/api/inventory` · `POST /api/scan` | Inventory / rescan |
| `GET` | `/api/actions` · `POST /api/actions/:id` | Management actions |
| `GET` | `/api/openclaw` | OpenClaw pause/resume state |
| `GET` | `/api/jobs` · `/api/jobs/:id?cursor=` | Job status/output |
| `GET` | `/api/metrics/live` · `/api/metrics/series?minutes=` | Metrics |
| `GET` | `/api/disk/tree?path=` · `/api/reclaim` | Disk tree / reclaimable |
| `GET` | `/api/health/checks` | Endpoint + service health |
| `GET` | `/api/logs` · `/api/logs/tail?path=&lines=` | Logs |
| `GET` | `/api/security` | Security & exposure audit |
| `GET`/`POST` | `/api/notify` · `POST /api/notify/test` | Notification settings |
| `GET`/`POST` | `/api/webauthn/*` | Touch ID: status, registration, assertion (server-verified) |
| `GET`/`POST` | `/api/push/*` | Web Push: status, subscribe/unsubscribe, test |
| `POST` | `/api/upload` | Drag-and-drop file ingest into `data/uploads` |
| `GET`/`PATCH` | `/api/settings` | Aggregated settings (registry + values); validated partial writes |
| `POST` | `/api/settings/{export,import,reset}` | Backup / restore / reset settings |
| `GET`/`POST` | `/api/onboarding` | Onboarding progress (resumable); `DELETE` resets it |
| `GET` | `/api/models/usage` | Model usage + benchmarks |
| `GET` | `/api/models/detail?name=` | Model detail panel |
| `GET` | `/api/packages/python/detail` · `/api/packages/npm/detail` | Package detail (local + registry) |
| `GET` | `/api/comfy/checkpoint?path=` | Safetensors header, params, workflow reference |
| `GET` | `/api/file/detail?path=` | File type, size, permissions |
| `GET` | `/api/services/detail?label=` · `/api/ports/detail?port=` | Service / port detail panels |
| `GET` | `/api/hf/search?q=` · `/api/hf/files?repo=` | HuggingFace |
| `GET` | `/api/agent` | OpenClaw analytics |
| `GET` | `/api/gallery` · `/api/gallery/image?path=` | ComfyUI gallery |
| `GET` | `/api/comfy/queue` · `POST /api/comfy/interrupt` · `POST /api/comfy/queue/clear` | ComfyUI queue |
| `GET` | `/api/apps/detail?path=` | Application bundle info |
| `GET` | `/api/store/search` · `/api/store/info` · `/api/store/featured` | Homebrew catalogue |
| `GET` | `/api/profile` | Local user & machine profile |
| `GET` | `/api/network` · `/api/network/ping` · `/api/network/port` | Network metrics & diagnostics |

## Layout

```
server.js            HTTP server, routes, scan lifecycle, cache
lib/scanner.js       read-only inventory probes
lib/metrics.js       background sampler + SQLite time-series, usage, benchmarks
lib/disk.js          disk tree + reclaimable-space analysis
lib/health.js        endpoint probes, launchd health, log tailing
lib/security.js      exposure + macOS posture + secrets
lib/notify.js        macOS + Telegram notifications, watcher
lib/agent.js         OpenClaw SQLite analytics (read-only)
lib/hf.js            HuggingFace search/files
lib/gallery.js       ComfyUI outputs + PNG prompt metadata
lib/apps.js          application bundle metadata
lib/store.js         Homebrew search / info / curated catalogue
lib/profile.js       local user & machine profile
lib/network.js       network counters, interfaces, routing, diagnostics
lib/packages.js      pip / npm package metadata (local + registry)
lib/safetensors.js   safetensors header reader
lib/cbor.js           minimal CBOR decoder (WebAuthn)
lib/webauthn.js       server-verified WebAuthn (Touch ID) + action grants
lib/push.js           Web Push (VAPID + RFC 8291)
lib/settings.js       declarative settings registry + aggregation
lib/onboarding.js     first-run wizard state
lib/files.js         file detail
lib/actions.js       management actions + job manager + validation
public/              dashboard UI (vanilla JS, no build step)
public/manifest.webmanifest  PWA manifest
public/sw.js          offline app-shell service worker
data/                inventory.json, metrics.db, settings.json (generated)
```
