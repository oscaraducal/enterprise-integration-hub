# Integration Workbench (Milestones C.1 and C.2)

Milestone C.1 makes authoring feel familiar to integration developers used to orchestration tools such as Oracle Integration 3. It keeps this project's own branding, components and code, and stays local-only. **Nothing executes yet**: running flows is Milestone D.

## Concepts researched and how they are adapted

| Concept in Oracle Integration 3 documentation | Here (original implementation) |
|---|---|
| Integration styles **Application** (an adapter trigger starts it) and **Schedule** (the trigger is a schedule) ([styles](https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/understand-integration-styles.html)) | New Integration wizard: **Application**, **Scheduled**, plus our own **Manual practice** mode |
| Identifier generated from the name in upper case; version `xx.xx.xxxx`, default `01.00.0000` ([create](https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/create-integrations.html)) | Same conventions: `CUSTOMER_SYNC`, `01.00.0000`, plus description and tags |
| Connections created separately with name, identifier, adapter and a role (Trigger, Invoke, or both, limited by the adapter), tested, then saved and reused ([connections](https://docs.oracle.com/en/cloud/paas/application-integration/database-adapter/create-connection.html)) | Connections workspace with a 9-step wizard. REST only, roles limited per application, safe tests, reused by any integration |
| REST endpoint wizard: endpoint name, relative resource URI, HTTP method; no request payload for GET/DELETE; pages appear by selection; query/template parameters configured before mapping ([REST invoke](https://docs.oracle.com/en/cloud/paas/application-integration/rest-adapter/add-rest-adapter-invoke-connection.html)) | Invoke and trigger endpoint wizards. Only operations the internal API really supports; GET never has a body; path parameters come from the path |
| Maps added when a trigger or invoke is configured, initially unconfigured, deletable; ad-hoc maps allowed ([triggers and invokes](https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/define-inbound-triggers-outbound-invokes.html)) | Mapping points: an unconfigured **request mapping** is placed before an Invoke whose operation sends a body. Response, trigger-response and file-structure mappings are added on request. Explicit Map actions remain |
| Canvas layouts **Vertical**, **Horizontal** and an **Outline** view with indented child actions and details ([canvas](https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/create-orchestrated-integration.html)) | Vertical, Horizontal and Outline layouts. The choice is stored per viewer, outside the flow |
| Schedules: simple frequencies or iCal, plus schedule parameters ([schedule](https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/define-integration-schedule.html)) | Design-time schedule: manual, daily, weekly or monthly, time, weekdays, day of month, IANA time zone, parameters. No iCal and no background jobs |

## Workflow

1. **Connections:** create `LEGACY_CRM_REST` and `MODERN_ERP_REST` (role Invoke) and a Hub REST trigger connection (role Trigger). Each wizard lists only approved internal applications. The Hub resolves addresses and keys, which never reach the browser.
   ![Connections workspace](../screenshots/workbench-connections.png)
2. **New integration:** choose Application, enter the name (the identifier is generated) and create. The canvas holds **only** the Start trigger and a `+`.
   ![A blank Application integration](../screenshots/workbench-blank-integration.png)
3. **Configure trigger…:** choose the Trigger connection, method, internal path (e.g. `/accounts/{customerId}`), parameters, and request and response schemas. Design-time only: the endpoint is not activated.
4. **`+` → Connections / Invokes:**
   - Choose a connection, an HTTP method the application supports, a business object, then review the request and response contracts and set the parameters.
   - Operations with a body get an unconfigured **request mapping** directly before the Invoke.
   ![Request mapping point before an Invoke](../screenshots/workbench-mapping-points.png)
5. **Map** the request with the field mapper. Its target contract is locked to the endpoint.
6. **Review** in Vertical, Horizontal or Outline. Outline shows each action's type, connection and operation, schema, mapping status, validation and summary.
   ![Outline layout](../screenshots/workbench-layout-outline.png)
   ![Horizontal layout](../screenshots/workbench-layout-horizontal.png)
7. **Save the draft.** Incomplete drafts are allowed; publishing requires a valid graph.

## Rules worth knowing

- **Inline `+`** works in every lane: the main flow, Switch cases, loop bodies, Scope body and fault handler, Parallel branches and the global fault handler. Unavailable actions explain why:
  - *planned*;
  - *Re-throw Fault only inside a fault handler*;
  - *End actions only at the end of a path*.
- **Every Invoke goes through the endpoint wizard,** whether you drag it in, click it in the palette or pick it from `+`.
- **Changing an endpoint never deletes mapping rules.** If the new operation has no body, or targets another table, an impact dialog asks how to proceed: retarget the mapping or keep it. The mapping is then reported in Problems until reviewed, and publishing stays blocked until the flow is valid.
- **Existing designs keep working.**
  - Flows created before C.1 open as *Manual practice*.
  - Invokes without a connection still validate, with a warning.
  - The `eih-flow` export now carries style, identifier, version and tags; older documents import as Manual practice.
- **Blank means blank.** The former "Blank flow" template no longer adds a Return; a blank integration has no business actions.

## Connection Manager safety

- Applications are an allowlist: Legacy CRM, Modern ERP, Data Catalog metadata and the Integration Hub REST trigger. There is no URL field.
- Tests perform only `GET /health` and `GET /api/catalog/tables` (or a local check for the Hub trigger). Tests verify this by recording every upstream call.
- Deleting a connection, or changing its role, is refused while any draft or published version uses it.
- Operators manage connections; Viewers inspect metadata.

## Feature status (C.1)

| Feature | Status |
|---|---|
| New Integration wizard (type, name, identifier, version, description, tags) and blank canvas | Implemented |
| Starter templates as an optional choice (Manual practice) | Implemented |
| Connections workspace and 9-step wizard, CRUD, safe test, operation and schema discovery | Implemented |
| Invoke endpoint wizard (connection, method, business object, contracts, parameters, summary) | Implemented (design-time) |
| Application REST trigger wizard (method, internal path, parameters, request and response schemas) | Design only: no endpoint is activated |
| Scheduled trigger (manual, daily, weekly, monthly, time zone, parameters) | Design only: no background job |
| iCal schedule expressions | Deferred |
| Request, response, trigger-response and file-structure mapping points; impact detection | Implemented (design-time) |
| Inline `+` picker with categories and reasons; drag-and-drop kept | Implemented |
| Vertical, Horizontal, Outline layouts with per-viewer preference | Implemented |
| Data Catalog metadata invokes | Implemented (design-time) |
| SOAP, FTP, Database adapters; external URLs | Unsupported in this practice environment |
| Running integrations, activating endpoints, scheduling jobs | Deferred to Milestone D and later |

## Milestone C.2: dedicated integration workspace

Oracle Integration 3 separates design work (Integrations, Connections, Lookups) from observability (Instances, Errors) and from the business applications it connects ([navigation](https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/navigate-oracle-integration.html), [projects workspace](https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/tour-projects-workspace.html)). Its inline **+** menu offers Suggestions, Invokes and Actions with a search field, then opens the configuration wizard for the choice ([inline menu](https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/add-actions-through-inline-menu.html)). C.2 applies the same separation with original UI and code.

### Navigation

| Workspace | URL | Pages |
|---|---|---|
| Legacy CRM (source system) | `/crm`, `/crm/{section}` | Dashboard, Customers, Sales Orders, Data Tables, API Explorer |
| Integration Workbench | `/workbench/...` | Overview, Integrations (`/integrations`, Designer at `/integrations/{name}`), Connections, Mappings, Monitoring (Executions, Workloads), Guides (catalog, step-by-step) |
| Modern ERP (target system) | `/erp`, `/erp/{section}` | Dashboard, Customer Master, Sales Orders, Imported Data, Import History, Data Tables, API Explorer |

- The **workspace switcher** in the top bar shows which application you are in (and its accent colour).
- Each workspace has its own sidebar. On phones the sidebar is a drawer behind the menu button.
- These are logical workspaces in one Angular app. They use the same sign-in, JWT roles and backend authorization.
- URLs come from Angular Router, so back/forward and reloads restore the workspace, page and focused record (`?kind=customer&id=C-300`).

![Integration Workbench overview](../screenshots/workbench-overview.png)

### Pages

- **Overview.** Quick actions: Create integration, Browse integrations, Create connection, Open Connection Manager, Open Mapping Studio. It also shows:
  - integration, draft, published and configured-connection counts;
  - recent designs;
  - connection health;
  - integrations with validation errors;
  - the latest runs of the built-in sample integrations.

  Every number comes from the API. Designed integrations are never shown as executed.
- **Integrations.** Name, identifier, version, type, status, last update and validation, with search and filters. Actions per row:
  - **Open** enters the Designer.
  - **Details** shows metadata and version history (each version can be exported).
  - **Duplicate** copies the saved draft into a new unpublished integration. Operators only, and the original is untouched.
  - **Export.**

  Import and the New Integration wizard (Application, Scheduled, Manual practice; Blank by default, starter templates optional) live here too.

  ![Integrations list](../screenshots/workbench-integrations.png)
- **Connections.** The Connection Manager and its 9-step wizard, reachable without opening a design.
- **Monitoring.** Execution metrics, the run console, history, investigation and retry, plus the Workloads tab.
- **Full-screen Designer.** Top bar with Back to Integrations, breadcrumb, name, identifier, version, publish and validation status, Save, Publish and Export. Below it:
  - a collapsible palette;
  - the canvas;
  - properties;
  - the Problems, Variables, Versions, JSON and Execution panel (design-only until Milestone D).

  The workspace sidebar is hidden while the Designer is open.
- **Leaving with unsaved changes** (Back, the workspace switcher, browser back) asks first:
  - **Save draft and leave**;
  - **Keep changes for later**: kept in this browser tab and restored when you reopen the integration, cleared at sign-out;
  - **Discard changes**;
  - **Stay**.

  Closing the tab warns as well.

### Add action popup

**Root cause of the C.1 defect.** The picker was an `ng-template` rendered inside the canvas list, directly after the `+` slot. It was a 520 px, multi-column panel in normal flow (`position: relative`), so opening it pushed the following actions down and widened the lane. In the Horizontal layout it was patched with an absolute offset. The open `+` also reused the drag-over style, which grows the slot from 22 px to 36 px.

**Fix.** The popup is now an Angular CDK overlay with a flexible connected position strategy:

- **Anchoring:** it attaches to the clicked `+` and is rendered in the overlay container, outside the canvas. It opens beside the `+` in Vertical and below it in Horizontal, with fallback positions and push near screen edges.
- **Scrolling and zoom:** it repositions while the canvas scrolls (the canvas is registered as a `cdkScrollable`) and when zooming.
- **Closing:** Escape closes it and returns focus to the `+`. Clicking outside also closes it. Only one popup is open at a time.
- **Keyboard:** the search box gets focus when it opens, and arrow keys move between results.
- **Phones:** under 640 px it becomes a bottom sheet.

The open `+` is highlighted without changing size. Browser tests compare the position and size of every action before and after opening, in both layouts.

**Content:**

- **Header:** "Add action", then a search box ("Search actions and connections").
- **Tabs:** **Suggestions**, **Invokes** and **Actions**.
- **List:** a single-column list with an icon, name, description and, for unavailable items, the reason. A Map is unavailable where no record or collection is in scope.

Choosing an item remembers the slot, closes the popup and inserts exactly one action, which is then selected and focused. An Invoke opens the endpoint wizard first, and a body operation adds its request mapping.

![Add action popup anchored to a + in the Vertical layout](../screenshots/workbench-popup.png)

### CI regression found in run 44087328277

The *Nested logic* test typed `$order.id` into the Logger message right after selecting `logSummary`. The app is zoneless, so the properties panel was still bound to the previously selected `logReady`, where `$order` is in scope. The edit therefore went to the wrong action and no error appeared. The CI page snapshot shows `logReady` with `info: $order.id` and `logSummary` unchanged.

Variable-scope validation had not regressed. The test now waits for the panel to show `logSummary` before typing, and still asserts `unknown variable $order`.

Separately, the Designer now applies only the newest validation response, so a slow earlier check can no longer overwrite a newer report.

### Status (C.2)

| Feature | Status |
|---|---|
| Workspace switcher, per-workspace navigation, router URLs, back/forward | Implemented |
| Workbench overview from real data | Implemented |
| Integrations page: search, filters, details, versions, duplicate, import/export, create | Implemented |
| Full-screen Designer with back navigation and unsaved-change handling (save, keep, discard, stay) | Implemented |
| Anchored Add action popup (Suggestions, Invokes, Actions, search, keyboard, bottom sheet) | Implemented |
| Running designed integrations, activating triggers, schedules | Deferred to Milestone D and later |
