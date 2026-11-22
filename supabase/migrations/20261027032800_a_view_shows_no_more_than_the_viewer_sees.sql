-- =============================================================================
-- A view never shows more than the viewer could see.
--
--        Viewing the app as someone (20261018000100) reads the business as
--        that person, so every rule answers as it would for them. Only their
--        own mail was kept back. What else is theirs because it's theirs,
--        rather than because of a permission the viewer holds too, came
--        through: their safety contacts and open check-in (20261022000300),
--        their coaching cards and coached calls, their outreach, and the
--        private records (20261013002400) they're on. An admin whose "See
--        every deal" was taken away read an agent's deals by viewing as them,
--        and support, viewing as the owner from a look, read every private
--        record without anyone letting them in.
--
--        **A person's own things stay theirs.** Restrictive policies, beside
--        the mail's, hide from any view: safety contacts, check-ins and who
--        was told of one (and private.safety_checkin_for_contact, the told
--        teammate's own way in); About you; Sales Coach's cards; and each of
--        Social Outreach's tables kept to its person. Where whoever manages
--        reads everyone's (coached calls with salescoach.review, outreach's
--        days, tallies and the like with outreach.manage), a person's own
--        rows show through a view only when the viewer holds that permission.
--
--        **A private record shows only when the viewer could see it too:**
--        on it, or seeing its kind whole, while they work here; the founder
--        in the business as its owner; or support let in by a grant
--        (app.record_support_grants) while their look is open. The record's
--        own policy gains it, and so do private.custom_record_visible and
--        private.unseen_private_records, which every rule on what hangs off a
--        record asks, so its timeline, tasks, files and their objects, Home
--        cards, threads, appointments, relationships and add-on rows follow.
--
--        **Support still views as anyone,** owners included, and sees what
--        that person's permissions show. Only private records keep to the
--        grant, as they do in a look (docs/realestate.md: "Support can't see
--        private deals unless the deal's agent or an admin lets them in").
--
--        **Nothing changes without a view.** Every rule here asks
--        private.read_through_a_view() first, once per statement, and stops.
--
-- Only new policies and functions, and three functions restated with one more
-- condition. No table or column changes, so PowerSync copies nothing again.
-- =============================================================================

-- ---------- who is viewing ----------
-- The person viewing, from the claim the API sets once private.teammate_view() said the view is theirs and holds;
-- null when nobody is, or when the claim names nobody. Every rule below only takes away with it, so anyone setting
-- it themselves hides things from themselves and sees nothing more.
create or replace function private.the_viewer()
returns uuid language sql stable set search_path = '' as $$
  select case when c.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then c.v::uuid end
  from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'hfos_viewer' as v) c
$$;
revoke all on function private.the_viewer() from public;
grant execute on function private.the_viewer() to authenticated, service_actor;

-- Whether the person viewing holds this permission here as themselves, as private.has_permission() answers for
-- them: their own, or an owner's while they're the founder with the business open as its owner. False with nobody
-- viewing.
create or replace function private.viewer_has_permission(p_ws uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    private.user_has_permission(v.id, p_ws, p_perm)
    or exists (
      select 1 from platform.view_as_sessions s
      join platform.staff st on st.user_id = s.staff_user_id and st.status = 'active' and st.founder
      join app.workspaces w on w.id = s.workspace_id and w.deletion_requested_at is null
      where s.staff_user_id = v.id and s.workspace_id = p_ws and s.acts and s.ended_at is null
        and (s.expires_at is null or s.expires_at > now())
        and exists (select 1 from app.role_permissions rp where rp.role = 'owner' and rp.permission = p_perm)),
    false)
  from (select private.the_viewer() as id) v
$$;
revoke all on function private.viewer_has_permission(uuid, text) from public;
grant execute on function private.viewer_has_permission(uuid, text) to authenticated, service_actor;

-- ---------- a private record, through a view ----------
-- Whether the person viewing could see this record themselves, by 20261013002400's rule: any record that isn't
-- private; a private one when they're on it or see its kind whole while they work here (private.user_sees_record),
-- they're the founder with the business open as its owner, or they're support let in by a grant while their look is
-- open (private.support_sees_record, asked about them). False with nobody viewing.
create or replace function private.viewer_sees_record(p_record uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select not r.kept_to_team
      or private.user_sees_record(v.id, r.id)
      or private.viewer_has_permission(r.workspace_id, t.see_all_permission)
      or (exists (select 1 from private.active_view_as(v.id, r.workspace_id))
          and exists (select 1 from app.record_support_grants g
                      where g.workspace_id = r.workspace_id and g.status = 'active' and g.expires_at > now()
                        and private.user_sees_record(g.granted_by, r.id)))
    from app.custom_records r
    join app.custom_record_types t on t.id = r.type_id
    cross join (select private.the_viewer() as id) v
    where r.id = p_record), false)
$$;
revoke all on function private.viewer_sees_record(uuid) from public;
grant execute on function private.viewer_sees_record(uuid) to authenticated, service_actor;

-- The private records the caller can open that the person viewing through them couldn't see. None when nobody is
-- viewing: that is asked once, and stops the rest.
create or replace function private.unseen_through_the_view()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select r.id from app.custom_records r
  where (select private.read_through_a_view())
    and r.workspace_id = any (array(select private.accessible_workspace_ids()))
    and r.kept_to_team
    and not private.viewer_sees_record(r.id)
$$;
revoke all on function private.unseen_through_the_view() from public;
grant execute on function private.unseen_through_the_view() to authenticated, service_actor;

-- 20261020001000's, and through a view the records the viewer couldn't see too. What hangs off a private record in
-- an add-on's tables, threads, appointments and records on hold asks this.
create or replace function private.unseen_private_records()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select r.id from app.custom_records r
  where r.workspace_id = any (array(select private.accessible_workspace_ids()))
    and r.kept_to_team
    and r.owner_user_id is distinct from auth.uid()
    and not (r.team_user_ids @> array[auth.uid()])
    and not (r.type_id in (select private.private_kinds_seen_whole()))
    and not (r.id in (select private.support_seen_records()))
  union all
  select u.id from private.unseen_through_the_view() u(id)
$$;

-- 20261013002400's, and through a view only what the viewer could see too. A record's timeline lines, tasks, files
-- and their objects, Home cards and relationships ask this.
create or replace function private.custom_record_visible(p_record uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.custom_records r
    where r.id = p_record
      and r.workspace_id in (select private.accessible_workspace_ids())
      and not (r.type_id in (select private.hidden_record_kinds()))
      and (not r.kept_to_team
           or r.owner_user_id = auth.uid()
           or r.team_user_ids @> array[auth.uid()]
           or r.type_id in (select private.private_kinds_seen_whole())
           or private.support_sees_record(r.workspace_id, r.id))
      and (not r.kept_to_team or not private.read_through_a_view() or private.viewer_sees_record(r.id)))
$$;

-- Restrictive: it narrows custom_records_select (its owner and team arms answer for the person viewed) and allows
-- nothing itself.
create policy custom_records_through_a_view on app.custom_records as restrictive for select to authenticated
  using (not kept_to_team or not (select private.read_through_a_view())
         or not (id in (select private.unseen_through_the_view())));

-- ---------- a person's own things ----------
create policy safety_contacts_not_viewed on app.safety_contacts as restrictive for select to authenticated
  using (not (select private.read_through_a_view()));
create policy safety_checkins_not_viewed on app.safety_checkins as restrictive for select to authenticated
  using (not (select private.read_through_a_view()));
create policy safety_escalations_not_viewed on app.safety_escalations as restrictive for select to authenticated
  using (not (select private.read_through_a_view()));
create policy user_about_not_viewed on app.user_about as restrictive for select to authenticated
  using (not (select private.read_through_a_view()));

-- 20261022000300's, and never through a view: a teammate told about someone's missed check-out reads it as
-- themselves, and nobody viewing as them does.
create or replace function private.safety_checkin_for_contact(p_ws uuid, p_checkin uuid)
returns table (id uuid, person_name text, person_phone text, place text, latitude numeric, longitude numeric,
               located_at timestamptz, started_at timestamptz, planned_end_at timestamptz, state text)
language sql stable security definer set search_path = '' as $$
  select c.id, coalesce(nullif(u.full_name, ''), u.email::text),
         (select p.e164 from app.user_phones p where p.user_id = c.user_id and p.verified_at is not null
          order by p.created_at limit 1),
         c.place, c.latitude, c.longitude, c.located_at, c.started_at, c.planned_end_at, c.state
  from app.safety_checkins c
  join app.users u on u.id = c.user_id
  where c.id = p_checkin and c.workspace_id = p_ws
    and not private.read_through_a_view()
    and p_ws in (select private.accessible_workspace_ids())
    and c.state in ('alerted', 'help')
    and exists (select 1 from app.safety_escalations e
                where e.checkin_id = c.id and e.channel = 'app' and e.told_user_id = auth.uid())
$$;

-- Sales Coach: a rep's cards are theirs alone, even for reviewers; their coached calls show through a view only
-- to a viewer who reviews.
create policy cards_not_viewed on addon_salescoach.cards as restrictive for select to authenticated
  using (not (select private.read_through_a_view()));
create policy calls_not_viewed on addon_salescoach.calls as restrictive for select to authenticated
  using (not (select private.read_through_a_view()) or user_id is distinct from (select auth.uid())
         or private.viewer_has_permission(workspace_id, 'salescoach.review'));

-- Social Outreach: each table kept to its person, and those whoever manages reads too (outreach.manage).
do $$
declare
  t text;
begin
  foreach t in array array[
    'ask_codes', 'asks', 'autopilot_people', 'calls', 'checks', 'computers', 'engagements', 'event_people',
    'event_reads', 'events', 'finds', 'follow_ups', 'follower_reads', 'followers', 'helpful', 'joins', 'list_saves',
    'live_steps', 'needs', 'occasions', 'partner_leads', 'partner_searches', 'partners', 'refer_asks', 'referrals',
    'reviews', 'setup', 'stages', 'waiting_pushes']
  loop
    execute format(
      'create policy %I on addon_outreach.%I as restrictive for select to authenticated '
      'using (not (select private.read_through_a_view()))',
      t || '_not_viewed', t);
  end loop;
  foreach t in array array['days', 'network_starts', 'request_pauses', 'tallies', 'time_offers']
  loop
    execute format(
      'create policy %I on addon_outreach.%I as restrictive for select to authenticated '
      'using (not (select private.read_through_a_view()) or user_id is distinct from (select auth.uid()) '
      'or private.viewer_has_permission(workspace_id, %L))',
      t || '_not_viewed', t, 'outreach.manage');
  end loop;
end $$;
