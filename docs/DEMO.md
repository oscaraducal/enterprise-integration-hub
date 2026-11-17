# Five-minute portfolio walkthrough

## 1. Explain the boundary

“This is a synthetic integration platform I built to demonstrate REST API integration, mapping, monitoring and troubleshooting. It uses separate mock CRM and ERP APIs. It is not an Oracle Integration Cloud, Boomi or dSeries implementation.”

## 2. Show a successful transaction

Log in as operator. Select ORD-001 and None. Run the integration. Show Pending/Running/Completed in the console, then the Retrieved → Mapped → Completed stages.

Explain the source decimal amount and target integer minor units. Point out the unique execution ID, receipt and database-backed history.

## 3. Show a recoverable failure

Use ORD-002 with Unavailable, target ERP and one failing attempt. Show RetryScheduled followed by successful completion. Explain the bounded exponential delay and three-attempt cap.

## 4. Investigate a permanent failure

Use ORD-003 with BadRequest. Open the error class, controlled troubleshooting message and timeline. Click Safely retry execution; explain that the demo clears the fault while retaining the source ID and mapped payload.

Submit the same source order again and show the 409 behavior. Explain that ERP also checks a unique ID and payload fingerprint so a lost response can be reconciled without a second acceptance.

## 5. Show resilience during an upstream outage (optional, Docker)

Run `docker compose stop crm`. Point out the yellow partial-outage notice: history, metrics and investigation keep working, which is exactly what an operator needs during an incident. Run a new order: it shows `RetryScheduled` and then `RetryExhausted` with a Connection classification. Run `docker compose start crm`, then retry it safely.

To show crash recovery, start a Timeout execution with three failing attempts. Run `docker compose kill hub` and then `docker compose start hub`, and open the timeline. `RecoveryScheduled` or `RecoveryExhausted` shows that the 3-attempt budget held across the restart.

## 6. Demonstrate monitoring and scope

Search by execution ID, filter failed executions, switch themes, then open Workloads. Simulate a TEST failure and inspect its history.

Describe the workload module accurately: it reflects familiarity with monitoring statuses and executions in lower environments. It does not claim experience creating ESP dSeries schedules or automation scripts.

Sign in as viewer and demonstrate read-only permissions. End with the test workflow, architecture diagram and limitations.

## Before recording

Use fresh synthetic data, avoid displaying .env or tokens, and review actual CI results. No employer names, screenshots, endpoints or records belong in this demonstration.
