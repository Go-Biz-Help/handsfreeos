-- =============================================================================
-- The money and wallet policies ask once per query, not once per row
-- (PERF-M7).
--
--        Every SELECT policy on the money documents and the usage wallet
--        called private.has_permission(workspace_id, …) on each row, and the
--        members' policies twice more before their own rule. A security
--        definer function is never inlined, so summing a month of a busy
--        business's usage ledger (wallet.get) made tens of thousands of
--        calls. The same answer as a set — the businesses where the asker
--        has that permission — is worked out once per query and each row
--        only looks its workspace up in it.
--
--        Same rules, same permissions: private.workspaces_with_permission
--        is private.has_permission's own question (0106), asked of every
--        business at once. The members' own rule (private.money_member_sees)
--        is unchanged. private.sync_viewer_mismatches read the old policies'
--        text; it now checks the new form and judges the whole policy.
-- =============================================================================

-- Every business where the asker may do this, by the stored answer. What private.has_permission() says yes to,
-- for all of them at once. A business being deleted grants nobody anything.
create or replace function private.workspaces_with_permission(p_perm text)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select wa.workspace_id from app.workspace_access wa
  join app.workspaces w on w.id = wa.workspace_id
  where wa.user_id = auth.uid() and p_perm = any (wa.permissions) and w.deletion_requested_at is null
$$;
revoke all on function private.workspaces_with_permission(text) from public;
grant execute on function private.workspaces_with_permission(text) to authenticated, service_actor;

-- ---------- the usage wallet ----------
drop policy if exists usage_wallets_read on app.usage_wallets;
create policy usage_wallets_read on app.usage_wallets for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.read')));
drop policy if exists usage_ledger_read on app.usage_ledger;
create policy usage_ledger_read on app.usage_ledger for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.read')));
drop policy if exists wallet_recharges_read on app.wallet_recharges;
create policy wallet_recharges_read on app.wallet_recharges for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.read')));

-- ---------- whoever manages money reads all of it ----------
drop policy if exists estimates_manage_select on app.estimates;
create policy estimates_manage_select on app.estimates for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.manage')));
drop policy if exists invoices_manage_select on app.invoices;
create policy invoices_manage_select on app.invoices for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.manage')));
drop policy if exists payments_manage_select on app.payments;
create policy payments_manage_select on app.payments for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.manage')));
drop policy if exists refunds_manage_select on app.refunds;
create policy refunds_manage_select on app.refunds for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.manage')));
-- FOR ALL covers reading too: money.manage sees and writes every line.
drop policy if exists estimate_lines_write on app.estimate_lines;
create policy estimate_lines_write on app.estimate_lines for all to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.manage')))
  with check (workspace_id in (select private.workspaces_with_permission('money.manage')));
drop policy if exists invoice_lines_write on app.invoice_lines;
create policy invoice_lines_write on app.invoice_lines for all to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.manage')))
  with check (workspace_id in (select private.workspaces_with_permission('money.manage')));

-- ---------- members: reads money, doesn't manage it, and is on the job ----------
-- The same three checks in the same order; only the first two are asked once.
drop policy if exists estimates_member_select on app.estimates;
create policy estimates_member_select on app.estimates for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.read'))
    and workspace_id not in (select private.workspaces_with_permission('money.manage'))
    and private.money_member_sees(workspace_id, lead_id, null, person_id));
drop policy if exists estimate_lines_member_select on app.estimate_lines;
create policy estimate_lines_member_select on app.estimate_lines for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.read'))
    and workspace_id not in (select private.workspaces_with_permission('money.manage'))
    and private.money_estimate_visible(workspace_id, estimate_id));
drop policy if exists invoices_member_select on app.invoices;
create policy invoices_member_select on app.invoices for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.read'))
    and workspace_id not in (select private.workspaces_with_permission('money.manage'))
    and private.money_member_sees(workspace_id, lead_id, attendee_id, person_id));
drop policy if exists invoice_lines_member_select on app.invoice_lines;
create policy invoice_lines_member_select on app.invoice_lines for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.read'))
    and workspace_id not in (select private.workspaces_with_permission('money.manage'))
    and private.money_invoice_visible(workspace_id, invoice_id));
drop policy if exists payments_member_select on app.payments;
create policy payments_member_select on app.payments for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.read'))
    and workspace_id not in (select private.workspaces_with_permission('money.manage'))
    and private.money_invoice_visible(workspace_id, invoice_id));
drop policy if exists refunds_member_select on app.refunds;
create policy refunds_member_select on app.refunds for select to authenticated
  using (workspace_id in (select private.workspaces_with_permission('money.read'))
    and workspace_id not in (select private.workspaces_with_permission('money.manage'))
    and private.money_invoice_visible(workspace_id, invoice_id));

-- ---------- the parity helper, reading the new policies ----------
-- As 0057, with two changes. It checks each members' policy names both permissions through the new set function,
-- rather than matching the old text character for character (how Postgres prints a sub-select is its business).
-- And it judges each row on the whole policy, not on the policy with its first two checks cut off: in the
-- businesses where the asker reads money and doesn't manage it those two are true anyway, and now cost nothing.
create or replace function private.sync_viewer_mismatches(p_workspace uuid default null)
returns table (table_name text, row_id uuid, user_id uuid, listed boolean, visible boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_person record;
  v_policy record;
  v_reads uuid[];
  v_listed uuid[];
  v_claims constant text := current_setting('request.jwt.claims', true);
  v_sub constant text := current_setting('request.jwt.claim.sub', true);
begin
  if (select count(*) from pg_catalog.pg_policies p
      where p.schemaname = 'app' and p.policyname = p.tablename || '_member_select'
        and p.tablename in ('estimates', 'invoices', 'estimate_lines', 'invoice_lines', 'payments', 'refunds')
        and strpos(p.qual, 'private.workspaces_with_permission(''money.read''::text)') > 0
        and strpos(p.qual, 'private.workspaces_with_permission(''money.manage''::text)') > 0) <> 6 then
    raise exception 'Expected each money table''s members'' SELECT policy to check money.read and not money.manage';
  end if;
  select coalesce(array_agg(distinct l.id), '{}') into v_listed from (
    select unnest(x.member_viewer_ids) as id from app.estimates x where p_workspace is null or x.workspace_id = p_workspace
    union all select unnest(x.member_viewer_ids) from app.invoices x where p_workspace is null or x.workspace_id = p_workspace
    union all select unnest(x.member_viewer_ids) from app.estimate_lines x where p_workspace is null or x.workspace_id = p_workspace
    union all select unnest(x.member_viewer_ids) from app.invoice_lines x where p_workspace is null or x.workspace_id = p_workspace
    union all select unnest(x.member_viewer_ids) from app.payments x where p_workspace is null or x.workspace_id = p_workspace
    union all select unnest(x.member_viewer_ids) from app.refunds x where p_workspace is null or x.workspace_id = p_workspace
  ) l;
  perform set_config('request.jwt.claim.sub', '', true);
  for v_person in
    select x.id from (
      select wm.user_id as id from app.workspace_memberships wm where p_workspace is null or wm.workspace_id = p_workspace
      union
      select om.user_id from app.organization_memberships om
      join app.workspaces w on w.organization_id = om.organization_id where p_workspace is null or w.id = p_workspace
      union
      select a.user_id from app.workspace_access a where p_workspace is null or a.workspace_id = p_workspace
      union
      select unnest(v_listed)
    ) x
    order by x.id
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_person.id, 'role', 'authenticated')::text, true);
    select coalesce(array_agg(r.ws), '{}') into v_reads from (
      select wm.workspace_id as ws from app.workspace_memberships wm where wm.user_id = v_person.id
      union
      select w.id from app.workspaces w
      join app.organization_memberships om on om.organization_id = w.organization_id where om.user_id = v_person.id
      union
      select a.workspace_id from app.workspace_access a where a.user_id = v_person.id
    ) r
    where (p_workspace is null or r.ws = p_workspace)
      and private.has_permission(r.ws, 'money.read') and not private.has_permission(r.ws, 'money.manage');
    continue when cardinality(v_reads) = 0 and not v_person.id = any(v_listed);
    for v_policy in
      select p.tablename::text as tbl, p.qual
      from pg_catalog.pg_policies p
      where p.schemaname = 'app' and p.policyname = p.tablename || '_member_select'
        and p.tablename in ('estimates', 'invoices', 'estimate_lines', 'invoice_lines', 'payments', 'refunds')
    loop
      if cardinality(v_reads) > 0 then
        return query execute format(
          'select %L::text, x.id, $3, x.member_viewer_ids @> array[$3], coalesce(%s, false)
           from app.%I x
           where x.workspace_id = any($2) and ($1 is null or x.workspace_id = $1)
             and (x.member_viewer_ids @> array[$3]) is distinct from coalesce(%s, false)',
          v_policy.tbl, v_policy.qual, v_policy.tbl, v_policy.qual)
        using p_workspace, v_reads, v_person.id;
      end if;
      if v_person.id = any(v_listed) then
        return query execute format(
          'select %L::text, x.id, $3, true, coalesce(%s, false)
           from app.%I x
           where x.member_viewer_ids @> array[$3] and not x.workspace_id = any($2)
             and ($1 is null or x.workspace_id = $1) and not coalesce(%s, false)',
          v_policy.tbl, v_policy.qual, v_policy.tbl, v_policy.qual)
        using p_workspace, v_reads, v_person.id;
      end if;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;
revoke all on function private.sync_viewer_mismatches(uuid) from public;
