# Windows 11 manual testing checklist (Docker Desktop)

A step-by-step guide to running and manually verifying Enterprise Integration Hub on Windows 11 with Docker Desktop. All systems and data are fictional; nothing here connects to Oracle Integration Cloud, Dell Boomi or ESP dSeries.

> **Validation status (17 Nov 2026):** on Windows 11 Pro 26H2 with Docker Desktop 4.99 (WSL 2 backend), the stack was built and started with `docker compose up --build -d`. These checklist scenarios were verified through the dashboard's `/api` proxy: health, operator/viewer permissions, success, 503 retry, permanent failure, safe manual retry, duplicate prevention, CRM outage and recovery, and persistence across `docker compose restart` (22 checks, all passed). The browser-based steps (visual layout, keyboard, themes) were **not** executed on Windows by an automated run; tick them as you go and record anything that differs.

Commands are for **PowerShell** (Windows Terminal → PowerShell). Run them from the repository folder unless a step says otherwise.

---

## 1. Install and verify prerequisites

| Tool | Install | Verify |
|---|---|---|
| Git for Windows | https://git-scm.com/download/win (or `winget install Git.Git`) | `git --version` |
| Node.js 24 LTS (includes npm) | https://nodejs.org (or `winget install OpenJS.NodeJS.LTS`) | `node --version` → `v24.x` |
| Docker Desktop (includes Compose v2) | https://www.docker.com/products/docker-desktop/ — use the WSL 2 backend | `docker --version` and `docker compose version` |

- [ ] Open a **new** terminal after installing so `PATH` updates apply.
- [ ] Start Docker Desktop and wait until it reports **Engine running**.
- [ ] `docker run --rm hello-world` prints "Hello from Docker!".

The .NET SDK is **not** required for the Docker path; the containers build the .NET code themselves.

## 2. Clone and check out the branch

```powershell
git clone https://github.com/oscaraducal/enterprise-integration-hub.git
cd enterprise-integration-hub
git switch feature/initial-implementation
git log --oneline -1
```

- [ ] `git status` shows `On branch feature/initial-implementation` and a clean tree.

## 3. Generate local credentials

```powershell
node scripts/setup.mjs
```

- [ ] Output says `Created .env with random local credentials`.
- [ ] Find the password without printing the other secrets:

```powershell
Select-String -Path .env -Pattern '^DEMO_PASSWORD='
```

`.env` is git-ignored. Never commit it, paste it into issues, or show it in screenshots or recordings. Running the script again leaves an existing `.env` unchanged.

## 4. Build and start the services

```powershell
docker compose up --build
```

The first build downloads .NET and Node base images and can take several minutes. Leave this terminal open; use a second terminal for the remaining commands.

- [ ] In a second terminal, `docker compose ps` lists `crm`, `erp`, `hub` and `dashboard` as running.
- [ ] Health checks return `Healthy` / HTTP 200:

```powershell
foreach ($port in 5100, 5101, 5102) { (Invoke-WebRequest "http://localhost:$port/health" -UseBasicParsing).StatusCode }
```

Ports bind to `127.0.0.1` only, so the demo is not reachable from other machines.

## 5. Access the dashboard

- [ ] Open http://localhost:4200.
- [ ] The sign-in page shows "Welcome back" and the "Synthetic data only" notice.

## 6. Operator and Viewer permissions

- [ ] Sign in as **operator** with `DEMO_PASSWORD`. The top bar shows `Operator`; **Run an integration** is visible.
- [ ] Sign out. Sign in as **viewer**. The top bar shows `Viewer`; there is no Run form, no **Safely retry** button and no workload **Simulate** buttons.
- [ ] Optional API check — a viewer token is rejected for mutations with HTTP 403:

```powershell
$pw = ((Select-String -Path .env -Pattern '^DEMO_PASSWORD=').Line -split '=', 2)[1]
$viewer = Invoke-RestMethod -Method Post http://localhost:5100/api/auth/login -ContentType 'application/json' -Body (@{ username = 'viewer'; password = $pw } | ConvertTo-Json)
try { Invoke-RestMethod -Method Post http://localhost:5100/api/executions -Headers @{ Authorization = "Bearer $($viewer.token)" } -ContentType 'application/json' -Body '{"orderId":"ORD-010"}' } catch { $_.Exception.Response.StatusCode }
Remove-Variable pw, viewer
```

Expected: `Forbidden`.

## 7. Successful CRM-to-ERP integration

- [ ] As operator, choose **ORD-001**, environment **DEV**, scenario **None**, and click **Run integration**.
- [ ] The investigation panel opens and reaches **Completed**.
- [ ] Timeline: `Queued` (names the operator and the 3-attempt budget) → `Started` (attempt 1 of 3) → `Retrieved` → `Mapped` → `Completed`.
- [ ] **Receipt** shows an ERP receipt ID; **Mapped payload** shows `totalMinorUnits` (decimal CRM amount × 100).

## 8. Temporary failure and automatic recovery

- [ ] Run **ORD-002** with scenario **Unavailable**, target **ERP**, **1 · recover**.
- [ ] Timeline shows `RetryScheduled` (Warning) then a second `Started` and `Completed`. Attempts = 2.
- [ ] Run **ORD-004** with **ServerError** and **3 · exhaust**. After about 5 seconds it ends **Failed** with a final `RetryExhausted` entry: the automatic budget of 3 attempts was used up.

## 9. Investigate a permanent failure

- [ ] Run **ORD-003** with **BadRequest**. It fails after **one** attempt (no automatic retry).
- [ ] The red panel shows the classification (`InvalidRequest`) and troubleshooting guidance; the final timeline entry says *permanent, not retried automatically*.
- [ ] Try **ORD-005** with **Validation** (target is forced to CRM). It fails with `Validation`, and the mapped payload stays empty because invalid data never reaches the ERP.

## 10. Safe manual retry

- [ ] Open the failed **ORD-003** execution and click **Safely retry execution**.
- [ ] A `ManualRetry` entry names who retried, the previous error class and attempt, and states that a new 3-attempt cycle started with the same order ID and frozen payload.
- [ ] The execution reaches **Completed**; **Manual retries** = 1.
- [ ] As viewer, the retry button is not shown.

## 11. Duplicate prevention

- [ ] Run **ORD-001** again. An error says the source order is *already tracked*; no second execution appears in history.
- [ ] Run **ORD-006** with **Duplicate** (ERP returns 409). It fails as `DuplicateConflict`; do not "fix" it by inventing a new order ID.
- [ ] Optional crash-recovery idempotency check: run **ORD-007** with **Timeout**, **3 · exhaust**. Within about 5 seconds, run `docker compose kill hub`, then `docker compose start hub`. Reopen the execution. The timeline shows `RecoveryScheduled` (resumed with the remaining budget) or `RecoveryExhausted` (final attempt was interrupted, so it fails and needs a manual retry). The total number of `Started` entries never exceeds 3 per cycle.

## 12. Partial CRM outage

- [ ] Note the current execution count, then stop only the CRM:

```powershell
docker compose stop crm
```

- [ ] Within a few seconds a yellow **Some data could not be refreshed** notice names *Mock CRM source orders* and the time of the last good update. It is not a blocking error.
- [ ] Metrics, execution history, search, filters and **Inspect** still work. The Run form keeps the previously loaded order list and warns that it may be out of date.
- [ ] Run **ORD-008** with scenario **None**. It goes through `RetryScheduled` twice and finally `RetryExhausted` (3 attempts), because the CRM is down. Under Docker the class is usually `Timeout`: resolving the stopped `crm` container takes longer than the hub's 2-second timeout. A native run with the CRM process stopped reports `Connection` instead. Both are transient and retried automatically. You can investigate it while the outage continues.
- [ ] Restart the CRM: `docker compose start crm`. The notice disappears on the next refresh. Retry **ORD-008**; it completes.

## 13. Persistent execution history

```powershell
docker compose down
docker compose up -d
```

- [ ] After signing in again, earlier executions, timelines and receipts are still listed (stored in the named Docker volumes).
- [ ] Reload the page. You return to sign-in: the token is held only in memory, and no protected data is cached in browser storage.

## 14. Responsive layout

Open DevTools (F12) → device toolbar (Ctrl+Shift+M) and check each width in **light and dark** themes:

| Width | Check |
|---|---|
| 390 px (phone) | Navigation becomes a top row; **Refresh** stays on one line; metric cards in two columns; no sideways page scrolling |
| 768 px (tablet) | Filters wrap neatly; table scrolls inside its card only |
| 1440 px (desktop) | Fixed sidebar; five metric cards in one row |

- [ ] Press **Tab** to the execution table and use the **arrow keys** to scroll it sideways; a blue focus ring is visible.
- [ ] All buttons use the same sans-serif font (no serif text).

## 15. Stop services

```powershell
docker compose down
```

Stops and removes the containers but **keeps** all demo data in volumes. Press Ctrl+C first if `docker compose up` is still attached to a terminal.

## 15b. Back up demo data (optional, before upgrades or experiments)

```powershell
$b = "$HOME\Documents\eih-db-backups\$(Get-Date -Format yyyyMMdd-HHmmss)"
foreach ($s in 'crm','erp','hub') { New-Item -ItemType Directory -Force "$b\$s" | Out-Null; docker compose cp "${s}:/data/." "$b\$s" }
```

Copy the **whole** `/data` directory. SQLite runs in WAL mode, so the newest changes may still be in `*.db-wal` / `*.db-shm` next to the `.db` file. Restoring from a `.db` file alone can silently lose recent executions.

Upgrading from the first release (`feature/initial-implementation`) to the portfolio lab keeps existing data. On startup, each service adds the new columns, tables and seed records, and existing executions, receipts, orders and jobs are not modified.

## 16. Reset local demo data safely

> **This permanently deletes every execution, receipt and workload record for this demo.** It affects only this project's volumes (`<folder>_crm-data`, `<folder>_erp-data`, `<folder>_hub-data`).

```powershell
docker compose down -v
docker compose up --build
```

- [ ] After reset, ORD-001 to ORD-012 can be run again and history starts empty.
- [ ] `.env` is kept. To rotate credentials, delete `.env` yourself and run `node scripts/setup.mjs` again **before** starting the stack.

---

## Troubleshooting on Windows

| Symptom | Fix |
|---|---|
| `error during connect` / `open //./pipe/dockerDesktopLinuxEngine` | Docker Desktop is not running. Start it and wait for **Engine running**. |
| Docker Desktop asks for WSL 2 | Run `wsl --install` in an elevated terminal, reboot, and choose the WSL 2 backend in Docker Desktop → Settings → General. |
| `required variable ... Run the setup script first` | `.env` is missing or you are in the wrong folder. `cd` to the repository root and run `node scripts/setup.mjs`. |
| `Bind for 127.0.0.1:4200 failed: port is already allocated` | Another app uses the port. Find it with `netstat -ano | findstr :4200`, then stop it, or stop a native `npm start` / `node scripts/dev.mjs` session. Ports 5100–5102 are also used. |
| `npm : running scripts is disabled on this system` | PowerShell blocks `npm.ps1`. Use `npm.cmd ci` / `npm.cmd test`, or run the command in Command Prompt. The Docker path does not need npm. |
| Native `dotnet test` / `node scripts/dev.mjs` fails with *An Application Control policy has blocked this file* | Windows Smart App Control or a company WDAC policy is blocking freshly built, unsigned DLLs. Use the Docker path, which runs the code inside Linux containers. Do not turn off security controls on a managed PC. |
| Login returns 401 | Use `DEMO_PASSWORD` from **this** folder's `.env`. If you regenerated `.env`, recreate the containers: `docker compose up -d --force-recreate`. |
| Login returns 429 | Login is limited to 10 attempts per minute. Wait one minute. |
| Dashboard shows *Integration Hub API is unreachable* | `docker compose ps`; check `docker compose logs hub`. The hub may still be starting. |
| *Your session expired* | Tokens last 30 minutes and are held only in memory; a page reload also signs you out. Sign in again. |
| First build is very slow | Normal on first run (image downloads). Exclude the repository folder from real-time antivirus scanning only if your policy allows it. |
| `docker compose up --build` fails with "no space left on device" | Docker Desktop → Troubleshoot → Clean / Purge data, or `docker system prune` (removes unused images and containers from **all** projects; read the prompt first). |

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for application-level error classes.
