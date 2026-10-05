-- =============================================================================
-- Real Estate Agent, round four, steps 6 and 7: a linked sale and purchase,
-- and who uses the add-on, for Team workload.
--
--        Chris decided (2026-10-02): watch both and warn. Each deal shows the
--        other's key dates, and a date on one that breaks the other warns
--        both agents. Chosen for him: only the key dates, the health and the
--        agent's name cross the link; never the other deal's duties,
--        documents or messages.
--
--        **private.linked_deal_facts(deal)**: for someone who sees this deal,
--        each deal linked to it with just those facts, even when the other
--        is a private deal they aren't on. The worker, acting for the
--        business, reads the same.
-- =============================================================================

create or replace function private.linked_deal_facts(p_deal uuid)
returns table (
  deal_id uuid,
  other_id uuid,
  kind text,
  name text,
  side text,
  stage text,
  outcome text,
  health text,
  agent_name text,
  key_dates jsonb
)
language sql stable security definer set search_path = '' as $$
  select l.deal_record_id, o.record_id, l.kind, r.name, o.side, o.stage, o.outcome, o.health,
    coalesce(nullif(u.full_name, ''), u.email::text),
    coalesce((
      select jsonb_object_agg(e.key, jsonb_build_object('date', e.value_date, 'confirmed', e.confirmed))
      from (
        select distinct on (t.key) t.key, t.value_date, t.confirmed_at is not null as confirmed
        from addon_realestate.term_entries t
        where t.deal_record_id = o.record_id and t.value_date is not null
          and t.superseded_at is null and t.rejected_at is null
        order by t.key, t.entered_at desc
      ) e
    ), '{}'::jsonb)
  from addon_realestate.deal_links l
  join addon_realestate.deals o on o.workspace_id = l.workspace_id and o.record_id = l.other_record_id
  join app.custom_records r on r.id = o.record_id
  left join app.users u on u.id = r.owner_user_id
  where l.deal_record_id = p_deal
    and (
      -- A person who uses the add-on here and sees this deal.
      (l.workspace_id in (select private.workspaces_with_permission('realestate.use'))
        and not (p_deal in (select private.unseen_private_records())))
      -- The worker, acting for this business.
      or l.workspace_id = private.system_scope_workspace()
    )
$$;
revoke all on function private.linked_deal_facts(uuid) from public;
grant execute on function private.linked_deal_facts(uuid) to authenticated, service_actor;

comment on function private.linked_deal_facts(uuid) is
  'A deal''s linked deals, with only their key dates, health and agent''s name, for someone who sees this deal (Real Estate, round four).';

-- =============================================================================
-- Step 7: Team workload. The people who use Real Estate here, with their role,
-- for someone who sees every deal (See every deal), whether or not they may
-- see the business's member list.
-- =============================================================================

create or replace function private.realestate_team(p_ws uuid)
returns table (user_id uuid, role text)
language sql stable security definer set search_path = '' as $$
  select wa.user_id, wa.role::text
  from app.workspace_access wa
  where wa.workspace_id = p_ws and 'realestate.use' = any (wa.permissions)
    and private.has_permission(p_ws, 'realestate.all_deals')
$$;
revoke all on function private.realestate_team(uuid) from public;
grant execute on function private.realestate_team(uuid) to authenticated;
