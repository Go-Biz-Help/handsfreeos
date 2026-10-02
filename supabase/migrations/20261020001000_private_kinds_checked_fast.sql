-- =============================================================================
-- Records kept to their people: the kinds a person sees whole, found in their
-- own businesses first.
--
--        Fixing 20261013002400 and 20261013003000.
--        private.private_kinds_seen_whole() asked private.has_permission()
--        about every private kind of record in every business before narrowing
--        to the caller's own, so each query on a private record (a deal, its
--        duties, dates and documents) cost more with every business on
--        HandsFreeOS: with a few hundred, each duty update took half a second.
--        Now both functions narrow to the caller's businesses before anything
--        else. What anyone sees doesn't change: the private-records and add-on
--        tests hold it.
-- =============================================================================

create or replace function private.private_kinds_seen_whole()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select t.id from app.custom_record_types t
  where t.workspace_id = any (array(select private.accessible_workspace_ids()))
    and t.kept_to_team
    and private.has_permission(t.workspace_id, t.see_all_permission)
$$;

create or replace function private.unseen_private_records()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select r.id from app.custom_records r
  where r.workspace_id = any (array(select private.accessible_workspace_ids()))
    and r.kept_to_team
    and r.owner_user_id is distinct from auth.uid()
    and not (r.team_user_ids @> array[auth.uid()])
    and not (r.type_id in (select private.private_kinds_seen_whole()))
    and not (r.id in (select private.support_seen_records()))
$$;
