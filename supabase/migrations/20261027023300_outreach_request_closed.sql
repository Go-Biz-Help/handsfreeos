-- People nobody can send a friend request (docs/outreach.md, decision 156).
--
-- Some Facebook profiles show no Add friend at all: the person takes requests
-- only from friends of friends, or only lets people follow them. Since
-- extension 0.126.3 a request to one is passed over quietly. Now the extension
-- also remembers it (`outreach.request.closed`), and Today never picks them
-- for a friend request, or a like before one, again, so they stop taking a
-- spot on the list.
--
--        `profiles.request_closed_at` is when the extension last found their
--        profile with no way to send them a request.
--
-- Only adds: a column. Nothing is dropped or changed.

alter table addon_outreach.profiles
  add column request_closed_at timestamptz;

comment on column addon_outreach.profiles.request_closed_at is
  'When the extension found their profile offers no friend request (Facebook shows no Add friend): never picked for one again (decision 156).';
