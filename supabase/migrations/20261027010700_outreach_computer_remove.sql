-- Social Outreach: a person removes their own computers (docs/outreach.md, decision 85). Each install of the extension
-- was a computer, and putting it in again made another, so the list grew. Until now only the worker deleted them (a
-- month unseen); now the person may delete their own, through `outreach.computer.remove`, and only their own. Their
-- feed lines go with them and an ask one took keeps no computer, as the tables' own `on delete` says. Only adds: the
-- running code never deletes one until it's deployed.

grant delete on addon_outreach.computers to authenticated;
create policy computers_delete on addon_outreach.computers for delete to authenticated
  using (workspace_id in (select private.workspaces_with_permission('outreach.use')));
create policy computers_own_delete on addon_outreach.computers as restrictive for delete to authenticated
  using (user_id = (select auth.uid()));
