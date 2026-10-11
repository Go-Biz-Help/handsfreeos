-- =============================================================================
-- Social Outreach (outreach): the fits among the person's friends and chats
-- (docs/outreach.md, decision 46).
--
--        `checks` keeps the AI's read of each person a teammate already
--        knows on Facebook: a friend, or someone they've chatted with. The
--        extension opens their profile, and the business page it links to,
--        at a person's pace, and sends what those say (`lines`). The AI reads
--        the lines with the teammate's chat with them and says whether they
--        fit one of the business's playbooks, why, what they do and a first
--        step; then the lines are let go. One a teammate and profile, read
--        again after a while.
--
--        Each person's own, like their chats: the add-on's policies let
--        anyone with outreach.use in, and one restrictive policy beside them
--        keeps each request to the person's own rows.
--
--        A message to someone who fits goes through `sends` like the rest
--        (decision 26), so its kinds take `reconnect` too; and **Check my
--        friends** is an ask like the Friends tab's others, so `asks` takes
--        `checks`.
--
-- Only adds: a new table, and a kind more that `sends` and `asks` each take.
-- =============================================================================

create table addon_outreach.checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  -- What their profile and business page said, until the AI reads it; let go once it has.
  lines text[] not null default '{}' check (cardinality(lines) <= 24),
  verdict text not null default 'waiting' check (verdict in ('waiting', 'good', 'maybe', 'not', 'failed')),
  playbook_id uuid,
  -- Why, in a few short lines; who they are, in one; and a first step.
  why text[] not null default '{}' check (cardinality(why) <= 3),
  about text check (about is null or length(about) between 1 and 200),
  next_step text check (next_step is null or length(next_step) between 1 and 300),
  -- When the extension read their pages, and when the AI answered.
  looked_at timestamptz not null,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade,
  foreign key (workspace_id, playbook_id) references addon_outreach.playbooks (workspace_id, id)
    on delete set null (playbook_id)
);
create index checks_user_verdict_idx on addon_outreach.checks (workspace_id, user_id, verdict, checked_at desc);
create index checks_waiting_idx on addon_outreach.checks (workspace_id, looked_at) where verdict = 'waiting';
create index checks_profile_idx on addon_outreach.checks (profile_id);
create index checks_playbook_idx on addon_outreach.checks (playbook_id) where playbook_id is not null;
select private.addon_table_policies('addon_outreach.checks', 'outreach.use', 'outreach.use', null, null);
create policy checks_own on addon_outreach.checks as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.sends drop constraint sends_kind_check;
alter table addon_outreach.sends add constraint sends_kind_check
  check (kind in ('opener', 'follow_up', 'reply', 'reconnect'));

-- The person asks their computer to check their friends from the Friends tab (decision 43).
alter table addon_outreach.asks drop constraint asks_kind_check;
alter table addon_outreach.asks add constraint asks_kind_check check (kind in (
  'file_request', 'file_download', 'file_backup', 'file_in', 'requests', 'friends', 'groups', 'group_search',
  'members', 'posts', 'chats', 'cancel', 'unfriend', 'lookup', 'checks'));
