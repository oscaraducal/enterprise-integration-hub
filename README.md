# Enterprise Integration Hub

A production-inspired **local demonstration** of API integration, execution monitoring and troubleshooting, built with **ASP.NET Core 10, Angular 21, Entity Framework Core and SQLite**.

Follow fictional customer orders from a mock CRM through validation and JSON transformation into a mock ERP. Investigate failures, observe bounded automatic retries and safely replay failed executions without duplicating accepted orders.

> Synthetic systems and data only. This is not an Oracle Integration Cloud, Dell Boomi or ESP dSeries implementation. It contains no employer-owned information. The workload module demonstrates lower-environment monitoring, not real scheduling or scheduler automation.

## What you can demonstrate

- Three independently hosted REST APIs with documented JSON contracts.
- A durable SQLite execution queue with unique IDs, stage logs and crash recovery.
- Integer minor-unit ERP amounts mapped from decimal CRM amounts.
- HTTP 400/401/404/429/500/503, timeouts, validation and duplicate-conflict simulations.
- A maximum of three attempts per cycle; exponential backoff and bounded Retry-After support.
- Database-backed order deduplication, payload freezing and idempotent ERP receipts.
- JWT authentication with Operator and read-only Viewer roles.
- Responsive Angular dashboard with light/dark themes, status distribution, metrics, filters, investigation timeline and safe retry.
- Fictional DEV/TEST workload history and failure investigation.
- Unit, API integration and real-service browser tests; GitHub Actions CI.

## Quick start: Docker

Prerequisites: Git, Node.js 24, Docker Engine/Desktop with Compose.

```sh
git clone https://github.com/oscaraducal/enterprise-integration-hub.git
cd enterprise-integration-hub
git switch feature/initial-implementation
node scripts/setup.mjs
docker compose up --build
```

1. Open **http://localhost:4200**.
2. Read the generated `DEMO_PASSWORD` from your local `.env`.
3. Sign in as **operator** to run/retry, or **viewer** to inspect.
4. Run **ORD-001** with scenario **None**.
5. Open **Inspect** to review the mapped payload, stage timeline and ERP receipt.
6. Use another order for each scenario. Try **Unavailable** with one failing attempt to see recovery, or three to exhaust retries.
7. Retry a failed execution to clear its simulation and retain its transaction identity.

The setup script generates random local credentials and refuses to overwrite an existing `.env`. Do not publish that file or paste its contents into issues. The repository includes only configuration placeholders.

All published container ports bind to loopback. Stop with `docker compose down`; data remains in named volumes. `docker compose down -v` **deletes all demo databases** and reseeds the next start.

## Run without Docker

Prerequisites: **.NET 10 SDK** (the runtime alone is insufficient), **Node.js 24 with npm**, and Git.

From the repository root:

```sh
node scripts/setup.mjs
dotnet restore EnterpriseIntegrationHub.slnx
dotnet build EnterpriseIntegrationHub.slnx -c Release --no-restore
node scripts/dev.mjs
```

In a second terminal:

```sh
cd frontend
npm install
npm start
```

Visit http://localhost:4200. The API launcher starts all three processes and places SQLite files in ignored `.data/`. Press Ctrl+C to stop it.

| Service | Local URL | OpenAPI JSON |
|---|---|---|
| Middleware | http://localhost:5100 | http://localhost:5100/openapi/v1.json |
| Mock CRM | http://localhost:5101 | http://localhost:5101/openapi/v1.json |
| Mock ERP | http://localhost:5102 | http://localhost:5102/openapi/v1.json |
| Angular console | http://localhost:4200 | — |

The dashboard proxies `/api` to the middleware; service keys are never sent to the browser. OpenAPI documents can be imported into free API clients. A hosted Swagger UI is not required.

## Verification

```sh
dotnet test EnterpriseIntegrationHub.slnx -c Release
cd frontend
npm install
npm run build
npx playwright install chromium
```

For browser tests, keep the three APIs running, and export `DEMO_PASSWORD` from your local `.env` into the test terminal's environment before running `npm test`. Playwright starts Angular automatically. Browser scenarios use ORD-001 through ORD-003 and expect fresh demo databases. See [TEST_CASES.md](TEST_CASES.md) for repeatable clean-state instructions and the distinction between written tests and verified results.

CI builds all projects, runs backend tests, starts the actual CRM/ERP/middleware processes, builds Angular and executes Chromium browser tests. Reports are uploaded as workflow artifacts. See the [Actions page](https://github.com/oscaraducal/enterprise-integration-hub/actions) for actual results.

## Repository map

```text
src/Shared/              Contracts, validation, JSON logging and demo host defaults
src/MockCrm/             Fictional customers and orders API
src/MockErp/             Validating, idempotent receiving API
src/Hub/Domain/          Executions, stage logs and synthetic job records
src/Hub/Application/     Mapping orchestration and retry classification
src/Hub/Infrastructure/  EF Core persistence and durable queue worker
frontend/               Angular operations console and browser tests
tests/Hub.Tests/        Unit and API integration tests
scripts/                Local credential setup and multi-process launcher
.github/workflows/      Automated build and verification
```

## Documentation

- [Architecture and reliability](ARCHITECTURE.md)
- [API contracts and examples](API_DOCUMENTATION.md)
- [Automated and manual test cases](TEST_CASES.md)
- [Demo walkthrough](docs/DEMO.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Security boundaries](SECURITY.md)
- [Portfolio description](PORTFOLIO_DESCRIPTION.md)

## Intentional MVP limits

This is a single-replica, local simulator, not a production integration service. Startup refuses non-Development/non-Testing environments. Authentication uses locally generated demo credentials, short-lived in-memory browser tokens and two fixed roles. There is no user administration, refresh-token service or external identity provider.

SQLite uses `EnsureCreated` for a fresh demo schema; versioned migrations, multi-replica leases, retention, distributed messaging, circuit breakers, live scheduler integrations and production deployment are future work. DEV/TEST are labels within the same demo database, not isolated infrastructures. One source order ID is tracked once across those labels.

Only USD, PHP and EUR are supported, each with two decimal places. Job simulation writes completed history records immediately; it does not schedule or execute real workloads. The MVP has bounded list pages but aggregates metrics in-process and is intended for modest demo volumes.

Dependency versions are explicit. Commit the resolved npm lockfile from a successful install before a reproducible release; the workflow currently uses `npm install` and archives that lockfile for review.
