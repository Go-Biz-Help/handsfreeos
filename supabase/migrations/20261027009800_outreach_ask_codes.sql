-- =============================================================================
-- Social Outreach: a code from the person's email, for their computer
-- (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 6, "The code relay").
--
--        Alignable emails a code before it lets a profile change, and asks
--        for it in a box over the page. The extension can't read the
--        person's email, so it asks them: an ask goes to `code`, their phone
--        says to look in their email, and they type the code in HandsFreeOS.
--
--        `ask_codes` keeps that code for the extension to take, once. It's
--        the person's alone, on the database too: nobody else reads it,
--        owners and admins included. Taking it deletes it, a code not taken
--        in 10 minutes is no use to anyone and is never handed over, and the
--        daily prune clears what's left. It goes with its ask.
--
--        `asks` takes `code`: waiting on that code. `asks_open_code_idx` is
--        `asks_open_idx` with it; the old one goes in a later migration.
--
-- Only adds: a table, an index, and a state more that `asks` takes.
-- =============================================================================

create table addon_outreach.ask_codes (
  ask_id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- As the email gave it, without spaces or dashes.
  code text not null check (code ~ '^[A-Za-z0-9]{4,12}$'),
  given_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  foreign key (workspace_id, ask_id) references addon_outreach.asks (workspace_id, id) on delete cascade
);
create index ask_codes_expires_idx on addon_outreach.ask_codes (expires_at);
select private.addon_table_policies(
  'addon_outreach.ask_codes', 'outreach.use', 'outreach.use', 'outreach.use', null);

-- Each person's own, as their asks are; the worker runs as service_actor, which this doesn't narrow.
create policy ask_codes_own on addon_outreach.ask_codes as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.asks drop constraint asks_state_check;
alter table addon_outreach.asks add constraint asks_state_check
  check (state in ('waiting', 'working', 'stuck', 'typing', 'code', 'done', 'failed', 'cancelled'));
create index asks_open_code_idx on addon_outreach.asks (workspace_id, user_id, kind, asked_at)
  where state in ('waiting', 'working', 'stuck', 'typing', 'code');
