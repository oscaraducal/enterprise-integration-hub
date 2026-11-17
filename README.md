# Enterprise Integration Hub

[![Build and test](https://github.com/oscaraducal/enterprise-integration-hub/actions/workflows/ci.yml/badge.svg?branch=feature/initial-implementation)](https://github.com/oscaraducal/enterprise-integration-hub/actions/workflows/ci.yml)
![.NET 10](https://img.shields.io/badge/.NET-10-512BD4)
![Angular 21](https://img.shields.io/badge/Angular-21-DD0031)
![Synthetic data](https://img.shields.io/badge/data-synthetic%20only-2e7d32)

**A CRM-to-ERP integration simulator with a monitoring and troubleshooting console.** Built with **C# / ASP.NET Core 10, Entity Framework Core, SQLite and Angular 21**, it shows the parts of enterprise integration that matter after the first successful HTTP call: execution tracking, failure classification, bounded automatic retries, safe manual replay, idempotent delivery, audit trails, and a dashboard that stays useful during an upstream outage.

> **Portfolio disclaimer.** This is a personal engineering portfolio project. All systems (Mock CRM, Mock ERP) and all data are fictional. It is **not** an Oracle Integration Cloud, Dell Boomi or ESP dSeries implementation, it does not connect to any vendor platform, and it contains no employer-owned code, credentials, customer data or execution logs. The concepts it demonstrates (execution IDs, stage logs, retries and lower-environment job monitoring) reflect general integration-operations experience.

---

## Contents
[Features](#features) · [Architecture](#architecture) · [Screenshots](#screenshots) · [Quick start](#quick-start-docker) · [Demo](#demo-in-five-minutes) · [Testing](#testing-and-verification) · [Tech stack](#technology-stack) · [Limitations](#known-mvp-limitations) · [Docs](#documentation)

## Features

**Integration**
- Three independently hosted REST APIs (Mock CRM → Integration Middleware → Mock ERP) with OpenAPI contracts.
- JSON validation and mapping: decimal CRM amounts become integer ERP minor units, and currency and customer references are checked.
- Mapped payloads are frozen on the first valid mapping, so retries can never silently send different data.

**Reliability**
- A durable SQLite execution queue with a single background worker and atomic claims.
- Failure classification (400/401/404/409 are permanent; 408/429/5xx/connection/timeout are transient).
- At most **3 automatic attempts per cycle**, with exponential backoff and bounded `Retry-After` support. The budget also holds across crashes and restarts.
- Idempotent ERP acceptance: an identical replay returns the original receipt, and a changed payload is rejected with 409.

**Monitoring and troubleshooting**
- A unique execution ID per order and an attributed audit timeline (Queued → Started *n of 3* → Retrieved → Mapped → Completed / RetryScheduled / RetryExhausted / Failed / ManualRetry / Recovery*).
- Troubleshooting guidance per error class, and an operator-only **Safely retry** action.
- Search, status and environment filters, plus pagination that stays valid as data changes.
- **Partial-outage tolerance:** if the CRM goes down, history, metrics and investigation keep updating behind a non-blocking warning.
- Synthetic DEV/TEST workload history and failed-job investigation (no real scheduler connection).

**Security and UX**
- JWT authentication with **Operator** (run/retry) and **Viewer** (read-only) roles enforced server-side, plus rate-limited login.
- Generated local credentials only, loopback-only ports and non-root containers.
- Responsive console (mobile, tablet, desktop), light and dark themes, keyboard-accessible tables and 44px touch targets.

## Architecture

```mermaid
flowchart LR
    User["Operator / Viewer<br/>(browser)"] --> UI["Angular 21 console<br/>polling · isolated sections"]
    UI -->|"JWT · REST /api"| Hub
    subgraph Hub["Integration Middleware (ASP.NET Core 10)"]
      direction TB
      API["REST API<br/>auth · validation · metrics"] --> Q[("SQLite<br/>executions · audit logs · jobs")]
      W["Background worker<br/>classify · retry · recover"] --> Q
    end
    W -->|"GET order · service key"| CRM["Mock CRM API<br/>synthetic customers/orders"]
    W -->|"POST mapped order · service key"| ERP["Mock ERP API<br/>idempotency + receipts"]
    CRM --> CrmDb[("SQLite")]
    ERP --> ErpDb[("SQLite")]
```

**Data flow:** an operator queues a source order (HTTP 202). The worker claims it, then fetches the order from the CRM, validates it, maps it and freezes the payload, then posts it to the ERP with the execution ID. Every stage is persisted to the timeline. Transient failures are rescheduled with backoff until the 3-attempt budget is spent. Permanent failures stop for investigation. ERP idempotency makes replays safe after lost responses or crashes. This is *at-least-once delivery with idempotent acceptance*, not distributed exactly-once.

Details: [ARCHITECTURE.md](ARCHITECTURE.md) (lifecycle state machine, audit trail, crash recovery, dashboard loading model).

## Screenshots

The CI browser tests capture screenshots of the real running stack in every run: the desktop dashboard after a completed integration, mobile/tablet/desktop layouts, the partial CRM outage notice, and the dark-theme investigation view on mobile. Download them from the **verification-reports** artifact of the latest [GitHub Actions run](https://github.com/oscaraducal/enterprise-integration-hub/actions/workflows/ci.yml) (`frontend/test-results/*.png`).

<!-- Screenshots will be embedded here once copied from a CI artifact into docs/screenshots/. -->

## Quick start (Docker)

Prerequisites: **Git, Node.js 24, Docker Desktop / Engine with Compose**. Windows 11 users can follow the step-by-step **[Windows 11 checklist](docs/WINDOWS_TESTING.md)**.

```sh
git clone https://github.com/oscaraducal/enterprise-integration-hub.git
cd enterprise-integration-hub
git switch feature/initial-implementation
node scripts/setup.mjs        # writes random local credentials to the git-ignored .env
docker compose up --build
```

Open **http://localhost:4200** and sign in as **operator** or **viewer** using `DEMO_PASSWORD` from your local `.env`. Never commit or share that file.

- Stop: `docker compose down` (data is kept in named volumes).
- Reset: `docker compose down -v` **permanently deletes all demo data**, and the next start reseeds it.

<details>
<summary>Run without Docker (.NET 10 SDK + Node.js 24)</summary>

```sh
node scripts/setup.mjs
dotnet restore EnterpriseIntegrationHub.slnx
dotnet build EnterpriseIntegrationHub.slnx -c Release --no-restore
node scripts/dev.mjs          # starts CRM :5101, ERP :5102, middleware :5100
```

Second terminal:

```sh
cd frontend
npm ci
npm start                     # http://localhost:4200, proxies /api to :5100
```

| Service | URL | OpenAPI |
|---|---|---|
| Middleware | http://localhost:5100 | /openapi/v1.json |
| Mock CRM | http://localhost:5101 | /openapi/v1.json |
| Mock ERP | http://localhost:5102 | /openapi/v1.json |

The dashboard proxies `/api` to the middleware, and service keys never reach the browser. SQLite files live in the git-ignored `.data/` folder.
</details>

## Demo in five minutes

| # | Do this | What it shows |
|---|---|---|
| 1 | Run **ORD-001**, scenario **None** | Full trace: mapping to minor units, frozen payload, ERP receipt |
| 2 | Run **ORD-002**, **Unavailable**, 1 failure | `RetryScheduled` → automatic recovery |
| 3 | Run **ORD-003**, **BadRequest** | Permanent failure, guidance, then **Safely retry** with an attributed audit entry |
| 4 | Run **ORD-001** again | Duplicate source order rejected |
| 5 | `docker compose stop crm` | Partial-outage notice; history and investigation still live |
| 6 | Sign in as **viewer** | Read-only role enforced by the API, not only hidden in the UI |

The full script is in [docs/DEMO.md](docs/DEMO.md).

## Testing and verification

| Suite | What it covers | Where it runs |
|---|---|---|
| Backend (xUnit) | Mapping, classification, backoff, retries, retry budget, crash recovery, idempotency, audit trail, auth/roles, partial CRM outage at the API, mock CRM/ERP contracts | `dotnet test` · CI |
| Angular production build | Type-checked templates, SCSS, bundle budget | `npm run build` · CI |
| Browser (Playwright, Chromium) | Real CRM/ERP/middleware end to end, plus injected partial outages, stale-response races, filters and pagination, sign-out and expiry, keyboard tables, mobile/tablet/desktop layouts | `npm test` · CI |
| Docker smoke test | Compose stack, nginx proxy, JWT login, CRM mapping, ERP retry and receipt | CI |

Results come from GitHub Actions, not from this README. See the [latest CI runs](https://github.com/oscaraducal/enterprise-integration-hub/actions/workflows/ci.yml) and the PR [oscaraducal/enterprise-integration-hub#1](https://github.com/oscaraducal/enterprise-integration-hub/pull/1) for the recorded outcomes. Test catalogue and local instructions: [TEST_CASES.md](TEST_CASES.md).

## Technology stack

| Area | Technology |
|---|---|
| Backend | C# 14, ASP.NET Core 10 minimal APIs, `BackgroundService`, `IHttpClientFactory` |
| Persistence | Entity Framework Core 10 + SQLite (one database per service) |
| Security | JWT bearer (HMAC-SHA256), role policies, ASP.NET Core rate limiting, service keys |
| Frontend | Angular 21 standalone components and signals, Angular Material 3, SCSS |
| Testing | xUnit, `WebApplicationFactory`, Playwright (Chromium) |
| Delivery | Docker Compose, nginx, GitHub Actions |

## Known MVP limitations

- **Local demonstration only.** Startup refuses non-Development/Testing environments. It uses HTTP, a shared generated demo password and a simple service key. It is not hardened for internet exposure.
- **Single replica.** Crash recovery assumes one middleware process. There are no distributed leases, message broker or outbox.
- **Schema:** `EnsureCreated` instead of versioned migrations. DEV/TEST are labels in one database, not isolated environments.
- **Delivery:** at-least-once with idempotent acceptance, not exactly-once. Metrics are aggregated in-process for modest demo volumes.
- **Auth:** two fixed demo accounts, memory-only 30-minute tokens and no refresh tokens. A page reload signs out.
- **Workloads** are synthetic history records. Nothing is scheduled or executed.

## Documentation

| Document | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, lifecycle, retry and recovery rules, audit trail, dashboard loading |
| [API_DOCUMENTATION.md](API_DOCUMENTATION.md) | Endpoints, contracts, scenarios, error classes |
| [TEST_CASES.md](TEST_CASES.md) | Automated and manual test catalogue |
| [docs/WINDOWS_TESTING.md](docs/WINDOWS_TESTING.md) | Windows 11 + Docker Desktop manual checklist |
| [docs/DEMO.md](docs/DEMO.md) | Five-minute walkthrough script |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Error classes and fixes |
| [SECURITY.md](SECURITY.md) | Security boundaries and what a production rollout would need |
| [PORTFOLIO_DESCRIPTION.md](PORTFOLIO_DESCRIPTION.md) | Profile-ready project description |

<details>
<summary>Repository map</summary>

```text
src/Shared/              Contracts, validation, mapping, demo host defaults
src/MockCrm/             Fictional customers and orders API
src/MockErp/             Validating, idempotent receiving API
src/Hub/Domain/          Executions, audit logs, synthetic job records
src/Hub/Application/     IntegrationRunner, FailurePolicy, ExecutionRecovery
src/Hub/Infrastructure/  EF Core DbContext and the background worker
frontend/                Angular console and Playwright tests
tests/Hub.Tests/         Unit, recovery and API integration tests
scripts/                 Credential setup, native launcher, Docker smoke test
.github/workflows/       CI: build, tests, browser tests, Compose smoke
```
</details>
