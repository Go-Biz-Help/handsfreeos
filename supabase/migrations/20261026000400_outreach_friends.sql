-- =============================================================================
-- Social Outreach (outreach): friends, Keep and Don't pitch.
--
--        The owner's decisions of 6 Oct 2026 (docs/outreach.md, 10 to 13):
--        friend requests someone gets, their friends list, the friends to
--        keep (never suggested for unfriending), and the people never to
--        pitch (no friend requests, likes, comments or messages).
--
--        **Friends** are each teammate's own: a row says where one person's
--        Facebook stands with a profile (friends, a request either way, a
--        request they turned down, or not friends), since when as far as
--        HandsFreeOS knows, when it last saw it so, and whether they keep
--        that friend. The extension writes them as the person answers a
--        request, saves a list, or saves a profile. Like noting a step,
--        none of it adds anyone to Contacts.
--
--        **Don't pitch** is the business's: anyone using the add-on can put
--        someone on it, and it says who did and when. Customers tagged
--        "Friend or family" count too, without a mark here.
-- =============================================================================

alter table addon_outreach.profiles
  add column dont_pitch boolean not null default false,
  add column dont_pitch_by uuid references app.users (id) on delete set null,
  add column dont_pitch_at timestamptz,
  add constraint profiles_dont_pitch_check check (dont_pitch or (dont_pitch_by is null and dont_pitch_at is null));
create index profiles_dont_pitch_idx on addon_outreach.profiles (workspace_id) where dont_pitch;
create index profiles_dont_pitch_by_idx on addon_outreach.profiles (dont_pitch_by) where dont_pitch_by is not null;

-- ---------- friends ----------
create table addon_outreach.friends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  -- Whose Facebook it is: someone's friends go with them.
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  state text not null check (state in ('friends', 'request_sent', 'request_received', 'declined', 'not_friends')),
  -- When it became this, as far as HandsFreeOS knows: the moment the extension first saw or noted it.
  since timestamptz not null,
  -- The last time the extension saw it so.
  seen_at timestamptz not null,
  -- A friend never suggested for unfriending.
  keep boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index friends_user_state_idx on addon_outreach.friends (user_id, workspace_id, state);
create index friends_profile_idx on addon_outreach.friends (profile_id);
select private.addon_table_policies('addon_outreach.friends', 'outreach.use', 'outreach.use', null, null);
