-- =============================================================================
-- 0057 · What leaves the database for phones, and as whom. PowerSync reads
--        the database through logical replication: a replication slot on the
--        `powersync` publication, as its own role. Two things hold the line on
--        secrets, because a phone's rules can't:
--          - The publication lists its tables by name (never FOR ALL TABLES or
--            IN SCHEMA, which would sweep in every table added later). A
--            table is either published whole or not at all: PowerSync's first
--            copy of a table runs SELECT * and ignores publication column
--            lists, and column-level grants break replication instead (spike
--            1b), so a secret on a published table would reach its storage.
--          - hfos_sync may read those tables and nothing else. It bypasses RLS
--            (it has to see every business), so its grants are the boundary.
--        The streams in apps/sync/sync-config.yaml then name the columns each
--        phone gets, and packages/db/test/sync-secrets.test.ts checks all
--        three: publication membership, the role's grants, and the columns the
--        streams select.
--
--        The audit behind the list. Every table a phone needs was checked for
--        sealed tokens, key material, token hashes, EINs, webhook secrets and
--        OAuth state; none holds one, so nothing moves:
--          - Secrets live only in tables phones never need, and those stay out:
--            telephony_accounts (auth_token_enc, api_key_secret_enc),
--            mailbox_connections, calendar_connections and payment_connections
--            (token_enc, pkce_verifier_enc, oauth_state_hash,
--            subscription_client_state_hash), workflow_webhooks (secret_enc),
--            chat_visitors (token_hash, prev_token_hash, ip_hmac), invitations
--            (token_hash) and telephony_registrations (an EIN in submission).
--            So do tables whose documents may carry one: workflows and their
--            versions, runs and steps (a webhook_out step's URL is often a
--            bearer secret), webhook_deliveries and scheduled_jobs (raw provider
--            payloads), events, outbox and audit_logs, the Assistant's chats,
--            the AI teammate's runs and tool calls, knowledge and imports.
--          - Published tables keep a few identifiers that are not secrets but
--            that no phone needs, and the streams never select them:
--            conversations.email_reply_token (it travels in every Reply-To
--            header), subscriptions.method_token and customer_ref (the
--            provider's ids, useless without the account's sealed credentials),
--            payments' and refunds' idempotency keys and provider ids, and the
--            public_ref and link versions of customer links (a link also needs
--            an HMAC only the worker can sign).
--        The role has no password: it can't sign in until one is set at go-live
--        (locally, `pnpm sync:start` sets a local-only one). Push devices and
--        people's cells join the publication with their tables, in 0060.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hfos_sync') then
    create role hfos_sync with login replication bypassrls nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end
$$;
comment on role hfos_sync is
  'PowerSync''s replication login: reads the tables in the powersync publication, and nothing else. No password until go-live.';

grant usage on schema app to hfos_sync;

grant select on
  app.organizations, app.workspaces, app.users, app.workspace_access, app.workspace_memberships,
  app.organization_memberships,
  app.pipelines, app.pipeline_stages, app.tags, app.record_tags,
  app.people, app.companies, app.leads, app.tasks, app.activities, app.files,
  app.conversations, app.messages, app.calls, app.opt_outs, app.email_suppressions,
  app.phone_numbers, app.email_addresses,
  app.attention_items, app.ai_teammates, app.ai_teammate_drafts, app.workflow_approvals,
  app.calendars, app.calendar_members, app.calendar_services, app.calendar_busy_blocks,
  app.services, app.service_staff, app.schedules, app.schedule_exceptions,
  app.appointments, app.appointment_attendees, app.appointment_staff,
  app.products, app.plans, app.estimates, app.estimate_lines, app.invoices, app.invoice_lines,
  app.payments, app.refunds, app.subscriptions,
  app.command_receipts
  to hfos_sync;

-- The name is PowerSync's requirement. Explicit tables only.
create publication powersync for table
  app.organizations, app.workspaces, app.users, app.workspace_access, app.workspace_memberships,
  app.organization_memberships,
  app.pipelines, app.pipeline_stages, app.tags, app.record_tags,
  app.people, app.companies, app.leads, app.tasks, app.activities, app.files,
  app.conversations, app.messages, app.calls, app.opt_outs, app.email_suppressions,
  app.phone_numbers, app.email_addresses,
  app.attention_items, app.ai_teammates, app.ai_teammate_drafts, app.workflow_approvals,
  app.calendars, app.calendar_members, app.calendar_services, app.calendar_busy_blocks,
  app.services, app.service_staff, app.schedules, app.schedule_exceptions,
  app.appointments, app.appointment_attendees, app.appointment_staff,
  app.products, app.plans, app.estimates, app.estimate_lines, app.invoices, app.invoice_lines,
  app.payments, app.refunds, app.subscriptions,
  app.command_receipts;
