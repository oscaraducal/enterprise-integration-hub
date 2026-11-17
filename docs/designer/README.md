# Integration Designer (Milestone C)

> **Milestone C.1 update:** integrations now start from a New Integration wizard with a blank canvas. There are reusable Connections, endpoint wizards, mapping points, an inline + picker, and Vertical, Horizontal and Outline layouts. See [WORKBENCH.md](WORKBENCH.md).

An original visual workbench for designing integration flows between the fictional **Legacy CRM** and **Modern ERP**. It borrows widely used orchestration ideas: a trigger, invoke, assign, map, branching, loops, scopes with fault handlers, staged files and versioned designs. The interface, code and names are the portfolio's own. It is **not** Oracle Integration Cloud, not a vendor replacement and not a visual clone.

> **Milestone C designs, validates and versions flows. Nothing executes yet.** The Execution tab says so. Milestone D adds a bounded executor for the core actions, using only the synthetic CRM and ERP APIs.

## How a flow is modelled

```
Trigger ─▶ step ─▶ step ─▶ Switch ─┬─ Case A ─▶ steps…
                                    └─ Otherwise ─▶ steps…
          ─▶ For Each (body ─▶ steps…) ─▶ Scope (body…, fault handler…) ─▶ Return
Global fault handler ─▶ steps…
```

- A flow is a **structured tree**. The order of steps is the connection, so every graph is well-formed (no dangling edges or cycles).
- **Containers** (Switch, For Each, While, Scope, Parallel) own named child sequences. You can drop actions into any of them.
- Each action's **name is also its output variable**: an Invoke named `readCustomer` produces `$readCustomer`.
- **Scoping:**
  - Variables defined inside a branch or loop body exist only there.
  - `$order` (a For Each item) is unknown after the loop.
  - `$fault` exists only inside fault handlers.
- The definition is JSON (`schemaVersion: 1`) stored in the Hub's SQLite database. The size limit is 256 KB, with at most 150 actions and 6 nesting levels.

## Using the designer

| Area | What you can do |
|---|---|
| **Palette** (left) | Actions grouped by category. Drag one onto a `+` slot, or click it to insert after the selected action. Planned items are shown but disabled. |
| **Canvas** (centre) | Select, drag to move (including into or out of containers), collapse/expand containers, zoom, fit to screen, full screen. Search highlights matches; press Enter to step through them. |
| **Properties** (right) | Per-action configuration, the variables in scope at that point, and that action's problems. |
| **Bottom panel** | Problems (click to jump to the action), Variables, Versions (export, load into draft), JSON, Execution (placeholder until Milestone D). |
| **Toolbar** | Undo/redo (100 steps), copy/paste (fresh IDs and names), move up/down, delete, save draft, publish, import, export. |

**Keyboard shortcuts:** Ctrl+Z / Ctrl+Y undo and redo, Ctrl+C / Ctrl+V copy and paste, Delete removes the selected action, Alt+↑ / Alt+↓ moves it.

**Roles:** Viewers can open, inspect and validate designs. Operators create, edit, save, publish and import. The server enforces both.

### Drafts and versions
- **One editable draft per flow.** Saving uses an optimistic-concurrency revision: a stale save returns 409, and the UI offers to reload. Incomplete drafts can be saved; the report lists what blocks publishing.
- **Publish** validates the saved draft on the server. Only a valid graph becomes **version n+1**, and versions are immutable. Publishing is refused (503) if a catalog could not be reached to verify tables.
- **Load into draft** copies a published version into the editor. Versions themselves never change.

### Import and export (`eih-flow`)
```json
{ "format": "eih-flow", "formatVersion": 1, "name": "customer-sync", "title": "…", "description": "…",
  "source": "version 1", "exportedAt": "…", "definition": { "schemaVersion": 1, "trigger": {…}, "steps": […], "globalFaultHandler": […] } }
```
Imports always create a **new draft** under a name you choose. They never overwrite an existing flow or a published version.

## Expressions and functions

Expressions are parsed by a small, original parser into an AST. They are **never evaluated as code** (no JavaScript, no SQL).

- **Literals:** `'text'`, `"text"` (double the quote to escape it), numbers, `true`, `false`, `null`.
- **Variables:** `$name` or `$name.field`. Fields are checked against the CRM and ERP catalog schema. Collections must be iterated with For Each, or used with `count`, `sum` or `first`.
- **Operators:** `+ - * /`, `== != < <= > >=` (comparisons don't chain), `and or not`, and parentheses.
- **Functions** (allowlisted, with arity checks):

| Category | Functions |
|---|---|
| String | `concat`, `upper`, `lower`, `trim`, `length`, `substring`, `contains`, `startsWith`, `endsWith`, `replace` (plain text) |
| Math | `round`, `floor`, `ceil`, `abs`, `min`, `max` |
| Conversion | `toNumber`, `toString`, `toBoolean` |
| Date | `now`, `today`, `formatDate` (allowlisted formats), `addDays` |
| Boolean | `if`, `coalesce`, `isEmpty` |
| Collection | `count`, `sum(collection, 'field')`, `first` |
| Lookup | `lookup('table', key, default?)`: named lookup tables arrive in Milestone E |

The **Expression Builder** (ƒx next to every expression field) inserts in-scope variables and their fields, functions by category, and operators, and runs **Check syntax** on the server.

## Field mapper (Map action)
- **Opening it:** choose the Map's input variable (an Invoke output or a For Each item) and a target table, then click **Open field mapper**.
- **Connecting fields:** drag a source field onto a target field, or click a source field and then a target field. Each connection draws a line and chooses a transformation from the two types: Lowercase for emails, Multiply × 100 for minor units, Lookup for enums, and so on.
- **Transformations** are allowlisted: Copy, Trim, Uppercase, Lowercase, Concatenate, Default, ToNumber, Multiply, Divide, FormatDate, Lookup. Parameters are edited in place.
- **Suggest, Validate and Preview** reuse the Milestone B schema-mapping engine. Preview runs on a real first source row and writes nothing.
- **Hidden targets:** target fields set by the application (e.g. `origin` and `lastExecutionId` on `customer_master`) are listed but cannot be mapped.

## Action reference

Statuses: **Designable** means configurable and validated now, and executes from Milestone D. **Planned** means listed in the palette but not usable yet. **Unsupported** means out of scope for this portfolio.

| Action | Status | Business purpose (guided scenario) | Configuration and validation rules |
|---|---|---|---|
| Trigger | Designable | Start a run for one business key, e.g. `customerId = C-300` (DSN-001) | Up to 10 typed parameters (string, integer, decimal, boolean, date); referenced as `$trigger.x` |
| Invoke | Designable | Read the source record; deliver to the target (DSN-001) | Fixed system allowlist (crm, erp); the table must exist; operations per table: CRM built-ins list/get; `customer_master` list/get/upsert; `imported_orders` list/get/create; logical tables list/get/create/update. Writes need an input with the table's schema; ERP writes are flagged as such |
| Assign | Designable | Prepare labels and totals (DSN-001, DSN-003) | 1–20 assignments; letter-first names; expressions validated; can't overwrite record or collection variables |
| Map | Designable | Transform a CRM record to the ERP schema (DSN-001, DSN-002) | Input must hold table records; rules validated against both schemas; required target fields must be mapped |
| Logger | Designable | Leave an audit trail in the execution log (DSN-003) | Level info/warning/error; message expression |
| Note | Designable | Explain business intent on the canvas | 1–1000 characters; never executes |
| Wait | Designable | Respect a downstream pacing rule | 1–60 seconds; warning inside loops |
| Stage File | Designable (write, read, list) | Produce a partner XML/JSON/CSV file (DSN-002) | Sandboxed names only (`^[A-Za-z0-9][A-Za-z0-9_-]{0,59}\.(xml|json|csv)$`, no paths); the extension must match the format; XML root and record element names; write needs a record or collection |
| Stage File: read in segments, zip, unzip, encrypt, decrypt | Planned | — | Visible as disabled operations |
| Switch | Designable | Route by business rule, e.g. missing email or unsupported currency | 1–10 cases with conditions, exactly one Otherwise, last |
| For Each | Designable | Process a batch of orders (DSN-003) | Collection variable; new item name; 1–500 items |
| While | Designable | Poll or retry with a bound | Condition; 1–1000 iterations |
| Scope | Designable | Contain a risky step with local fault handling (DSN-003) | Body + fault handler; `$fault.code`, `$fault.message`, `$fault.nodeId` in the handler |
| Parallel | Designable | Independent branches (Milestone D runs them one after another, bounded) | 2–5 branches |
| Throw New Fault | Designable | Stop on a business rule (MissingEmail) | Fault code identifier; message expression |
| Re-throw Fault | Designable | Pass a handled fault outward | Only inside a fault handler |
| Global Fault Handler | Designable | Log and return a clean failure (DSN-001) | Lane below the main flow; `$fault` in scope |
| Scope Fault Handler | Designable | See Scope | — |
| Return | Designable | End successfully with an output | Optional output expression; later steps are unreachable |
| Fault Return | Designable | End with a named failure | Code and message |
| Stop | Designable | End immediately | Later steps are unreachable |
| Data Stitch, Data Translate | Planned (Milestone E) | Merge partial payloads, convert formats | — |
| Integration Call, Safe Functions, Callback | Planned (Milestone E) | Call published flows, reusable function libraries (no executable JavaScript), async response | — |
| Notification, File Server, Decision, Publish Event, Human Approval | Planned (future) | Would need local simulators | — |
| B2B, Healthcare, Process, Robot Flow, Cloud Functions | Unsupported | Out of scope: no external services | Listed for completeness only |

## Feature status (Milestone C)

| Backlog item | Status | Notes |
|---|---|---|
| Action palette | **Implemented** | 18 designable actions, 15 planned or unsupported shown as such |
| Drag-and-drop canvas | **Implemented** | Palette → slot, action → slot (move), nested lanes |
| Node properties | **Implemented** | Per-action forms with scoped variable pickers |
| Add, edit, delete, reorder, connect | **Implemented** | Order is the connection; move up/down; drag to move |
| Expand/collapse nested actions | **Implemented** | Shows the number of actions inside |
| Zoom and fit to screen | **Implemented** | 40–150 %, fit, full screen |
| Undo/redo, copy/paste | **Implemented** | 100 steps; fresh IDs and names on paste |
| Search nodes | **Implemented** | Highlight and step through |
| Graph validation | **Implemented** | Server-side, live; per-action badges and the Problems panel |
| Draft and published versions | **Implemented** | Optimistic concurrency; immutable versions |
| Save/load | **Implemented** | Flow picker, unsaved-changes guard |
| Import/export (`eih-flow`) | **Implemented** | Imports never overwrite |
| Mapper: schema discovery, drag-and-drop, connection lines | **Implemented** | From the live catalogs |
| Mapper: Expression Builder; string/math/Boolean/conversion/date/collection functions | **Implemented (design-time)** | Parsed and checked; evaluated from Milestone D |
| Mapper: lookup transformations | **Implemented** | Inline value lookups; named lookup tables are planned (Milestone E) |
| Mapper: nested collections | **Planned** | Flat records only; nested line items arrive with SCN-005 |
| Mapper: validation, preview, versioned definitions | **Implemented** | Reuses Milestone B; flows version their inline rules |
| All actions in the table above | **Design only** | Configurable and validated; none execute in Milestone C |
| Runtime: safe execution engine, per-action trace, execution IDs, node timing, logging, retries, idempotency, test mode | **Planned (Milestone D)** | The existing SCN-001…003 runner, retries and idempotency are unchanged |
| Advanced conditions, loops at runtime, staged-file I/O, lookup tables, scheduling | **Planned (Milestone E)** | — |
| B2B, Healthcare, Process, Robot Flow, OCI-style functions | **Unsupported** | No external or paid services |

## Safety
- No arbitrary SQL, executable JavaScript or external HTTP destinations. Invoke targets are a fixed allowlist of the two fictional systems' catalog tables.
- Designing reads only catalog metadata (`GET /api/catalog/tables`). A backend test records every upstream call to prove it, and that no execution is created.
- Stage File names can't contain paths; files will live in a per-execution sandbox (Milestone D).
- The service key stays server-side. Roles are enforced by the Hub.

## Guided scenarios
In the app: **Guides → DSN-001, DSN-002, DSN-003** (also listed under **Scenarios** as *Design only*).
1. **DSN-001: Design the customer master flow.** Template, inspect actions, re-map by drag-and-drop, validate, publish, export.
2. **DSN-002: Stage a CRM order as an XML file.** Stage File rules, sandboxed names, planned operations.
3. **DSN-003: Loops, branches, scopes and faults.** Scoped variables, collection functions, the Expression Builder, fault-handler rules.
