# Enterprise Integration Hub — portfolio description

## Short profile version

Built a synthetic enterprise integration platform using ASP.NET Core, Angular and SQLite. Implemented CRM-to-ERP REST communication, JSON validation and mapping, persistent execution history with an attributed audit trail, bounded retries that hold across crashes, duplicate prevention, JWT role-based access and a responsive troubleshooting dashboard that tolerates partial upstream outages. Added automated backend and browser tests with GitHub Actions.

## Project narrative

Enterprise integrations need more than a successful HTTP request. Operators need to identify an execution, understand the stage that failed, distinguish transient faults from invalid data, and retry without duplicating accepted transactions.

This project models that lifecycle with three independently hosted applications: a fictional CRM, middleware and a fictional ERP. The middleware records each execution in SQLite, transforms decimal order totals to integer minor units, classifies upstream failures and schedules bounded retries. The ERP persists an idempotency record and payload fingerprint so repeated requests can return the same receipt.

The Angular console brings together execution metrics, history, filters, detailed stage logs, a timeline and operator-only retries. A read-only role demonstrates server-side authorization. A separate fictional workload module supports DEV/TEST job-history monitoring and failed-job investigation.

## Evidence to show

- Trace a successful order from source JSON to ERP receipt.
- Demonstrate 503 recovery and 400 investigation.
- Explain the unique order index, frozen payload and idempotent acceptance boundary.
- Review tests for mapping, retries, validation, authorization and duplicate handling.
- Show the actual CI run rather than claiming unverified test success.
- Stop the mock CRM and show that execution history and investigation stay available behind a non-blocking warning.
- Walk through the audit timeline: who queued and retried, each attempt "n of 3", and how crash recovery respects the retry budget.
- Discuss the single-replica SQLite design and the changes needed for a production rollout.

## Accurate experience statement

“This portfolio is a personal simulation demonstrating integration development and troubleshooting techniques. It is not an implementation of Oracle Integration Cloud, Dell Boomi or ESP dSeries. My actual dSeries experience concerns monitoring job statuses and executions in lower environments, not creating schedules or automation scripts.”

No employment outcomes, client deployments, transaction volumes, certifications or vendor-platform implementation experience are implied.
