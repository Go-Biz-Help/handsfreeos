-- =============================================================================
-- Suggesting an add-on on Home, now and then.
--
--        The owner's decision (2026-09-28): occasionally, a small card on Home
--        for owners and admins when an available add-on fits what the
--        business does, easy to dismiss. Which add-on fits, and whether a card
--        shows at all, is decided in code (packages/core/src/addons/
--        suggest.ts); what each person chose is kept here, per business:
--        "Not now" quiets every suggestion for them for a while, and "Not
--        interested" never shows them that add-on again. Each person sees and
--        changes only their own.
-- =============================================================================

create table app.addon_suggestion_dismissals (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  choice text not null check (choice in ('not_now', 'not_interested')),
  decided_at timestamptz not null default now(),
  primary key (workspace_id, user_id, addon_id)
);
create index addon_suggestion_dismissals_user_idx on app.addon_suggestion_dismissals (user_id);
create trigger addon_suggestion_dismissals_immutable before update on app.addon_suggestion_dismissals
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id', 'addon_id');

alter table app.addon_suggestion_dismissals enable row level security;
create policy addon_suggestion_dismissals_select on app.addon_suggestion_dismissals for select to authenticated
  using (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
create policy addon_suggestion_dismissals_insert on app.addon_suggestion_dismissals for insert to authenticated
  with check (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
create policy addon_suggestion_dismissals_update on app.addon_suggestion_dismissals for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and workspace_id in (select private.accessible_workspace_ids()));
create policy addon_suggestion_dismissals_service_all on app.addon_suggestion_dismissals for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert on app.addon_suggestion_dismissals to authenticated;
grant update (choice, decided_at) on app.addon_suggestion_dismissals to authenticated;
grant select, insert, update, delete on app.addon_suggestion_dismissals to service_actor;
revoke all on app.addon_suggestion_dismissals from anon;
