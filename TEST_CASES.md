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
| Crash recovery | Interrupted attempt below budget resumes (`RecoveryScheduled`); interrupted final attempt fails as `Interrupted` (`RecoveryExhausted`) with no extra attempt |
| Retry budget | Repeated crashes never exceed 3 `Started` attempts; the runner refuses an attempt beyond budget without calling CRM |
| Idempotent recovery | Crash after ERP acceptance: recovery replays the frozen payload, ERP returns the original receipt, exactly one ERP order |
| Audit trail | Transient exhaustion (`RetryExhausted`) vs permanent (`Failed`) are distinct; unexpected Internal failure is terminal and audited; no keys/headers in messages |
| Manual retry audit | `ManualRetry` names the actor, prior class and attempt; creation names actor and scenario |
| Partial outage (API) | CRM unreachable → `/api/orders` 502 while metrics, history and jobs return 200 |

Backend tests use real SQLite and ASP.NET Core in-process HTTP hosts. Runner unit tests replace only outbound HTTP; mock-API tests exercise actual receiving endpoints. Each API test host gets a unique temporary database. Test credentials are generated at runtime.

Run:
```sh
dotnet test EnterpriseIntegrationHub.slnx -c Release --logger trx
```

## Browser tests against real services

Playwright uses Chromium and the real local CRM, ERP and middleware processes.

`e2e/dashboard.spec.ts` uses no response stubbing:

1. Happy path reaches Completed, returns a receipt, records timeline/mapped amount, and supports execution-ID search.
2. ERP 503 simulation records RetryScheduled and then completes.
3. Permanent error fails, manual retry completes, duplicate submission is rejected.
4. Viewer has no mutation controls, dark theme toggles and 390px layout avoids document overflow.
5. Synthetic workload failure exposes investigation details.

`e2e/resilience.spec.ts` signs in against the real services. To make outages and timing races deterministic, it then injects individual failures or synthetic pages with `page.route`:

6. CRM outage after a good load: history and metrics still return 200; a non-blocking partial-outage notice names the CRM section and its last update; the order list is preserved; no error alert; the notice clears on recovery.
7. CRM down from the first load: Run is disabled with a clear message; metrics, history and investigation remain usable.
8. History outage is reported for that section only.
9. A slow, older unfiltered response cannot overwrite a newer filtered result.
10. Filter changes reset to page 1; Clear resets filters; a page that empties clamps to the last valid page.
11. Typed search is applied only on submit.
12. Sign-out during in-flight requests: the login screen stays, protected data is not repopulated, and the next session starts clean.
13. A 401 returns to sign-in with a *session expired* message.
14–16. Mobile (390), tablet (768) and desktop (1440): no page overflow, single-line Refresh with 44px touch targets on small screens, sans-serif Material button fonts. Screenshots are saved to `test-results/`.
17. Scrollable tables are keyboard focusable, labelled, show a focus ring, and scroll with the arrow keys.
18. Dark-theme investigation view on mobile, focused after opening (uses ORD-011).

Use fresh databases: stop the demo services, move the ignored `.data` directory aside (or use a fresh checkout), then restart with `node scripts/dev.mjs`. Do not delete data you want to keep. The tests reserve ORD-001 through ORD-003 and ORD-011, and deliberately verify one-time submission.

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
- Restart the middleware during an execution; verify `RecoveryScheduled` or `RecoveryExhausted`, at most 3 `Started` entries per cycle, and reconciliation through ERP idempotency.
- Stop only the CRM (`docker compose stop crm`); verify the partial-outage notice while history and investigation keep working.
- Follow the full [Windows 11 checklist](docs/WINDOWS_TESTING.md).
- Compare source amount 250.75 with mapped amount 25075.
- Replay an identical ERP payload, then modify its amount; expect same receipt followed by 409.
- Check both themes at desktop and mobile widths, keyboard focus and empty states.
- Inspect workload text to confirm no claims of real scheduler access.

## Delivery environment constraints

The November 2026 changes were authored on a Windows 11 host with portable .NET 10 and Node.js 24. There, `dotnet build` (0 warnings) and the Angular production build were run locally. Windows Smart App Control blocked loading the freshly built, unsigned test assemblies, and Docker was not installed. So backend tests, browser tests and the Docker smoke test were verified only in GitHub Actions on Ubuntu. Docker Desktop was installed on that host afterwards (17 Nov 2026). The Compose stack and 22 API-level scenarios from [WINDOWS_TESTING.md](docs/WINDOWS_TESTING.md) were then verified there. Backend unit tests remain blocked locally by Smart App Control; GitHub Actions is the evidence for those. Do not substitute a source review for a passing build. PR notes record observed CI outcomes and any unresolved limitations.
