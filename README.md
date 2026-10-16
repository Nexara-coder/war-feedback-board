# W.A.R. Online: Feedback Ops Board

A self-hosted, live feedback board for playtesting my multiplayer FPS, **W.A.R. Online**. Testers log bugs and suggestions from any browser. I triage them through a Queued → Active → Resolved workflow behind an admin login.

It runs in production on a Debian 12 LXC container on my Proxmox home server, under systemd, behind an nginx reverse proxy.

## Features

- **One shared, live board.** Every visitor sees the same data, and clients poll every 6 seconds so the board stays current without a refresh.
- **Role split enforced on the server.** Anyone can *submit* a report. Only an authenticated admin can move, edit, delete or clear items. The UI hides the controls, but the API is what actually enforces the rule.
- **Priority triage** (critical, high, medium, low) with filter chips and live counts
- **"Copy for Discord/Chat"** exports the current board as formatted text for patch notes or tester updates.
- **No database to run.** Data is stored as a single JSON file, so backup and restore is a file copy.

## Security design

| Concern | How it's handled |
|---|---|
| Authentication | Admin password lives in `.env`, never in code. The server refuses to start if it or the session secret is missing. |
| Sessions | `express-session` with `httpOnly`, `sameSite=lax` cookies and a 12-hour expiry. The `secure` flag can be turned on once the site is behind TLS. |
| Brute force | Per-IP login limiter: 8 failed attempts locks that IP out for 5 minutes. |
| Spam | Per-IP submission limiter: 20 reports per 10 minutes. |
| Authorization | `requireAdmin` middleware on every write route except public submission. |
| Input validation | Allow-listed status and priority values, length caps on every field, and title required. |
| XSS | All user text is HTML-escaped before rendering. |
| Least privilege | The service runs as a dedicated `nologin` system user, not root. |
| Transport | Designed to sit behind an nginx reverse proxy that terminates TLS. `trust proxy` is set so rate limiting sees real client IPs. |

## API

| Method | Route | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/tasks` | Public | List all reports |
| `POST` | `/api/tasks` | Public (rate-limited) | Submit a report |
| `PATCH` | `/api/tasks/:id` | Admin | Move status and/or edit fields |
| `DELETE` | `/api/tasks/:id` | Admin | Delete one report |
| `DELETE` | `/api/tasks` | Admin | Clear the board |
| `POST` | `/api/login` / `/api/logout` | Public | Start or end an admin session |
| `GET` | `/api/session` | Public | Check admin status |

## Stack

Node.js 20 · Express 4 · express-session · vanilla JS/HTML/CSS frontend · systemd · nginx · Debian 12 LXC on Proxmox VE

## Running it

```bash
npm install
cp .env.example .env     # set ADMIN_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
npm start                # http://localhost:3000
npm test                 # end-to-end permission tests against a throwaway server
```

> If your password contains `#`, wrap it in quotes in `.env`. Otherwise dotenv treats everything after it as a comment.

## Deploying (Debian / Proxmox LXC)

```bash
# 1. Container: Debian 12 LXC, 1 vCPU / 512 MB RAM / 4 GB disk, unprivileged
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs

# 2. App
git clone https://github.com/Nexara-coder/war-feedback-board /opt/war-feedback-board
cd /opt/war-feedback-board && npm install --omit=dev
cp .env.example .env && nano .env

# 3. Dedicated service user + systemd
useradd -r -s /usr/sbin/nologin warboard
chown -R warboard:warboard /opt/war-feedback-board
cp war-feedback.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now war-feedback
```

Then point your reverse proxy at `<container-ip>:3000`, issue a TLS certificate, and set `USE_SECURE_COOKIE=true`.

**Updating** only touches code. `.env` and `data/tasks.json` are left alone:

```bash
cd /opt/war-feedback-board && git pull && systemctl restart war-feedback
```

## Possible improvements

- Swap the JSON file for SQLite if the board grows beyond a few thousand reports
- Hash the admin password (bcrypt) instead of comparing a plain environment value
- Add CSRF tokens if the board is ever embedded in a cross-site context
