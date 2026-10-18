-- =============================================================================
-- Social Outreach (outreach): partners, people who already have the attention
-- of the business's customers (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md,
-- stage 1; docs/outreach.md decision 81).
--
--        `partners` keeps the AI's partner check of each candidate a
--        teammate's computer read: an admin of a group the business's
--        customers are in, someone with a following, or a business with the
--        same customers. The extension reads their profile and sends what it
--        says (`lines`) and how many follow them; the AI says whether their
--        audience is a partner playbook's, what kind of partner they are, who
--        their audience is and how big, why, and a first warm-up; then the
--        lines are let go. A good or maybe puts them on the Partners list,
--        where their stage is kept as each is reached, with when.
--
--        Each person's own, like their checks: the add-on's policies let
--        anyone with outreach.use in, and one restrictive policy beside them
--        keeps each request to the person's own rows.
--
--        `profiles` gains how many follow someone, as their profile last said,
--        and when someone was found as a partner (`partner_found_at`): from then on
--        they're never pitched as a customer, nor are their twins, on any
--        network (decision 81).
--
-- Only adds: a new table, and three columns on profiles, each null until set.
-- =============================================================================

alter table addon_outreach.profiles
  add column followers integer check (followers is null or followers >= 0),
  add column followers_at timestamptz,
  add column partner_found_at timestamptz;
-- Read once for a whole query, as Don't pitch's are (packages/core/src/addons/outreach/ops/common.ts).
create index profiles_partner_idx on addon_outreach.profiles (workspace_id, platform)
  where partner_found_at is not null;
create index profiles_followers_idx on addon_outreach.profiles (workspace_id, followers desc)
  where followers is not null;

create table addon_outreach.partners (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  -- Why they were read: they run a group, have a following, or run a business. The AI's answer can change it.
  kind text not null check (kind in ('group_admin', 'creator', 'business')),
  -- What their profile said, until the AI reads it; let go once it has.
  lines text[] not null default '{}' check (cardinality(lines) <= 24),
  fit text not null default 'waiting' check (fit in ('waiting', 'good', 'maybe', 'not', 'failed')),
  playbook_id uuid,
  -- Who their audience is, in one line, and how many; why, in a few short lines; and a first warm-up.
  audience text check (audience is null or length(audience) between 1 and 200),
  audience_size integer check (audience_size is null or audience_size >= 0),
  why text[] not null default '{}' check (cardinality(why) <= 3),
  next_step text check (next_step is null or length(next_step) between 1 and 300),
  -- Where they are on the Partners list once the AI found them, and when each stage was reached.
  stage text check (stage is null or stage in (
    'found', 'warming', 'asked', 'interested', 'call_booked', 'partner', 'not_now')),
  found_at timestamptz,
  warmed_at timestamptz,
  asked_at timestamptz,
  interested_at timestamptz,
  call_at timestamptz,
  partner_at timestamptz,
  not_now_at timestamptz,
  -- When the extension read their profile, and when the AI answered.
  looked_at timestamptz not null,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  -- Only a good or maybe is on the list.
  check (stage is null or fit in ('good', 'maybe')),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade,
  foreign key (workspace_id, playbook_id) references addon_outreach.playbooks (workspace_id, id)
    on delete set null (playbook_id)
);
create index partners_user_stage_idx on addon_outreach.partners (workspace_id, user_id, stage);
create index partners_waiting_idx on addon_outreach.partners (workspace_id, looked_at) where fit = 'waiting';
create index partners_profile_idx on addon_outreach.partners (profile_id);
create index partners_playbook_idx on addon_outreach.partners (playbook_id) where playbook_id is not null;
select private.addon_table_policies('addon_outreach.partners', 'outreach.use', 'outreach.use', null, null);
create policy partners_own on addon_outreach.partners as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
