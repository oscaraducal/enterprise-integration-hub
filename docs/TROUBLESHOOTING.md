# Troubleshooting

| Symptom | Investigation and recovery |
|---|---|
| dotnet says no SDK found | Install the .NET 10 SDK. A .NET runtime does not include the compiler/build tools. |
| npm not found | Install Node.js 24 including npm, reopen the terminal, verify node --version and npm --version. |
| Startup requests configuration | Run node scripts/setup.mjs from the repository root. Native launcher and Compose load the generated .env. |
| Startup rejects environment | The simulator intentionally runs only in Development or Testing. Use the documented launcher. |
| Login returns 401 | Select operator or viewer; use DEMO_PASSWORD from the local .env. Restart APIs after changing configuration. |
| Login returns 429 | Wait for the one-minute login rate-limit window. |
| Session expires | The dashboard returns to sign-in with "Your session expired" when the 30-minute token lapses or the API returns 401. Sign in again. Tokens are memory-only, so a page reload also signs out. |
| Mock CRM unavailable / 502 | Check :5101/health and Services:CRM. The source service may still be starting. |
| Authentication execution failure | Check service-key consistency locally. An Unauthorized simulation deliberately creates the same class. |
| MissingResource | Verify the source order ID exists and service routes are correct. |
| Validation | Inspect required fields, amount and USD/PHP/EUR support. Correct the CRM record before retrying. |
| RateLimited / UpstreamUnavailable | Observe automatic retry, then inspect health/configuration if the budget is exhausted. |
| Timeout | A Timeout scenario sleeps 10 seconds while the client times out at 2 seconds. Three failures exhaust the cycle. |
| DuplicateConflict | Reconcile the ERP receipt and payload. Do not invent a new transaction ID merely to bypass protection. |
| “Source order already tracked” | Open the existing execution. Retry only if Failed, or create a genuinely new synthetic source order through CRM. |
| Retry returns 409 | The execution is active/completed or another operator already queued it. Refresh its status. |
| SQLite schema mismatch after changes | The MVP has no migrations. Preserve needed demo history, then start with new empty demo databases. |
| Port already in use | Stop another instance using 4200 or 5100–5102. Docker and native setups should not run simultaneously. |
| Browser test fails on duplicate | Tests expect a clean database and reserve ORD-001–003. Use a fresh checkout/data directory. |
| Worker reports Internal | Find the execution ID in structured server logs; do not expose secrets or raw exception dumps in public issues. |
| Interrupted / RecoveryExhausted | The hub restarted during the final automatic attempt. The budget is spent, so nothing retries automatically. Check the ERP receipt list if needed, then use Safely retry; ERP idempotency returns the existing receipt if the order was already accepted. |
| RecoveryScheduled in a timeline | The hub restarted mid-attempt with budget remaining; it resumed automatically. No action needed. |
| RetryExhausted | A transient fault persisted for all 3 attempts. Fix the upstream (health, configuration, outage), then retry manually. |
| Yellow "Some data could not be refreshed" notice | One section (often Mock CRM source orders) failed to refresh; the rest of the page is live. It shows when that section last loaded. Check the named service; the notice clears on the next successful refresh. |
| "Integration Hub API is unreachable" | The browser cannot reach the middleware. Check `docker compose ps` or the native launcher, and port 5100. |
| Native build or tests fail with "Application Control policy has blocked this file" | Windows Smart App Control or WDAC is blocking freshly built unsigned DLLs. Use Docker, or a machine or CI runner without that policy. Do not disable security controls on managed devices. |

Manual retry clears the configured simulation. It does not fix a real data conflict, repair configuration, or replace an already-frozen payload. If a mapped order genuinely needs an amendment, design an explicit versioned update workflow rather than changing its idempotency identity.

Local startup health endpoints indicate process availability, not full dependency readiness. Recheck CRM/ERP when an integration cannot connect. The demo has no external status or scheduling integration.
Windows and Docker Desktop specifics: [WINDOWS_TESTING.md](WINDOWS_TESTING.md#troubleshooting-on-windows).
