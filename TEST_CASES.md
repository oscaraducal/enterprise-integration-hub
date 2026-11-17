# Test cases and verification

Tests are grouped by behavior rather than copied from implementation details. **Presence in this table is not a claim that a test has passed.** GitHub Actions and its uploaded reports are the source of execution results.

## Automated backend coverage

| Area | Check |
|---|---|
| Mapping | ID/account/currency preserved, decimal to integer minor units, half-away rounding |
| Validation | Zero/negative/oversized amounts and unsupported currency rejected |
| Classification | 400, 401, 404, 409 permanent; 408, 429, 500, 503 transient |
| Backoff | 1/2/4 seconds, Retry-After honored with 30-second cap |
| Success | Persisted receipt, mapped payload and stage sequence |
| Retry | 429/500/503 recover after transient failure |
| Exhaustion | Timeout stops after three attempts |
| Permanent error | No automatic retry for 400/401/404/409 |
| JSON | Malformed JSON classified as Validation |
| Safety | Invalid source never reaches ERP; retries reuse frozen payload after source changes |
| Logs | Controlled stage messages, no service-key header in persisted log text |
| Authentication | Anonymous, wrong password and expired JWT rejected |
| Authorization | Viewer reads metrics but cannot submit/retry or simulate jobs |
| Monitoring | Durable submission, ID filtering, metrics, queued timeline |
| Idempotency | Concurrent submissions create one execution; concurrent ERP deliveries return one receipt; retry state transition is conditional |
| ERP | Same payload returns same receipt; changed payload conflicts; invalid amount rejected |
| CRM | Seeded fictional data, unknown-customer validation, 503 simulation |
| Workload | DEV/TEST filtering and synthetic failed-job details |

Backend tests use real SQLite and ASP.NET Core in-process HTTP hosts. Runner unit tests replace only outbound HTTP; mock-API tests exercise actual receiving endpoints. Each API test host gets a unique temporary database. Test credentials are generated at runtime.

Run:
```sh
dotnet test EnterpriseIntegrationHub.slnx -c Release --logger trx
```

## Browser tests against real services

Playwright uses Chromium and the real local CRM, ERP and middleware processes, with no network response stubbing.

1. Happy path reaches Completed, returns a receipt, records timeline/mapped amount, and supports execution-ID search.
2. ERP 503 simulation records RetryScheduled and then completes.
3. Permanent error fails, manual retry completes, duplicate submission is rejected.
4. Viewer has no mutation controls, dark theme toggles and 390px layout avoids document overflow.
5. Synthetic workload failure exposes investigation details.

Use fresh databases: stop the demo services, move the ignored `.data` directory aside (or use a fresh checkout), then restart with `node scripts/dev.mjs`. Do not delete data you want to keep. The tests reserve ORD-001 through ORD-003 and deliberately verify one-time submission.

Set the generated local password for the test process:

PowerShell:
```powershell
$entry = Get-Content ../.env | Where-Object { $_.StartsWith('DEMO_PASSWORD=') }
$env:DEMO_PASSWORD = $entry.Substring('DEMO_PASSWORD='.Length)
npm test
```

Bash (from frontend):
```sh
set -a
source ../.env
set +a
npm test
```

Playwright starts Angular. Use `npx playwright show-report` for the HTML report.

## Manual review

- Run all scenarios with unique source orders; verify expected classification and guidance.
- Use a Viewer token directly against mutation endpoints and confirm 403.
- Restart the middleware during an execution; verify recovered processing reconciles through ERP idempotency.
- Compare source amount 250.75 with mapped amount 25075.
- Replay an identical ERP payload, then modify its amount; expect same receipt followed by 409.
- Check both themes at desktop and mobile widths, keyboard focus and empty states.
- Inspect workload text to confirm no claims of real scheduler access.

## Delivery environment constraints

The authoring host has Node.js but no npm or .NET SDK and cannot resolve github.com through terminal Git. Node script syntax can be checked locally; full validation is delegated to the repository's GitHub Actions workflow. Do not substitute a source review for a passing build. Final PR notes record observed CI outcomes and any unresolved limitations.
