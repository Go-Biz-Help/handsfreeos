# HandsFreeOS CRM Migration Platform

## Comprehensive implementation plan — GoHighLevel source adapter

**Status:** Product and engineering plan; five product decisions remain open  
**Primary source adapter:** GoHighLevel / HighLevel (GHL)  
**Target platform:** HandsFreeOS (HFOS)  
**Last updated:** September 17, 2026  
**Audience:** Product, design, engineering, QA, support, and implementation partners

---

## 1. Executive summary

HandsFreeOS should build a reusable **CRM Migration Platform**, not a one-off GHL importer. GoHighLevel is the first source adapter, but scanning, normalization, dependency handling, merging, importing, verification, incremental synchronization, and rollback must be source-agnostic.

The customer experience should be:

> Connect GoHighLevel, let HandsFreeOS find and count everything, choose what to bring over, review anything that is not a perfect match, import it, reconnect external services, verify the result, transition safely, and then disconnect GoHighLevel.

The defining requirement is not merely that historical data exists after import. It must feel as though the business had been using HandsFreeOS when the history was created:

- Preserve original timestamps, chronology, direction, authorship, ownership, status, relationships, and source structure wherever the source exposes them.
- Render imported conversations, calls, emails, appointments, opportunities, notes, and financial events in the normal HFOS experiences—not in a separate legacy archive.
- Copy retrievable media into HFOS-controlled storage so history does not break after GHL is canceled.
- Retain invisible source metadata for traceability, retries, deduplication, transition sync, verification, support, and rollback.

The platform must support both:

1. A single GHL location/sub-account.
2. A GHL agency with many selectable locations.

The import must be resumable, idempotent, category-selectable, dependency-aware, verifiable, and safely reversible. It must also support a one-way **Transition Mode** in which GHL remains the source of truth while HFOS incrementally imports new and changed records until final cutover.

---

## 2. Product goals

### 2.1 Primary goals

1. Make leaving GHL for HFOS low-risk and understandable for a non-technical customer.
2. Import every retrievable, in-scope category that HFOS can faithfully represent.
3. Preserve historical fidelity: timestamps, owners, participants, structure, statuses, files, and relationships.
4. Detect compatibility gaps before import and explain them clearly.
5. Allow the customer to select categories and, where useful, individual resources.
6. Automatically resolve dependencies instead of requiring the customer to understand the data graph.
7. Avoid duplicates across reruns, retries, transition syncs, and repeated imports.
8. Make large imports resumable and retryable by category and item.
9. Provide evidence that the migration succeeded through counts, integrity checks, exceptions, and downloadable reports.
10. Create a reusable framework for future adapters such as HubSpot, Salesforce, Jobber, Housecall Pro, ServiceTitan, and Follow Up Boss.

### 2.2 Product principles

- **Native, not archived:** Imported history belongs in normal HFOS screens and timelines.
- **Everything selected by default:** The happy path is “Import everything,” with controls available for selective migration.
- **Scan before mutation:** Discovery and compatibility analysis are read-only.
- **Explain, do not surprise:** Show dependencies, gaps, reconnect steps, and irreversible external actions before import.
- **Preserve before transform:** Keep the source record and raw source payload so mappings can be audited and improved.
- **One source identity, one HFOS identity:** Reprocessing the same source object must not create another target record.
- **Failure isolation:** One bad item or category must not restart or invalidate the whole migration.
- **Safe cutover:** GHL remains authoritative during Transition Mode; finalization includes a last reconciliation pass.
- **No false promises:** Distinguish “HFOS cannot represent this” from “GHL did not expose this.”

### 2.3 Success metrics

Track at least:

- Connection completion rate.
- Scan completion rate and median scan duration.
- Import start and completion rates.
- Category-level import success rate.
- Record success rate and media-copy success rate.
- Count and percentage of imports with compatibility findings.
- Retry recovery rate.
- Duplicate rate after verification.
- Referential-integrity failure rate.
- Transition sync lag and reconciliation drift.
- Rollback success rate.
- Time from connection to final cutover.
- Frequency of unsupported source capabilities across real accounts.
- Support tickets per migration and top failure signatures.

---

## 3. Locked product requirements

These requirements are settled and should be treated as non-negotiable unless product explicitly changes them:

1. Support both GHL agencies and individual GHL locations.
2. Support a transition period rather than only a one-time import.
3. Preserve original historical timestamps.
4. Preserve GHL structure wherever possible, including calendars, pipelines, stages, forms, fields, tags, and ownership relationships.
5. Do **not** import or recreate GHL workflows/automations. HFOS should remain as workflow-free as possible.
6. Anything that cannot translate exactly becomes a clearly explained **Needs Review** finding; compatible portions should still import.
7. Run a compatibility scan before import.
8. Use scan results to identify missing HFOS capabilities.
9. Support both category-level selection and drill-down selection of individual resources where useful.
10. Automatically select and explain required dependencies.
11. Merge duplicate contacts rather than blindly skipping or duplicating them.
12. Store original source IDs and source metadata.
13. Imported conversation history must feel native to HFOS.
14. Copy retrievable media into HFOS-controlled storage.
15. Import all accessible call data, metadata, recordings, transcripts, and relationships.
16. Import all accessible email content, metadata, events, attachments, campaign attribution, and threading.
17. Include marketing and CRM assets, including standalone landing-page assets when they are not part of a website/funnel object. Websites and funnels themselves are deferred.
18. Recreate calendars and import historical and future appointments, schedules, assignments, and related settings.
19. Recreate pipelines/stages and import opportunities with their history and associations.
20. Import the deepest accessible financial history, including recurring financial records, but do not clone payment credentials.
21. Include “Action Required” steps to reconnect payment infrastructure.
22. Discover phone numbers and start/track a provider-level porting process.
23. Provide an email/domain migration checklist, including DNS changes.
24. Import users as identities, preserve their history and ownership, and let an admin choose whom to invite.
25. Preserve ownership assignments across imported records.
26. Detect source integrations and create a reconnect checklist; do not copy authorization tokens.
27. Include accessible reputation/review data.
28. Include notes, tasks, completed tasks, and accessible activity/audit history.
29. Imports must be resumable and individual categories must be retryable.
30. Provide a detailed completion and exception report.
31. Support rollback without deleting HFOS data that predated the migration.
32. Build a CRM-agnostic migration framework with GHL as the first source adapter.
33. Compare source features with HFOS capabilities and aggregate compatibility gaps for product planning.
34. Keep the customer experience simple even when the underlying migration is complex.

---

## 4. Scope boundaries

### 4.1 In scope

The scanner should inventory and the importer should support, wherever GHL exposes sufficient data:

- Agencies and locations/sub-accounts.
- Users, roles, and historical ownership.
- Contacts, businesses/companies, addresses, additional phone numbers/emails, DND/consent state, tags, custom fields, and custom values.
- Conversations, messages, internal comments, SMS/MMS, email, calls, voicemail, Facebook messages, Instagram messages, WhatsApp, Google Business messages, live chat, and other exposed channels.
- Attachments, recordings, transcripts, media, uploads, and documents.
- Forms, surveys, submissions, and uploaded answers.
- Email/SMS/WhatsApp templates, standalone landing-page assets not modeled as websites/funnels, and email campaigns, including retrievable campaign statistics.
- Calendars, availability, resources, appointments, blocked time, recurring rules, and statuses.
- Pipelines, stages, opportunities, values, statuses, ownership, notes, and history.
- Tasks, notes, completed tasks, and activity events.
- Products, prices/price books, payment links, orders, estimates, invoices, recurring invoices, subscriptions, transactions, payments, refunds, taxes, discounts, coupons, receipts, and statuses.
- Reviews, review requests, reputation templates/settings/history, where accessible.
- Integration inventory and reconnect requirements.
- Phone-number inventory and porting workflow.
- Sending-domain and email-infrastructure inventory and cutover checklist.
- Workflow inventory for analysis only; workflows are not imported.

### 4.2 Explicitly deferred

- Website migration.
- Funnel migration.
- Recreating GHL workflows or workflow actions as HFOS workflows.
- Bidirectional CRM synchronization.
- Copying third-party OAuth tokens, API keys, stored payment credentials, or processor secrets.
- Automatically canceling the customer's GHL account.

Websites and funnels should still be detected and counted so customers understand the boundary and HFOS can measure demand. If GHL represents a “landing page” as a page inside a website or funnel, it follows the website/funnel exclusion. A genuinely standalone marketing asset remains in scope.

### 4.3 Source-access caveat

“Everything” means everything that all of the following allow:

1. The source account contains.
2. The connected user is authorized to access.
3. GHL exposes through a documented API, approved export, webhook, or other permitted mechanism.
4. HFOS can legally and technically store.
5. The customer selects.

The UI and report must never imply that zero returned items proves zero items exist when access may be restricted. It must show whether each count is **complete**, **estimated**, **permission-limited**, or **not enumerable**.

---

## 5. Terminology

- **Migration:** One logical movement from one source installation to one or more HFOS workspaces.
- **Source installation:** One authorized GHL connection, at agency or location level.
- **Source scope:** A selected GHL location/sub-account within the installation.
- **Target scope:** The HFOS workspace/business receiving one source scope.
- **Category:** A user-selectable group such as Contacts, Conversations, or Invoices.
- **Source adapter:** Code that authenticates to a CRM, discovers capabilities, reads records, and maps them to canonical objects.
- **Canonical object:** CRM-neutral representation consumed by the HFOS import engine.
- **Source object:** An immutable or versioned staged representation of a record read from GHL.
- **Source identity:** Stable tuple that uniquely identifies a source object across scans and retries.
- **Compatibility finding:** A detected mismatch, limitation, permission gap, or action requirement.
- **Transition Mode:** One-way incremental GHL-to-HFOS synchronization after the initial import and before final cutover.
- **Finalization:** Last sync, verification, acknowledgement of remaining actions, and disconnection of continuous sync.
- **Rollback:** Removal or reversal of changes attributable to a migration, subject to safety rules.

Names in this document are proposed interfaces because no existing HFOS codebase or schema was supplied with this plan.

---

## 6. Customer experience and UX flow

### 6.1 Entry point

```text
Settings
└── Data & Migrations
    └── Migrate from another CRM
        └── GoHighLevel
```

The top-level migration list should show source, target workspace(s), started date, mode, progress, status, warnings, and available actions.

### 6.2 Step 1 — Connect GoHighLevel

> **Owner's decision, 2026-10-06:** HandsFreeOS is doing away with the GoHighLevel marketplace app. GoHighLevel
> connects with a private integration token (PIT) only, one sub-account per token, and the screens no longer offer
> the sign-in. An agency moving several sub-accounts connects each with its own token. What is left of the sign-in
> is described in `docs/operations.md`, "The GoHighLevel app, retired".

Use GHL OAuth with least-privilege read scopes plus webhook/install scopes required for Transition Mode. Never ask users to paste passwords.

Display:

- The GHL agency or location being authorized.
- The data scopes HFOS is requesting, in plain language.
- That the initial scan is read-only.
- That credentials are encrypted and can be revoked.

Connection outcomes:

- **Single location token:** Proceed directly to target workspace mapping.
- **Agency/company token:** Retrieve approved locations, then let the customer choose all or selected locations.
- **Insufficient scopes:** Continue with accessible categories, mark affected categories permission-limited, and offer **Reconnect with required access**.

### 6.3 Step 2 — Select locations and map workspaces

For an agency, show location name, source ID, address/timezone, accessible status, approximate size if available, and target mapping.

Example:

| Import | GHL location | Target HFOS workspace  | Status             |
| ------ | ------------ | ---------------------- | ------------------ |
| ✓      | Austin HVAC  | Create “Austin HVAC”   | Ready              |
| ✓      | Dallas HVAC  | Existing “Dallas HVAC” | Needs confirmation |
| —      | Sandbox      | None                   | Skipped            |

Requirements:

- Selection supports all, none, search, and bulk mapping.
- A source location must never leak into another target workspace.
- Each location runs as an independently checkpointed child migration.
- Agency-level progress is the aggregate of location jobs, but failures remain isolated.
- The default agency mapping remains one of the five open product decisions in Section 23.

### 6.4 Step 3 — Scan and inventory

The scan is read-only and should be safely rerunnable. It must:

1. Validate authorization and scopes.
2. Discover locations and source capabilities.
3. Enumerate or estimate category counts.
4. Sample schemas and variants needed for mapping analysis.
5. Discover dependencies and external integrations.
6. Compare source features/configurations with HFOS capabilities.
7. Estimate data volume, media bytes, migration duration range, and risks.
8. Produce category and item-level findings.

Inventory table:

| Category          |  Found | Count quality | HFOS capability | Default  | Notes                           |
| ----------------- | -----: | ------------- | --------------- | -------- | ------------------------------- |
| Contacts          | 18,421 | Complete      | Ready           | Selected | 72 possible matches             |
| Conversations     | 62,908 | Complete      | Ready           | Selected | Requires contacts               |
| Call recordings   |  5,822 | Complete      | Ready           | Selected | Estimated 31 GB                 |
| Calendars         |     12 | Complete      | Needs Review    | Selected | 1 setting approximated          |
| Stripe connection |      1 | Complete      | Action Required | Included | Reconnect after import          |
| Phone numbers     |      8 | Complete      | Port Required   | Selected | Porting is a separate process   |
| Workflows         |     32 | Complete      | Not Imported    | —        | Used only for behavior analysis |
| Websites          |      3 | Complete      | Not in V1       | —        | Detected, not imported          |
| Funnels           |     11 | Complete      | Not in V1       | —        | Detected, not imported          |

The UI must show when the displayed count is a source-provided total, a complete enumeration, or an estimate. Large scans can progressively update counts without blocking the whole screen.

### 6.5 Capability statuses

Use a capability status that is separate from job/import status:

- **Ready:** HFOS can recreate the object with expected fidelity.
- **Needs Review:** Data is retrievable, but at least one field, behavior, or relationship lacks a 1:1 mapping. Compatible portions can import.
- **Action Required:** Historical data can import, but a customer action is required for live service, such as reconnecting Stripe or changing DNS.
- **Port Required:** The number is discoverable but must move through a carrier/provider porting process.
- **Not Available from Source:** GHL or the granted scope does not expose sufficient data. State whether this is an API limitation or a permission problem.
- **Not Supported by HFOS:** GHL exposes it, but HFOS has no target capability yet. This creates a product gap.
- **Not Imported by Design:** Deliberately excluded, such as workflows.
- **Not in This Release:** Detected but deferred, such as websites and funnels.

Do not collapse these into a generic warning; each status implies a different remedy.

### 6.6 Step 4 — Select what to import

Behavior:

- All importable categories are selected by default.
- Customers can select or deselect entire categories.
- Categories with meaningful internal resources support drill-down selection, including locations, users, calendars, pipelines, forms, surveys, campaigns, templates, and phone numbers.
- Search and bulk actions are available for large agencies.
- Required dependencies are automatically selected and locked with a plain-language explanation.
- Counts and estimates refresh when selections change.
- Choices are saved so a customer can leave and return.

Example dependency message:

> Conversations require their related contacts. Contacts were added to this migration automatically.

### 6.7 Step 5 — Review migration plan

Before import, show:

- Selected locations and target workspace mappings.
- Selected categories and counts.
- Auto-added dependencies.
- Possible duplicate/merge count.
- Compatibility findings grouped by severity.
- Estimated media volume and approximate duration.
- Reconnect, DNS, and porting steps that will remain afterward.
- Exact statement that workflows, websites, and funnels will not be imported.
- Rollback coverage and exceptions.
- Transition Mode behavior and source-of-truth rule.

Require acknowledgement only for material risks or irreversible external steps. Do not turn every informational warning into a blocking checkbox.

### 6.8 Step 6 — Import

Show overall and per-location/per-category progress:

```text
Contacts                 18,421 / 18,421   Complete
Conversations            62,908 / 62,908   Complete
Call recordings           5,819 / 5,822    3 need retry
Invoices                  1,993 / 1,993    Complete
```

Available controls:

- Pause after the current safe checkpoint.
- Resume.
- Cancel remaining work.
- Retry failed items.
- Retry one category.
- View warnings and error details.
- Leave the page without stopping server-side work.

### 6.9 Step 7 — Verify and finish setup

Separate import success from external activation:

```text
Migration complete
124,829 records migrated

4 setup items remain
- Reconnect Stripe
- Reconnect Google Calendar
- Update email DNS
- Complete phone port
```

Do not label a successful data import “partially failed” merely because an external integration requires reauthorization.

### 6.10 Step 8 — Transition Mode and final cutover

After the initial import:

- Keep importing source changes one way from GHL to HFOS.
- Display last successful sync, current lag, next reconciliation, and conflicts/findings.
- Allow category-specific retries and a full reconciliation scan.
- Provide **Finish Migration** only when final checks can run.

Finalization runs a last incremental sync, drains pending work, verifies counts/integrity, freezes the final source cursor, explains unresolved actions, and then disables ongoing GHL sync. It does not cancel GHL on the customer's behalf.

---

## 7. Category inventory and target behavior

The matrix below is the minimum discovery catalog. A category can be marked unavailable at runtime when scopes, plan, source API, or source configuration prevent access.

| Domain            | Objects to discover/import                                                                             | Selection level                      | Core dependencies                                    | Target behavior                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Account           | Agency, locations, business profile, timezone, locale                                                  | Location                             | —                                                    | Map each selected location to a target workspace                                            |
| Users             | Users, roles, permissions, teams                                                                       | User                                 | Location                                             | Create identity stubs, preserve ownership, optionally invite                                |
| Contacts          | Contacts, businesses, addresses, additional emails/phones, consent/DND                                 | Category + individual review matches | Users, fields, tags                                  | Merge deterministically; preserve source identity                                           |
| Configuration     | Custom fields, custom values, tags, custom objects where accessible                                    | Resource                             | Location                                             | Recreate definitions before values                                                          |
| Conversations     | Threads, participants, channel/state metadata                                                          | Category                             | Contacts, users                                      | Native HFOS conversation experience                                                         |
| Messages          | SMS, MMS, email, FB, IG, WhatsApp, GMB, chat, internal comments                                        | Channel/category                     | Conversations, contacts, users, media                | Preserve chronology, privacy, direction, status                                             |
| Calls             | Calls, voicemail, dispositions, recordings, transcripts                                                | Category                             | Conversations, contacts, users, phone numbers, media | Native timeline call events                                                                 |
| Forms             | Forms, fields, layout/configuration, submissions, uploads                                              | Resource                             | Fields, contacts, media                              | Recreate form and link submissions                                                          |
| Surveys           | Surveys, questions/configuration, submissions, uploads                                                 | Resource                             | Fields, contacts, media                              | Recreate survey and link submissions                                                        |
| Templates/content | Email, SMS, WhatsApp templates, folders, snippets, standalone landing-page assets                      | Resource                             | Media, users                                         | Rebuild editable assets where fidelity permits; exclude pages belonging to websites/funnels |
| Campaigns         | Email campaigns, content, audience metadata, schedules, statistics                                     | Resource                             | Templates, users, contacts                           | Preserve historical campaigns; do not resend                                                |
| Calendars         | Calendars, groups, availability, resources, settings                                                   | Resource                             | Users, forms                                         | Recreate usable calendar configuration                                                      |
| Appointments      | Past/future/recurring appointments, blocked time, statuses                                             | Calendar/resource                    | Calendars, contacts, users                           | Native calendar records with original timezones/times                                       |
| Sales             | Pipelines, stages, opportunities, status, value, source, history                                       | Pipeline                             | Contacts, users, fields                              | Preserve structure and current stage                                                        |
| Work management   | Tasks, completed tasks, notes, assignments, due dates                                                  | Category                             | Contacts, users, opportunities                       | Native private activity/history                                                             |
| Financial catalog | Products, prices/price books, payment links, taxes, discounts, coupons                                 | Resource                             | Location                                             | Create catalog before transactional objects                                                 |
| Financial history | Orders, estimates, invoices, line items, recurring invoices, transactions, payments, refunds, receipts | Category                             | Contacts, products, users                            | Preserve history; no duplicate charges or emails                                            |
| Subscriptions     | Subscription terms, state, schedule, history                                                           | Category                             | Contacts, products                                   | Historical representation; live billing requires explicit activation                        |
| Reputation        | Reviews, requests, templates/settings, accessible history                                              | Category                             | Contacts, users, integrations                        | Preserve history; reconnect providers for live use                                          |
| Integrations      | Stripe, calendars, social, GBP, QuickBooks, Zoom, Microsoft, etc.                                      | Integration                          | Users/workspace                                      | Detect and create reconnect tasks only                                                      |
| Phone             | Active numbers, capabilities, pools/routing metadata where exposed                                     | Number                               | Workspace/users                                      | Inventory and initiate tracked provider-level porting                                       |
| Email/domain      | Sending domains, From identities, DKIM/SPF/tracking requirements                                       | Domain/identity                      | Workspace                                            | Import identities/assets; create DNS checklist                                              |
| Workflows         | Definitions and usage signals                                                                          | None                                 | —                                                    | Detect/analyze only; never recreate as workflows                                            |
| Websites/funnels  | Sites, funnels, counts/names if accessible                                                             | None                                 | —                                                    | Detect and report; excluded from this release                                               |

---

## 8. Platform architecture

### 8.1 High-level design

```text
GoHighLevel API / Webhooks / Permitted Exports
                    │
                    ▼
          GoHighLevel Source Adapter
                    │
                    ▼
        Raw Staging + Source Object Store
                    │
                    ▼
       Canonical Normalization and Validation
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
  Compatibility  Dependency   Merge/Identity
     Engine         Engine        Engine
        └───────────┼────────────┘
                    ▼
              HFOS Import Engine
                    │
       ┌────────────┼─────────────┐
       ▼            ▼             ▼
   HFOS Data    HFOS Media    Audit/Change
    Services      Storage       Journal
                    │
                    ▼
      Verification / Transition / Rollback
```

### 8.2 Required components

1. **Connection service** — OAuth lifecycle, encrypted tokens, scope checks, refresh rotation, revocation, and webhook registration.
2. **Source adapter registry** — Versioned adapters and per-source capability manifests.
3. **Discovery engine** — Locations, categories, counts, size estimates, resource lists, and source constraints.
4. **Raw staging store** — Original payloads, retrieval metadata, and optional payload versions with explicit retention rules.
5. **Canonical mapper** — Source-specific translation into stable CRM-neutral objects.
6. **Schema/capability registry** — HFOS target capabilities, mapping versions, and compatibility rules.
7. **Compatibility engine** — Ready/partial/unsupported/permission/action-required findings.
8. **Dependency engine** — Builds and validates the import graph and automatically adds requirements.
9. **Identity and merge engine** — Resolves source mappings, duplicate candidates, conflicts, and field provenance.
10. **Import orchestrator** — Durable jobs, category DAG, batching, checkpointing, pause/resume, retry, rate limiting, and backpressure.
11. **Domain importers** — HFOS-owned handlers for contacts, communications, calendars, finance, etc. They consume canonical objects rather than GHL payloads.
12. **File migration engine** — Secure download, malware/content checks as applicable, checksum, durable upload, and reference replacement.
13. **Transition sync engine** — Webhook ingestion, polling/reconciliation, cursors, tombstones, and lag monitoring.
14. **Verification engine** — Counts, hashes, referential integrity, relationship checks, and source-to-target reconciliation.
15. **Change journal and rollback engine** — Records creates/updates/links and safely reverses migration-owned changes.
16. **Reporting service** — Customer report, technical exceptions, CSV/JSON exports, and aggregate feature-gap analytics.
17. **Admin/support console** — Read-only diagnostics, safe retry controls, mapping/version visibility, and audit events.

### 8.3 Architectural boundary

The GHL adapter must never write directly to ordinary HFOS tables. It reads GHL and emits canonical objects. HFOS domain importers own validation and target writes. This keeps source knowledge outside core domain code and makes future source adapters additive.

### 8.4 Source adapter contract

Illustrative interface:

```ts
interface CrmSourceAdapter {
  sourceKey(): string;
  adapterVersion(): string;

  authorize(input: AuthorizationInput): Promise<SourceConnection>;
  refresh(connection: SourceConnection): Promise<SourceConnection>;
  revoke(connection: SourceConnection): Promise<void>;

  discoverScopes(connection: SourceConnection): Promise<SourceScope[]>;
  inspectCapabilities(scope: SourceScope): Promise<CapabilityManifest>;
  scan(scope: SourceScope, options: ScanOptions): AsyncIterable<InventoryResult>;

  list(
    scope: SourceScope,
    objectType: CanonicalObjectType,
    cursor?: SourceCursor,
    changedSince?: Instant,
  ): Promise<SourcePage>;

  getById(scope: SourceScope, objectType: string, id: string): Promise<SourceRecord>;
  getDependencies(record: SourceRecord): SourceReference[];
  normalize(record: SourceRecord, context: MappingContext): Promise<CanonicalEnvelope[]>;
  listMedia(record: SourceRecord): Promise<SourceMedia[]>;

  registerWebhooks?(scope: SourceScope, endpoint: URL): Promise<WebhookRegistration[]>;
  parseWebhook?(request: SignedWebhookRequest): Promise<SourceChange[]>;
  reconcile?(scope: SourceScope, cursor: SourceCursor): AsyncIterable<SourceChange>;
}
```

The adapter should return explicit support information for each resource:

- Available scopes.
- Enumeration method and count quality.
- Pagination/cursor semantics.
- Rate-limit rules.
- Stable source ID availability.
- Created/updated/deleted timestamp availability.
- Incremental query support.
- Webhook support.
- Media download behavior and URL expiry.
- Known source limitations.
- Mapping coverage and expected fidelity.

### 8.5 GHL adapter authentication and location support

The adapter must support both GHL token contexts:

- **Location authorization** for one sub-account.
- **Company/agency authorization** with approved locations, followed by location access tokens for location-scoped APIs.

Store agency and location tokens separately, encrypt them, rotate refresh tokens atomically, and prevent a job for one location from using another location's token. The connection service must tolerate token refresh during long migrations without restarting jobs.

### 8.6 Capability-driven implementation

Never assume that an endpoint exists merely because a canonical type exists. Each adapter release should ship a versioned capability manifest. At runtime the adapter combines:

1. Static adapter support.
2. Granted OAuth scopes.
3. Source-account plan/configuration.
4. Probe results.
5. HFOS target capability version.

That combined manifest powers the scan statuses and blocks unsupported writes before they occur.

---

## 9. Canonical data model

### 9.1 Canonical envelope

Every normalized object should be wrapped in a source-neutral envelope:

```json
{
  "canonicalType": "contact",
  "canonicalSchemaVersion": 1,
  "source": {
    "system": "gohighlevel",
    "adapterVersion": "...",
    "installationId": "...",
    "accountId": "...",
    "locationId": "...",
    "objectType": "contact",
    "objectId": "...",
    "parentObjectId": null,
    "sourceCreatedAt": "...",
    "sourceUpdatedAt": "...",
    "sourceDeletedAt": null,
    "retrievedAt": "...",
    "payloadVersion": 1,
    "payloadChecksum": "..."
  },
  "relationships": [],
  "data": {},
  "extensions": {},
  "warnings": []
}
```

### 9.2 Required source metadata on imported records

At minimum retain:

- `source_system`
- `source_adapter_version`
- `source_installation_id`
- `source_account_id`
- `source_location_id`
- `source_object_type`
- `source_object_id`
- `source_parent_object_id`, when relevant
- `source_created_at`
- `source_updated_at`
- `source_deleted_at`, when available and selected
- `source_payload_checksum`
- `source_payload_version`
- `first_migration_id`
- `last_migration_id`
- `last_synced_at`
- `canonical_schema_version`
- `mapping_version`

Use a unique source identity constraint equivalent to:

```text
(target_workspace_id,
 source_system,
 source_installation_id,
 source_location_id,
 source_object_type,
 source_object_id)
```

That uniqueness rule is the primary idempotency boundary.

### 9.3 Timestamp rules

HFOS must separate business time from ingestion time:

- `occurred_at`, `sent_at`, `started_at`, `created_at`, and equivalent user-facing historical fields come from GHL when available.
- `imported_at` and `ingested_at` are internal operational timestamps and must not replace history in the UI.
- Store source timezone and original offset when available; normalize an additional UTC value for sorting.
- Preserve sequence keys when identical timestamps occur.
- Never rewrite a historical event's date to migration time.
- If a source timestamp is missing or invalid, mark the fallback provenance and create a Needs Review finding when the distinction matters.

### 9.4 Canonical entities

The canonical model should include versioned schemas for:

- `organization`, `location`, `workspace_mapping`
- `user_identity`, `team`, `role_snapshot`
- `contact`, `business`, `address`, `communication_endpoint`, `consent_state`
- `custom_field_definition`, `custom_field_value`, `custom_value`, `tag`, `tag_assignment`
- `conversation`, `participant`, `message`, `delivery_event`, `internal_comment`
- `call`, `voicemail`, `recording`, `transcript`, `transcript_segment`
- `media_asset`, `attachment`
- `form`, `form_field`, `form_submission`, `form_answer`
- `survey`, `survey_question`, `survey_submission`, `survey_answer`
- `template`, `template_folder`, `campaign`, `campaign_variant`, `campaign_statistic`
- `calendar`, `availability_rule`, `calendar_resource`, `appointment`, `recurrence_rule`, `blocked_time`
- `pipeline`, `pipeline_stage`, `opportunity`, `opportunity_stage_event`
- `task`, `note`, `activity_event`
- `product`, `price`, `tax`, `discount`, `coupon`
- `estimate`, `order`, `invoice`, `invoice_line`, `recurring_invoice`
- `subscription`, `transaction`, `payment`, `refund`, `receipt`
- `review`, `review_request`, `reputation_template`
- `integration_descriptor`, `reconnect_task`
- `phone_number`, `number_capability`, `number_pool_descriptor`, `port_request`
- `sending_domain`, `sender_identity`, `dns_requirement`
- `workflow_descriptor` for inventory/analysis only
- `site_descriptor` and `funnel_descriptor` for deferred inventory only

### 9.5 Extensions and loss accounting

Do not discard an accessible source field merely because the first HFOS schema lacks a first-class home. Put unmapped non-secret fields in a namespaced `extensions.gohighlevel` structure in staging, and emit a compatibility finding. This is not a substitute for building required HFOS features; it prevents silent loss and makes later remapping possible.

Every normalized object should produce one of:

- Fully mapped.
- Mapped with declared transformation.
- Mapped with retained extension fields.
- Skipped with an explicit reason.
- Blocked by missing dependency.

Silent field loss is not allowed.

---

## 10. Proposed persistence model

Exact names may be adapted to the existing stack, but responsibilities should remain separate.

| Store/table                | Purpose                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `migration_connections`    | Encrypted source connection reference, scopes, expiry, state               |
| `migrations`               | Top-level migration lifecycle, source, initiator, options                  |
| `migration_scopes`         | Source location to target workspace mapping and child state                |
| `migration_scans`          | Scan version, started/completed time, source watermark                     |
| `migration_inventory`      | Counts, count quality, bytes, capability status per category/resource      |
| `migration_selections`     | Saved category/resource choices and auto-added dependencies                |
| `migration_findings`       | Compatibility, permission, action-required, and validation findings        |
| `migration_jobs`           | Durable work units, category, batch, lease, attempts, state                |
| `migration_checkpoints`    | Pagination cursors, high-water marks, batch boundaries                     |
| `source_objects`           | Raw or referenced source payload, checksum, retrieval and version metadata |
| `canonical_objects`        | Normalized envelopes or durable references to them                         |
| `source_target_mappings`   | Source identity to canonical/HFOS target identity                          |
| `merge_candidates`         | Candidate matches, evidence, score, resolution                             |
| `migration_change_journal` | Before/after field changes, created links, and rollback metadata           |
| `migration_errors`         | Sanitized error code, retryability, source identity, attempt history       |
| `migration_media`          | Source URL/reference, target storage key, checksum, state, metadata        |
| `transition_cursors`       | Per-scope/category webhook and reconciliation watermarks                   |
| `transition_events`        | Deduplicated source changes and processing state                           |
| `verification_runs`        | Verification rules, totals, discrepancies, samples, result                 |
| `port_requests`            | Phone port state and required artifacts                                    |
| `reconnect_tasks`          | External integration activation steps                                      |
| `migration_audit_events`   | Actor, action, timestamp, state transition, request correlation            |

Raw payload retention, encryption, and deletion must be explicitly configured; retaining raw payloads indefinitely is not assumed.

---

## 11. Dependency resolution and import order

### 11.1 Rules

- Dependencies are declared by canonical type, not hard-coded in the GHL UI.
- Selecting a dependent category automatically selects the minimum required parent category/resource.
- The UI explains every auto-selection.
- Dependencies can be satisfied by an existing HFOS record, a source-target mapping, a selected import, or a deliberately created placeholder when the target domain allows it.
- An item with unresolved required dependencies is quarantined and retried after the dependency pass; it is never silently orphaned.
- Optional relationships may be attached in a later linking pass.

### 11.2 Minimum dependency graph

```text
Locations
├── Users / Teams / Role snapshots
├── Custom field definitions / Tags / Custom values
├── Contacts / Businesses
│   ├── Conversations
│   │   ├── Messages
│   │   ├── Calls / Voicemails
│   │   └── Media / Recordings / Transcripts
│   ├── Tasks / Notes / Activity
│   ├── Form and survey submissions
│   ├── Opportunities
│   ├── Appointments
│   └── Financial records
├── Forms / Surveys
├── Templates / Campaigns
├── Calendars / Availability / Resources
├── Pipelines / Stages
└── Products / Prices / Tax configuration
```

Examples:

- Messages → conversations + contacts; users and media when referenced.
- Appointments → calendars + contacts; users/resources when referenced.
- Opportunities → pipelines + stages + contacts; owners and custom fields when referenced.
- Invoices → contacts + products/line items; transactions/payments link afterward.
- Form submissions → form definition + field definitions + contact; uploads link afterward.
- Subscriptions → contacts + products/prices; live processor reconnection is not an import dependency.

### 11.3 Recommended execution passes

1. Workspace/location configuration.
2. Users, teams, roles, custom-field definitions, tags, custom values.
3. Contacts and businesses.
4. Structural resources: calendars, forms, surveys, pipelines/stages, products, templates.
5. Primary records: conversations, opportunities, appointments, campaigns, tasks, submissions, financial records.
6. Child records: messages, calls, invoice lines, transactions, answers, history events.
7. Media copy and attachment replacement.
8. Optional relationship/link repair.
9. Verification and discrepancy reconciliation.

The orchestrator may parallelize independent categories and locations, but must preserve dependency and per-source ordering constraints.

---

## 12. Deduplication and merge rules

### 12.1 General rules

1. An existing `source_target_mapping` is authoritative and always checked first.
2. Exact source identities are idempotently upserted.
3. Matching logic is deterministic and versioned.
4. Every merge stores evidence, field provenance, and a reversible change journal.
5. Names alone are never sufficient to auto-merge people.
6. Ambiguous matches become **Needs Review** rather than arbitrary merges.
7. Collection fields such as tags, additional phones, and emails are unioned with normalization and provenance.
8. The most restrictive valid consent/DND state wins unless legal/product policy requires stricter handling.

### 12.2 Contact match hierarchy

Evaluate in order:

1. Existing source-to-target mapping.
2. Exact normalized primary phone match (E.164), when unambiguous.
3. Exact normalized primary email match, when unambiguous.
4. Exact additional phone/email match, when unambiguous.
5. Multiple corroborating signals such as phone + email or business + address.
6. Otherwise create a new contact.

If email points to one HFOS contact and phone points to another, do not merge automatically. Create a conflict finding with a reconciliation choice.

### 12.3 Field conflict policy

For an auto-merged pre-existing HFOS contact:

- Fill blank HFOS fields from GHL.
- Preserve non-empty HFOS-native scalar values by default.
- Union multi-value endpoints and tags.
- Preserve source value and source ownership in provenance even when it does not replace the current HFOS value.
- Preserve historical owner on imported historical events.
- For current owner conflicts, keep the existing HFOS owner and record the source owner unless the target had no owner.
- Apply the stricter consent/opt-out value.
- Add a Needs Review finding for material conflicts that cannot be represented simultaneously.

During Transition Mode, fields created by this migration are source-managed; fields that existed before the migration remain HFOS-managed. This prevents GHL sync from overwriting unrelated native work.

### 12.4 Non-contact identities

- Pipelines, calendars, forms, products, campaigns, and users match first by source mapping—not by display name.
- The same name is allowed when source IDs differ.
- Messages use source message ID. If an ID is unavailable, use a conservative fingerprint containing location, conversation, channel, direction, participants, source timestamp, body hash, and attachment hashes.
- Media deduplicates by content checksum within the tenant, while retaining distinct source references.
- Transactions and invoices must never match solely on amount/date; require source identity or a strong provider/document identifier.

### 12.5 Review experience

The review queue should show both records, matching evidence, conflicting fields, affected related records, and choices to merge, keep separate, or map to another record. User decisions become reusable scoped matching rules only when explicitly confirmed.

---

## 13. Domain-specific migration requirements

### 13.1 Contacts, businesses, fields, tags, and consent

Preserve when available:

- Names, company/business relationship, addresses, timezone, locale, birthday, source, assigned owner, created/updated time.
- Primary and additional phone numbers and email addresses.
- Tags and tag-assignment history if exposed.
- Custom-field definitions, types, options, ordering, required state, and values.
- Custom values and supported custom objects/relationships.
- Channel-specific DND, consent, unsubscribe, opt-out, and reason/timestamp.
- Profile images and retrievable documents.

Unknown field types must not be stringified silently. Create a typed compatibility finding and retain the original value in source extensions.

### 13.2 Users, roles, and ownership

Import source users as identity stubs before owned records. Suggested statuses:

- Imported.
- Not Invited.
- Invitation Pending.
- Active.
- Deactivated.

Requirements:

- Preserve source user ID, name, email where permitted, role snapshot, active/deactivated status, and team relationships.
- Preserve historical authorship and ownership even if the user is never invited.
- Let the admin choose which users receive HFOS access.
- Do not send invitations automatically during a data import unless the review step explicitly authorizes it.
- Map roles to the nearest HFOS permission set and flag differences; never grant broader privileges silently.
- Records can belong historically to an imported identity before that person accepts an invitation.

### 13.3 Conversations and messages

Imported conversation history must appear in the same timeline and use the same components as HFOS-native communication.

Preserve:

- Source thread/conversation ID and contact associations.
- Channel and subtype.
- Sender, recipient(s), assigned user, and participant identity.
- Inbound/outbound/internal direction.
- Original send/receive timestamp, sequence, timezone/offset.
- Text and structured body, subject where relevant, status, failure reason, provider IDs, and reply/thread references.
- Attachments and link previews where available.
- Related appointment, opportunity, invoice/payment, and activity associations.
- Read/unread or delivery events where exposed.

Requirements:

- Do not collapse distinct GHL conversations solely because they share a contact.
- Unified HFOS timeline views may present channels together while retaining underlying thread and channel identity.
- Internal comments remain staff-only and must never be rendered or sent as customer-visible messages.
- Importing history must never trigger outbound sends, automations, notifications, unread badges, or customer webhooks as though the events just occurred.
- Search indexes and analytics may backfill asynchronously but must use original event time.

### 13.4 Calls, voicemail, recordings, and transcripts

Calls are first-class conversation events. Preserve when available:

- Direction, caller, recipient, number used, contact, assigned user.
- Started/answered/ended timestamps, duration, status, disposition, outcome, and missed/answered state.
- Voicemail indicator and audio.
- Recording(s), source provider identifiers, and recording availability.
- Transcript, speaker/channel information, segment start/end times, confidence, and language.
- Notes and related appointment/opportunity.
- Original source IDs.

The native UI must provide normal recording playback and transcript viewing. Missing or inaccessible media creates an item warning without discarding the call event.

### 13.5 Email

Preserve when available:

- From, To, CC, and BCC with privacy rules intact.
- Sender identity and receiving contact.
- Subject, text body, HTML body, reply/thread headers, provider IDs.
- Attachments and inline assets with content-ID relationships.
- Original timestamp and timezone.
- Delivery, accepted, opened, clicked, bounced, complained, failed, replied, and unsubscribe events.
- Campaign/template attribution and source message ID.

Requirements:

- Sanitize unsafe HTML while preserving a stored source representation for audit.
- Rehost inline and attached assets when permitted and rewrite internal references safely.
- Do not mark imported email as newly unread unless the source state says it was unread and product explicitly supports historical unread state.
- Do not resend or re-track imported email.
- Historical campaign statistics are informational and must not trigger a campaign.

### 13.6 Media and files

Copy every retrievable in-scope asset into HFOS-controlled storage, including:

- Call recordings and voicemail.
- MMS and conversation attachments.
- Email attachments and inline assets.
- Form/survey uploads.
- Contact documents/profile images.
- Template/campaign assets.
- Other accessible media-library files used by imported records.

Store:

- Source URL or opaque source locator.
- HFOS storage key/URL.
- SHA-256 or equivalent checksum.
- MIME type, detected MIME type, original filename, size, and upload time.
- Source and target encryption/retention classification.
- Download status, attempts, expiry, and verification result.

Use streaming transfers and bounded temporary storage. Verify checksums/length, reject unsafe paths, handle expiring signed URLs promptly, scan files according to HFOS security policy, and never place tokens or signed URLs in customer-visible logs.

### 13.7 Calendars and appointments

Recreate calendar configuration rather than importing only events. Preserve when available:

- Calendar name, description, status, timezone, location, type/configuration.
- Availability schedules, date overrides, users/resources, teams, round-robin settings.
- Duration, buffers, capacity/seat limits, booking windows, reschedule/cancellation policy.
- Booking form association and supported notification settings.
- Past and future appointments, recurrence, blocked time, participants, status, notes, source, and ownership.

Translate GHL calendar “types” into composable HFOS configuration instead of permanently duplicating source-specific type concepts. Future appointments become live HFOS appointments only after validation; importing them must not send duplicate confirmations or reminders. Reminder activation should follow HFOS cutover rules.

### 13.8 Pipelines and opportunities

Preserve:

- Pipeline names/order and stage names/order.
- Opportunity name, value/currency, status, source, owner, contact/business, current stage.
- Created/updated/closed/lost timestamps.
- Custom fields, notes, activities, and stage/history events where exposed.

Create pipelines and stages before opportunities. Never map stages by name alone when source mappings exist. An opportunity must not move stages or reopen merely because it was imported.

### 13.9 Forms, surveys, submissions, and marketing assets

Preserve definitions, fields/questions, types, options, required flags, ordering, styling/configuration that HFOS supports, and original created/updated times. For submissions preserve respondent/contact, answers, source page/context where exposed, timestamp, uploads, and status.

For email/SMS/WhatsApp templates, standalone landing-page assets, and campaigns preserve accessible folders, names, subjects, sender identities, bodies, assets, variants, schedules, status, audience description, and statistics. A landing page that GHL stores inside a website or funnel remains deferred with that container. Imported sent campaigns remain historical and must never send again. Draft campaigns may be recreated as drafts only when fidelity is sufficient; otherwise create a read-only historical representation and Needs Review finding.

Trigger links, snippets, media-library items, custom values, and supported custom objects belong in the capability scan and should import when an HFOS target exists.

### 13.10 Tasks, notes, comments, and activity history

Preserve task status, due/completed time, assignee, creator, associations, content, and original timestamps. Preserve contact and opportunity notes with author and privacy. System activity should map to native activity-event types where possible and remain source-labeled only in technical metadata.

Internal comments and staff-only communication must remain private/internal after migration. This assumption is one of the five decisions awaiting final confirmation.

### 13.11 Financial data

Separate historical financial truth from live payment infrastructure.

Import when accessible:

- Products, price books/prices, SKUs, descriptions, payment links, taxes, discounts, coupons.
- Estimates and line items.
- Orders and fulfillment/payment state.
- Invoices, recurring invoices, line items, issue/due/paid dates, status, totals, taxes, discounts, balance, PDF/receipt artifacts.
- Subscriptions, schedules, status, plan/product association, trial/cancel dates.
- Transactions, payments, failed payments, refunds, disputes where exposed, processor reference, and payment method summary such as brand/last four when legally permitted.

Safety rules:

- Never copy full card/bank credentials, processor secrets, or authentication tokens.
- Never create a charge, send an invoice, start a subscription, or email a receipt during historical import.
- Historical records should be read-only until validated if HFOS cannot preserve all accounting semantics.
- Live payment links and recurring billing remain disabled until the processor is reconnected, duplicate-billing risk is checked, and an authorized admin explicitly activates them at cutover.
- Preserve currency and amounts in integer minor units where possible; never use binary floating point for money.
- Verify invoice and transaction totals and source relationships.

### 13.12 Integrations

Detect configured integrations and create reconnect tasks for services such as:

- Stripe/payment processors.
- Google Calendar and Microsoft calendars.
- Facebook, Instagram, Google Business Profile, and other social/messaging channels.
- QuickBooks/accounting tools.
- Zoom/meeting providers.
- Other accessible location integrations.

Store only a descriptor of what existed and the minimum configuration needed to guide reconnection. Do not migrate OAuth tokens, passwords, or secrets. Reconnection occurs through the normal HFOS integration flow and is audited separately.

### 13.13 Phone-number discovery and porting

Discover active phone numbers and accessible metadata including friendly name, voice/SMS/MMS capabilities, assignment/routing hints, number pools, country, and provider ownership when exposed.

Porting is a provider-level workflow, not a data-copy operation. Suggested states:

```text
Not Started
→ Information Required
→ Documents Required
→ Ready to Submit
→ Submitted
→ Carrier Review
→ Port Scheduled
→ Port Complete

Exceptional: Rejected / Canceled / Needs Attention
```

Requirements:

- Customer chooses numbers to port.
- Collect authorization, account information, service address, recent bill, LOA, PIN, and other provider-required materials securely.
- Track external carrier/provider reference and status history.
- Warn the customer not to cancel GHL/phone service before the carrier confirms completion.
- Submitting a port is an external side effect and requires explicit confirmation.
- Data migration rollback does not automatically cancel a submitted port.

### 13.14 Domain and email migration

Discover sending domains, From addresses, branded/tracking domains, and accessible configuration. Create an actionable checklist such as:

```text
Sending domain: mail.example.com
From identity             Imported
DKIM                      DNS update required
SPF                       DNS update required
DMARC                      Review/update required
Tracking domain           DNS update required
Verification              Pending
```

Requirements:

- Explain DNS changes in plain language with expandable technical details.
- Verify records before marking a step complete.
- Do not remove old provider records until a safe cutover plan says to do so.
- Preserve templates and historical emails independently of sending-domain activation.
- Do not enable outbound email from an unverified domain.

### 13.15 Workflows and automations

The scanner should detect and count workflows, but the importer must not recreate them.

Allowed behavior:

- Store a non-executable descriptor for migration analysis.
- Identify business outcomes/behaviors the workflow appears to support, such as lead follow-up, missed-call response, review requests, appointment reminders, or task assignment.
- Compare those behaviors with native HFOS capabilities.
- Recommend native HFOS configuration when a supported equivalent exists.
- Aggregate unsupported behavior signals for product planning.

Disallowed behavior:

- Importing the workflow graph as an HFOS workflow.
- Executing source steps during migration.
- Sending historical workflow messages.
- Quietly claiming parity because individual actions exist.

### 13.16 Websites and funnels

Websites and funnels are excluded from this release. If accessible, scan only enough metadata to show names/counts and quantify demand. Report them as **Not in This Release**, not as failed records. Do not scrape, clone, or partially recreate them under the migration job.

---

## 14. Compatibility-gap reporting

### 14.1 Finding model

Every finding should include:

- Source scope/location.
- Category and source resource/object.
- Source capability/field/behavior.
- HFOS target capability.
- Status and severity.
- Human explanation.
- What will import.
- What will change or be omitted.
- Recommended customer or engineering action.
- Whether import is blocked.
- Mapping and adapter versions.

### 14.2 Customer-facing report

Group findings into:

1. **Ready to import.**
2. **Will import with differences.**
3. **Requires action after import.**
4. **Cannot be read from GHL with current access.**
5. **HFOS capability not available.**
6. **Excluded by design/release.**

Keep the summary plain-language; provide field-level technical details as an expandable/downloadable report.

### 14.3 Internal product intelligence

Aggregate anonymized/appropriately governed feature-gap signals across migrations:

```text
Source capability → HFOS capability → frequency → affected accounts → migration impact
```

Examples:

- Percentage of migrating GHL locations using number pools.
- Number of calendar configurations lacking exact equivalents.
- Financial fields repeatedly retained only in extensions.
- Workflow behaviors that indicate missing native HFOS behavior.

Never include customer message bodies, contact PII, or secrets in aggregate analytics.

### 14.4 In-scope capability completion rule

For a source capability that is in scope and not explicitly deferred, a retained extension field is a safety net—not the final product experience. A category may be piloted with a declared Needs Review limitation, but it cannot be labeled **Ready** for general release until HFOS has a native data model, user experience, permissions, validation, verification, and tested import path for the material source behavior. Compatibility findings should therefore feed a prioritized HFOS feature backlog. Workflows and website/funnel objects are the deliberate exceptions described above.

---

## 15. Import orchestration, idempotency, and recovery

### 15.1 Durable work model

- Represent work as small, leased, retryable batches by migration, scope, category, and page/range.
- Save the next source cursor only after durable staging/checkpoint commit.
- Make target writes idempotent using the source identity unique constraint.
- Use exponential backoff with jitter for transient source, network, storage, and target errors.
- Respect GHL rate-limit headers/rules and impose per-connection and global concurrency limits.
- Refresh expiring authorization without discarding work.
- Use dead-letter/quarantine state only after a bounded retry policy.
- Allow an operator/customer retry to requeue quarantined work without duplicating successful records.

### 15.2 Checkpoint semantics

Each category checkpoint should contain:

- Adapter and mapping versions.
- Source page/cursor/offset and any stable sort key.
- Source high-water timestamp and overlap window.
- Count fetched, staged, normalized, imported, skipped, warned, failed.
- Last successful source identity.
- Batch checksum where practical.

Resume must begin from the last committed checkpoint, with enough overlap to tolerate unstable pagination. Idempotency removes duplicate overlap.

### 15.3 Error taxonomy

- **Transient/retryable:** timeout, rate limit, expired signed media URL, temporary 5xx, token refresh race.
- **Permission:** missing/revoked scope; pause affected category and request reconnection.
- **Validation/mapping:** source shape not understood; quarantine item and create a compatibility finding.
- **Dependency:** missing parent; delay and retry after dependency pass.
- **Target conflict:** uniqueness/business-rule failure; reconcile or review.
- **Permanent source absence:** object deleted/unavailable; report and continue.
- **Security/policy:** unsafe file or prohibited field; block/quarantine and audit.

No customer-facing report should expose raw stack traces, tokens, signed URLs, or unnecessary PII.

---

## 16. Transition Mode and incremental synchronization

### 16.1 Direction and ownership

Transition sync is one-way:

```text
GoHighLevel → HandsFreeOS
```

GHL is the source of truth for source-managed imported fields until finalization. HFOS-native fields and relationships not represented by GHL remain HFOS-owned. The UI should warn before a user edits a source-managed field that a later sync could replace it.

Bidirectional sync is explicitly out of scope because it creates conflict, delivery, billing, and audit risks during migration.

### 16.2 Change capture

Use both mechanisms where available:

1. **Webhooks** for low-latency change notification.
2. **Scheduled reconciliation/polling** to catch missed, delayed, unsupported, or out-of-order events.

Webhook events are hints, not proof of complete synchronization. Deduplicate them by source event/object identity, verify signatures, tolerate out-of-order delivery, and fetch the current source representation before normalization when necessary.

For resources without a reliable `updated_since` query, use overlapping time windows, stable pagination, source checksums, and periodic full or partitioned reconciliation.

### 16.3 Incremental categories

At minimum support new and changed:

- Contacts and businesses.
- Messages, calls, voicemail, recordings, and transcripts.
- Appointments and calendars.
- Opportunities and stages.
- Tasks and notes.
- Form/survey submissions.
- Financial records.
- Users/ownership.
- Selected configuration records.

If a category cannot incrementally synchronize, label it clearly and schedule a full category reconciliation at an appropriate interval.

### 16.4 Race-free initial import

To avoid missing changes made while the historical import runs:

1. Capture a per-category scan/import start watermark.
2. Begin webhook capture as early as authorization permits.
3. Perform the historical import up to the watermark.
4. Replay/deduplicate captured events after the watermark.
5. Run a reconciliation window overlapping both sides of the watermark.
6. Only mark the category current when verification passes.

### 16.5 Deletions and tombstones

Never immediately hard-delete HFOS records based on a source deletion during transition. Record a tombstone and apply the configured deleted/archive policy after relationship and local-change checks. The exact product policy is one of the five open decisions.

### 16.6 Finalization

**Finish Migration** should:

1. Confirm authorization is still valid.
2. Pause new migration-affecting configuration changes if needed.
3. Drain webhooks and run a final incremental sync.
4. Reconcile high-risk categories and media.
5. Confirm pending porting, DNS, integration, and billing actions.
6. Present unresolved discrepancies for acknowledgement or remediation.
7. Save final cursors and verification report.
8. Disable continuous source sync and webhooks.
9. Retain source metadata/change journal according to policy.
10. Leave the GHL account untouched.

---

## 17. Rollback

### 17.1 Coverage

Every target create/update/link made by the platform must carry a `migration_id` and be represented in the change journal.

Rollback behavior:

- Records created solely by the migration can be soft-deleted or removed if no protected HFOS-native dependency now relies on them.
- Imported relationships can be removed when doing so does not remove a relationship independently created later in HFOS.
- Merged pre-existing records are never deleted.
- Field changes on merged records are reversed only when the current value still equals the value written by the migration. A later HFOS edit wins and creates a rollback warning.
- Imported media can be removed only when no remaining target record references it.
- Search/index/analytics derivatives should be invalidated asynchronously.

### 17.2 Preflight and states

Before rollback, show:

- Number of records to remove.
- Number of merged records to restore.
- Records protected because of later HFOS activity.
- External actions that will not be reversed.
- Expected remaining warnings.

Rollback is itself durable, resumable, idempotent, audited, and verifiable.

### 17.3 External exceptions

Rollback does not automatically:

- Cancel or reverse a phone port.
- Undo DNS changes.
- Revoke a third-party connection unless explicitly requested through that integration.
- Reverse payments, refunds, emails, invitations, or other real-world side effects.
- Reactivate or alter the GHL account.

This is why the importer must avoid side effects during historical data creation.

---

## 18. State machines

### 18.1 Migration-level state

```text
Draft
→ Connecting
→ Connected
→ Scanning
→ Scan Complete
→ Awaiting Selection
→ Ready to Import
→ Importing
↔ Paused
→ Verifying
→ Initial Import Complete
→ Transition Active
→ Finalizing
→ Completed

Exceptional:
Completed With Warnings
Needs Attention
Failed
Canceling → Canceled
Rolling Back → Rolled Back / Rolled Back With Warnings
```

### 18.2 Scope/category state

```text
Not Selected
Selected
Blocked by Dependency
Ready
Queued
Importing
Paused
Retry Scheduled
Completed
Completed With Warnings
Failed
Skipped
Rolling Back
Rolled Back
```

### 18.3 Item state

```text
Discovered → Staged → Normalized → Matched → Imported → Verified
```

Exceptional item states:

- Skipped by selection.
- Waiting for dependency.
- Needs Review.
- Retryable Failure.
- Permanent Failure.
- Rolled Back.

All state transitions must be validated server-side and written to the audit log. Progress counters should be derived from durable item/batch state, not client memory.

---

## 19. Verification and reporting

### 19.1 Verification layers

1. **Source count reconciliation:** Compare scanned/fetched/imported/skipped/failed totals, accounting for source changes during long jobs.
2. **Identity verification:** One target mapping per unique source identity; no duplicate mappings.
3. **Referential integrity:** No orphan messages, appointments, opportunities, submissions, invoice lines, or media references.
4. **Field fidelity:** Validate required canonical fields and declared transformations.
5. **Historical fidelity:** Sample and compare timestamps, authors, owners, direction, status, and ordering.
6. **Media integrity:** Target file exists, length/checksum matches, and reference resolves.
7. **Financial integrity:** Line totals, taxes, discounts, currency, balances, payments, and refunds reconcile within exact currency rules.
8. **Structural fidelity:** Pipeline/stage ordering, calendar/resource links, field definitions, form questions, and ownership mappings are intact.
9. **Transition currency:** Cursors are caught up and reconciliation drift is below threshold.
10. **Rollback verification:** Removed/restored counts and protected exceptions reconcile.

### 19.2 Final report

The customer report should show:

- Migration ID, source, locations, targets, dates, adapter/mapping version.
- Totals by category: found, selected, imported, merged, created, updated, skipped, warned, failed, verified.
- Media items and bytes copied/failed.
- Duplicate decisions and unresolved matches.
- Compatibility findings.
- External action checklist.
- Excluded categories.
- Transition status or final cutover status.
- Retry controls for remaining failures.
- Downloadable summary and item-level error file with sanitized details.

Example:

```text
Migration complete — 124,829 records migrated

Contacts             18,421 / 18,421 verified
Conversations        62,908 / 62,908 verified
Calls                 7,105 / 7,105 verified
Recordings            5,819 / 5,822 copied; 3 need retry
Appointments          6,820 / 6,820 verified
Invoices              1,993 / 1,993 verified

Setup actions: 4
Compatibility reviews: 2
Failed items: 3 (retry available)
```

### 19.3 Auditability

Support must be able to trace:

```text
source object → raw payload version → canonical mapping version
→ match/merge decision → target writes → verification result → rollback entry
```

Every retry must retain prior attempt history without exposing sensitive payloads in ordinary logs.

---

## 20. Security, privacy, compliance, and reliability

### 20.1 Security requirements

- Encrypt OAuth tokens and source credentials with managed key rotation; never store them in logs.
- Request minimum scopes needed and display them transparently.
- Verify OAuth state and webhook signatures; protect callbacks from replay.
- Enforce tenant, agency, location, and workspace isolation in every query/job.
- Use short-lived signed access for staged/media content.
- Sanitize imported HTML and filenames; validate MIME type and size.
- Keep payment secrets and full payment credentials out of the migration path.
- Redact message bodies, email addresses, phone numbers, tokens, and signed URLs from operational error logs unless an authorized diagnostic view explicitly requires them.
- Audit authorization, selection changes, imports, retries, invitations, reconnect actions, port submissions, finalization, and rollback.
- Apply data-retention and deletion policies to raw payloads and temporary downloads.

### 20.2 Privacy and consent

- Preserve channel-specific consent, DND, unsubscribe, and complaint state.
- Default to the stricter state when merging conflicts.
- Do not treat a historical import as fresh consent.
- Preserve internal/private visibility boundaries.
- Make export/report files access-controlled and time-limited.
- Support applicable tenant data-deletion and legal-retention workflows.

### 20.3 Reliability and observability

Track metrics by adapter version, source scope, category, endpoint, and error code:

- API latency, rate limits, retries, token refreshes.
- Pages/items/bytes fetched and imported.
- Queue age and job lease expirations.
- Sync lag and webhook-to-import latency.
- Mapping warnings and unknown payload shapes.
- Media throughput/checksum failures.
- Verification discrepancies.

Use correlation IDs spanning source request, staged object, job, target write, and report. Alert on stalled jobs, growing sync lag, repeated authorization failure, elevated mapping failure, and integrity drift.

### 20.4 Scale targets

Before production, set measured service targets. Recommended starting acceptance targets:

- At least 1,000,000 source objects per agency migration without manual database intervention.
- At least 100 selected locations per agency with tenant-safe bounded concurrency.
- Resume after worker/process loss from the last committed checkpoint.
- No duplicate target records after replaying any completed batch at least three times.
- Progress/reporting counters remain accurate under retries and concurrent locations.
- Large media transfers do not require holding the entire file in memory.

These are engineering targets, not customer-facing duration promises; GHL rate limits and media volume will materially affect elapsed time.

---

## 21. Proposed internal APIs and events

The exact transport can follow the existing HFOS stack. Logical commands/queries should include:

```text
POST   /migration-connections/gohighlevel/authorize
GET    /migration-connections/{id}/callback
POST   /migrations
POST   /migrations/{id}/scan
GET    /migrations/{id}/inventory
PUT    /migrations/{id}/workspace-mappings
PUT    /migrations/{id}/selections
GET    /migrations/{id}/findings
POST   /migrations/{id}/start
POST   /migrations/{id}/pause
POST   /migrations/{id}/resume
POST   /migrations/{id}/categories/{category}/retry
POST   /migrations/{id}/items/retry
POST   /migrations/{id}/verify
POST   /migrations/{id}/transition/start
POST   /migrations/{id}/transition/reconcile
POST   /migrations/{id}/finalize
POST   /migrations/{id}/rollback/preview
POST   /migrations/{id}/rollback
GET    /migrations/{id}/report
```

Suggested domain events:

```text
MigrationConnected
MigrationScanStarted
InventoryUpdated
MigrationScanCompleted
MigrationSelectionChanged
MigrationStarted
MigrationCategoryProgressed
MigrationNeedsAttention
MigrationInitialImportCompleted
TransitionSyncLagChanged
MigrationVerificationCompleted
MigrationFinalized
MigrationRollbackStarted
MigrationRolledBack
```

Imported historical records should suppress ordinary “new record/message/payment” side effects. Use an explicit import context such as `write_origin=migration` and an event policy that allows indexing/auditing while suppressing customer-facing actions.

---

## 22. Technical acceptance criteria

### 22.1 Connection and discovery

- [ ] A location-level GHL authorization can scan and migrate its authorized location.
- [ ] An agency-level authorization can enumerate approved locations and create isolated child migrations for selected locations.
- [ ] Token refresh is atomic and long-running jobs survive access-token expiry.
- [ ] Missing scopes are reported per category and do not falsely appear as zero counts.
- [ ] Re-running a scan does not mutate HFOS customer data.
- [ ] Counts are labeled complete, estimated, permission-limited, or not enumerable.

### 22.2 Selection and dependencies

- [ ] Importable categories are selected by default.
- [ ] The customer can select categories and supported individual resources.
- [ ] Selecting a dependent resource automatically adds and explains required dependencies.
- [ ] A saved selection can be resumed on another session/device.
- [ ] Excluded workflows, websites, and funnels are explicit before import.

### 22.3 Historical and structural fidelity

- [ ] Imported records display original business timestamps rather than import timestamps.
- [ ] Historical ownership/authorship is preserved even for users not invited to HFOS.
- [ ] Pipelines, stages, calendars, forms, fields, tags, and associations preserve source structure and ordering when supported.
- [ ] Imported messages/calls/emails render in the normal HFOS timeline with correct direction, participants, channel, chronology, attachments, recordings, and transcripts.
- [ ] Staff-only notes/comments remain internal.
- [ ] Import writes do not send messages, invoices, reminders, campaigns, receipts, notifications, or automations.

### 22.4 Idempotency, merge, and retry

- [ ] Replaying any successfully imported page/batch does not create duplicate source records.
- [ ] Existing source mappings win before heuristic matching.
- [ ] Contact matching follows the documented deterministic hierarchy and never auto-merges on name alone.
- [ ] Ambiguous matches enter Needs Review.
- [ ] All merge changes include field provenance and rollback journal entries.
- [ ] A failed category can resume from its last durable checkpoint.
- [ ] A single failed item does not restart successful work or block unrelated categories.

### 22.5 Media

- [ ] Retrievable selected media is copied to HFOS storage and referenced by native records.
- [ ] File size/checksum is verified and source URLs are not required after completion.
- [ ] Expired/temporary source URLs can be refreshed/retried where the source supports it.
- [ ] A failed media copy preserves the parent record and produces a retryable warning.

### 22.6 Financial and external systems

- [ ] Historical financial totals and relationships reconcile.
- [ ] No payment credentials or third-party authorization tokens are copied.
- [ ] Import does not create charges or activate recurring billing.
- [ ] Live billing requires processor reconnection and explicit activation.
- [ ] Source integrations produce reconnect tasks.
- [ ] Phone porting and DNS actions are tracked separately and require explicit external confirmation.

### 22.7 Transition Mode

- [ ] Initial import uses a watermark plus overlap/reconciliation so concurrent source changes are not missed.
- [ ] Webhook events are authenticated, deduplicated, order-tolerant, and backed by scheduled reconciliation.
- [ ] Transition sync is one-way GHL → HFOS.
- [ ] Sync lag and last successful reconciliation are visible.
- [ ] Finalization performs a final sync and verification before disabling continuous sync.
- [ ] Finalization never cancels the GHL account.

### 22.8 Verification, reporting, and rollback

- [ ] The final report reconciles found, selected, imported, merged, skipped, warned, failed, and verified counts.
- [ ] Verification checks referential integrity, identity uniqueness, timestamps/ownership samples, media integrity, structure, and financial totals.
- [ ] Failed items can be downloaded and retried without duplication.
- [ ] Rollback preview identifies creates, merges, later HFOS changes, and external exceptions.
- [ ] Rollback removes migration-only records and safely restores journaled merge changes without deleting pre-existing or subsequently modified HFOS data.
- [ ] Rollback is resumable and produces its own verification report.

### 22.9 CRM-agnostic architecture

- [ ] GHL payload types do not leak into HFOS domain importer interfaces.
- [ ] A new CRM can implement the adapter contract without recreating job orchestration, merge logic, dependency resolution, reporting, verification, media copy, or rollback.
- [ ] Canonical schemas, adapter versions, and mapping versions are explicit and testable.
- [ ] Compatibility findings can distinguish source/API limitations from missing HFOS capabilities.

---

## 23. Five remaining product decisions

These decisions should be settled before beta behavior is locked. Recommended defaults are included to let engineering proceed behind configuration flags without pretending the choices are final.

### Decision 1 — Transition duration

**Question:** Can Transition Mode remain active indefinitely, or is it limited to a fixed period such as 7, 14, or 30 days?

**Recommended default:** Include 30 days, show reminders at 7 days remaining, and allow an admin/support-approved extension. Do not silently stop sync at expiration; move to **Needs Attention** and require explicit finalization or extension.

**Engineering impact:** Billing/entitlement, token retention, webhook lifecycle, reconciliation cost, UI reminders, and stale migrations.

### Decision 2 — Agency location-to-workspace mapping

**Question:** Should each selected GHL location automatically become a separate HFOS business/workspace, preserving strict separation, or can several source locations map into one workspace?

**Recommended default:** One GHL location → one HFOS workspace, with explicit mapping to an existing workspace allowed. Do not support many-to-one mapping in V1 because identity, ownership, configuration, consent, phone, and financial collisions become much riskier.

**Engineering impact:** Tenant boundaries, billing, permissions, bulk setup, deduplication scope, agency dashboard, and progress aggregation.

### Decision 3 — GHL snapshots

**Question:** Should GHL snapshots/templates themselves be migrated?

**Recommended default:** No. Scan and migrate the resources actually deployed in selected locations. Count snapshots only if useful for discovery, and mark them **Not Imported by Design**.

**Engineering impact:** Prevents importing reusable source-specific packaging semantics and avoids duplicating deployed assets.

### Decision 4 — Deleted and archived data

**Question:** Should deleted, archived, trashed, or soft-deleted source records be imported when GHL exposes them?

**Recommended default:** Import active and normal historical records. Exclude deleted/trash data by default; provide an advanced “Include archived/deleted records” option when the source exposes them reliably. Store tombstones during transition without immediate hard deletion.

**Engineering impact:** Count semantics, legal retention, UI visibility, transition deletion handling, rollback, and storage cost.

### Decision 5 — Internal notes and comments

**Question:** Should internal conversation comments, contact notes, opportunity notes, and staff-only communication remain private/internal after migration?

**Recommended default:** Yes, always. Preserve author, timestamp, associations, mentions where safe, and internal visibility. Never convert internal content into customer-visible messages.

**Engineering impact:** Visibility model, permissions, notification suppression, mention mapping, and acceptance tests.

---

## 24. Recommended phased implementation

The architecture should support the full scope from the start, but delivery should use thin end-to-end slices. Each phase must leave the system deployable behind feature flags.

### Phase 0 — Capability spike and contracts

Deliver:

- Confirm GHL OAuth installation model, required scopes, rate limits, pagination, webhooks, and accessible objects in test agency/location accounts.
- Create the adapter contract, canonical schema conventions, capability manifest, source identity, change-journal contract, and import event policy.
- Build a field-level GHL coverage matrix using real payload fixtures.
- Resolve the five product decisions or make the recommended defaults configurable.
- Define privacy, retention, and payment/communications side-effect policies.

Exit gate:

- Authenticated proof-of-concept can enumerate an agency's approved locations and read representative records without direct writes to HFOS domain tables.

### Phase 1 — Platform foundation and contact thin slice

Deliver:

- Connection service and encrypted token lifecycle.
- Migration/scopes/inventory/findings/job/checkpoint/mapping/change-journal stores.
- Read-only scan UI and capability statuses.
- Workspace mapping for location and agency connections.
- Selections and dependency engine.
- GHL adapter for users, contacts, businesses, custom fields/values, tags, and consent.
- Canonical contact importer, merge review, idempotency, progress, verification, and rollback.

Exit gate:

- A production-shaped single location and a multi-location test agency can scan and import contacts twice with no duplicates, preserve timestamps/ownership, and rollback safely.

### Phase 2 — Native communications and media

Deliver:

- Conversations and all exposed message channels.
- Calls, voicemail, recordings, and transcripts.
- Historical email and delivery events.
- Internal comments/privacy mapping.
- File migration engine and native timeline rendering.
- Side-effect suppression for all historical communication writes.

Exit gate:

- Golden test accounts render source conversations chronologically in normal HFOS UI; media remains playable after source URLs are invalidated; no outbound action is triggered.

### Phase 3 — Operational structure

Deliver:

- Calendars, availability, resources, past/future/recurring appointments, and blocked time.
- Pipelines, stages, opportunities, and history.
- Tasks, notes, activity events.
- Forms, surveys, submissions, and uploads.
- Structural fidelity and dependency verification.

Exit gate:

- Imported operational records are usable in native HFOS experiences and retain source relationships without duplicate reminders or other side effects.

### Phase 4 — Marketing assets and reputation

Deliver:

- Templates/folders, campaigns/variants/statistics, snippets, trigger links, and supported media/custom assets.
- Reputation/review history and reconnect tasks.
- Workflow behavior inventory/analyzer without workflow import.
- Website/funnel detection and clear exclusion reporting.

Exit gate:

- Historical campaigns remain historical, drafts are faithfully editable only when supported, and unsupported behaviors appear in compatibility reporting.

### Phase 5 — Financial history and cutover helpers

Deliver:

- Product/catalog data, orders, estimates, invoices, recurring invoices, subscriptions, transactions, payments, refunds, and receipts.
- Exact financial verification.
- Integration discovery and reconnect wizard.
- Phone-number inventory and port workflow.
- Domain/sender discovery, DNS checklist, and verification.

Exit gate:

- Financial history reconciles without creating a live charge; external activation is separate, explicit, and auditable.

### Phase 6 — Transition Mode, finalization, and scale hardening

Deliver:

- Webhook capture and per-category reconciliation.
- Race-free initial-import watermarks.
- Sync lag, conflicts, tombstones, and category reconciliation controls.
- Final cutover workflow.
- Agency-scale scheduling, fairness, quotas, and failure isolation.
- Full rollback hardening and support tooling.

Exit gate:

- Load and chaos tests prove resume/idempotency; an agency-scale migration can run initial import, receive live changes, reconcile, finalize, verify, and roll back eligible changes safely.

### Phase 7 — Second-adapter validation

Implement one narrow second CRM adapter, starting with contacts and notes, to prove the architecture is truly generic. Any change that requires source-specific logic inside core HFOS importers is an architecture defect to correct before broad expansion.

---

## 25. Test strategy

### 25.1 Adapter contract tests

Every adapter must pass shared tests for:

- Authorization failure and token refresh.
- Capability reporting.
- Stable pagination and checkpoint resume.
- Source identity uniqueness.
- Normalization schema validation.
- Relationship and dependency declaration.
- Webhook signature/deduplication behavior where supported.
- Media retrieval and expired URL behavior.

### 25.2 Fixture and golden-record tests

Maintain sanitized, versioned GHL fixtures for every known object/channel/variant. Golden tests compare:

```text
GHL payload → canonical envelope → HFOS record(s) → rendered/serialized result
```

An adapter or mapping upgrade must show intentional diffs.

### 25.3 Integration scenarios

At minimum test:

- Empty location.
- Small single location.
- Agency with 100+ locations.
- Very large contacts/messages/media volumes.
- Duplicate contacts: phone match, email match, conflicting matches, additional endpoint match.
- Same-name distinct people.
- Deactivated/missing user owning historical records.
- Mixed-channel conversation with identical timestamps.
- Failed and expired recording downloads.
- Calendar daylight-saving changes and recurring appointments.
- Pipeline stage rename/reorder and closed opportunities.
- Form field changes across historical submissions.
- Multi-currency financial history and refunds.
- Revoked scopes during import.
- Worker death at every checkpoint boundary.
- Repeated batch delivery and out-of-order webhooks.
- Local HFOS edits during Transition Mode.
- Rollback after later HFOS changes.

### 25.4 Non-functional tests

- Load, soak, and queue fairness tests.
- Rate-limit and retry storms.
- Fault injection for source/API/storage/database outages.
- Tenant-isolation and authorization tests.
- HTML/file security tests.
- Accessibility and keyboard tests for the migration wizard.
- Report accuracy under concurrent source changes.
- Disaster recovery for jobs/checkpoints/change journal.

---

## 26. Delivery checklist

Before a phase is considered production-ready:

- [ ] Product acceptance criteria are automated where possible.
- [ ] Source scopes and API limitations are documented in the adapter capability manifest.
- [ ] Unknown payload fields/shapes produce telemetry and safe findings rather than silent loss.
- [ ] Retry, pause/resume, cancellation, and worker-loss behavior is tested.
- [ ] Imported writes suppress outbound side effects.
- [ ] Customer and support reporting is accurate and redacted.
- [ ] Rollback coverage and non-reversible actions are explicit.
- [ ] Tenant isolation and token/media security review is complete.
- [ ] Migration and verification dashboards/alerts exist.
- [ ] Support has a runbook for auth failure, rate limits, stuck jobs, item quarantine, reconciliation drift, and rollback warnings.
- [ ] Feature flags allow adapter/category rollout by tenant and cohort.

---

## 27. Current GHL API grounding

This plan is intentionally capability-driven because source APIs evolve. As of this document's update, official HighLevel documentation confirms core building blocks including:

- [OAuth 2.0, company/location tokens, and location access from agency authorization](https://marketplace.gohighlevel.com/docs/ghl/oauth/o-auth-2-0/)
- [Contacts and exact email/phone lookup behavior](https://marketplace.gohighlevel.com/docs/ghl/contacts/contacts/)
- [Conversations](https://marketplace.gohighlevel.com/docs/ghl/conversations/conversations/) and [messages by conversation](https://marketplace.gohighlevel.com/docs/ghl/conversations/get-messages/index.html)
- [Call transcription retrieval by message ID](https://marketplace.gohighlevel.com/docs/ghl/conversations/get-message-transcription/)
- [Calendars](https://marketplace.gohighlevel.com/docs/ghl/calendars/calendars/)
- [Forms and form submissions](https://marketplace.gohighlevel.com/docs/ghl/forms/forms/)
- [Email templates](https://marketplace.gohighlevel.com/docs/ghl/emails/templates/) and [email campaigns](https://marketplace.gohighlevel.com/docs/ghl/emails/campaigns/)
- [Payment transactions](https://marketplace.gohighlevel.com/docs/ghl/payments/transactions/)
- [Active phone-number inventory](https://marketplace.gohighlevel.com/docs/ghl/phone-system/active-numbers/)

These links validate feasibility for major categories; they are not a substitute for the Phase 0 endpoint/scope/field coverage matrix. Every category must be verified against the current official API, the granted account scopes, real test payloads, source rate limits, and applicable platform terms before implementation is marked complete.

---

## 28. Definition of done for the GHL adapter

The GoHighLevel adapter is done when a customer can connect either a location or agency, receive an honest inventory and compatibility report, select importable data, migrate it with native historical fidelity, retry failures without duplication, verify the result, operate in one-way Transition Mode, complete external cutover steps, finalize the migration, and safely roll back migration-owned changes—while workflows, websites, and funnels remain clearly excluded and while no GHL-specific payload contract leaks into the reusable HFOS import engine.
