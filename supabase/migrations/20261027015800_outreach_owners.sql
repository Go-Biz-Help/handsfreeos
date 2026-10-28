-- =============================================================================
-- Social Outreach: whose each group and each person is (docs/outreach.md,
-- decision 107).
--
-- The owner's decision (settled):
--
--        Each group belongs to the teammate who works it first, and each
--        person to whoever reached them first. Owners can move either.
--
-- `groups.owner_user_id` is the teammate who worked the group first: a step
-- from it, an ask to join it, or a helpful post there. `profiles.owner_user_id`
-- is whoever reached the person first: a step to them, or a demo booked
-- through their link. `owned_at` says since when. Another teammate's Today
-- leaves both out, until an owner or admin moves them
-- (`outreach.owner.move`). A teammate who no longer uses Social Outreach
-- holds nothing.
--
-- Filled from what's kept: the earliest step, join or helpful post for a
-- group; the earliest step or demo for a person.
--
-- Only adds: four columns, filled once.
-- =============================================================================

alter table addon_outreach.groups
  add column owner_user_id uuid references app.users (id) on delete set null,
  add column owned_at timestamptz;

alter table addon_outreach.profiles
  add column owner_user_id uuid references app.users (id) on delete set null,
  add column owned_at timestamptz;

-- Whoever reached each person first.
update addon_outreach.profiles p
set owner_user_id = f.user_id, owned_at = f.at
from (
  select distinct on (x.profile_id) x.profile_id, x.user_id, x.at
  from (
    select t.profile_id, t.user_id, t.at from addon_outreach.touches t where t.user_id is not null
    union all
    select d.profile_id, d.user_id, d.at from addon_outreach.demos d
    where d.user_id is not null and d.profile_id is not null and d.undone_at is null
  ) x
  join app.users u on u.id = x.user_id
  order by x.profile_id, x.at, x.user_id
) f
where f.profile_id = p.id and p.owner_user_id is null;

-- Whoever worked each group first.
update addon_outreach.groups g
set owner_user_id = f.user_id, owned_at = f.at
from (
  select distinct on (x.group_id) x.group_id, x.user_id, x.at
  from (
    select t.group_id, t.user_id, t.at from addon_outreach.touches t
    where t.user_id is not null and t.group_id is not null
    union all
    select j.group_id, j.user_id, j.asked_at from addon_outreach.joins j where j.state <> 'failed'
    union all
    select h.group_id, h.user_id, h.posted_at from addon_outreach.helpful h
    where h.group_id is not null and h.state = 'posted' and h.posted_at is not null
  ) x
  join app.users u on u.id = x.user_id
  order by x.group_id, x.at, x.user_id
) f
where f.group_id = g.id and g.owner_user_id is null;
