-- =============================================================================
-- 0075 · Getting a form in front of people (M15). Chris chose all four ways on
--        2026-09-18: a public link to text or email, an embed on the business's
--        own website, the AI teammate asking the same questions as a
--        conversation, and a QR code for a truck door or a front desk.
--
--        Only two of them need anything here. The link is /f/<site>/<slug>,
--        resolved by `private.form_route` exactly as a booking link is (0015) —
--        the worker asks it who this is before any tenant policy exists, and a
--        retired slug still lands, redirecting to the current one. The embed
--        needs the list of sites allowed to frame it, the same rule the chat
--        widget already uses, with one difference: no sites listed at all is
--        fine here, because most forms are never embedded. The QR code is the
--        link drawn as a picture, and the teammate is a switch.
--
--        Closing is also here. A form can close on a date or after so many
--        answers, and "so many answers" needs a count that is right when two
--        people submit at the same moment — so the count is kept by a trigger
--        on the responses rather than recounted hopefully.
-- =============================================================================

alter table app.forms
  -- The sites allowed to frame it. Empty means it isn't embedded anywhere, which is most forms.
  add column embed_origins text[] not null default '{}'
    check (cardinality(embed_origins) = 0 or private.valid_chat_origins(embed_origins)),
  -- The AI teammate may ask this form's questions in a conversation instead of sending the link.
  add column in_chat boolean not null default false,
  -- Completed responses. Kept by the trigger below, which is what "closes after 100 answers" reads.
  add column response_count integer not null default 0 check (response_count >= 0),
  add column last_response_at timestamptz;

-- The Forms list sorts by how busy a form has been.
create index forms_busy_idx on app.forms (workspace_id, last_response_at desc nulls last);

-- 0073 granted the columns it knew about; these two are the business's to set as well. The count and the
-- last answer's time are not: the trigger below keeps them, and it runs as its owner.
grant update (embed_origins, in_chat) on app.forms to authenticated;

create or replace function private.count_form_response()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.status = 'completed' then
    update app.forms set response_count = response_count + 1, last_response_at = new.completed_at
      where id = new.form_id;
  elsif tg_op = 'UPDATE' and old.status <> 'completed' and new.status = 'completed' then
    update app.forms set response_count = response_count + 1, last_response_at = new.completed_at
      where id = new.form_id;
  elsif tg_op = 'DELETE' and old.status = 'completed' then
    update app.forms set response_count = greatest(0, response_count - 1) where id = old.form_id;
  end if;
  return null;
end $$;
create trigger form_responses_count after insert or update of status or delete on app.form_responses
  for each row execute function private.count_form_response();

-- ---------- how many people looked, and how many started ----------
-- A day per form, upserted by the worker. Enough for "23 looked, 9 finished" without keeping a row per
-- visit, and nothing in it says who anybody is.
create table app.form_days (
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  form_id uuid not null references app.forms (id) on delete cascade,
  day date not null,
  views integer not null default 0 check (views >= 0),
  starts integer not null default 0 check (starts >= 0),
  completions integer not null default 0 check (completions >= 0),
  primary key (form_id, day)
);
create index form_days_workspace_idx on app.form_days (workspace_id, day desc);

alter table app.form_days enable row level security;
create policy form_days_select on app.form_days for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy form_days_service_all on app.form_days for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select on app.form_days to authenticated;
grant select, insert, update on app.form_days to service_actor;

-- ---------- the worker's signed-out route (the business is not known yet) ----------
-- /f/<site>/<form>: the business a public form link names, and the version to show. A retired slug resolves
-- to the form that used it (redirected = true, form_slug is the current one). Nothing comes back for a form
-- that was never published, since there is nothing to fill in.
create or replace function private.form_route(p_site_slug text, p_form_slug text)
returns table (workspace_id uuid, organization_id uuid, timezone text, site_name text, form_id uuid,
  form_slug text, form_name text, mode app.form_mode, status app.form_status, version_id uuid,
  definition jsonb, response_count integer, redirected boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_form uuid;
  v_redirected boolean := false;
begin
  -- citext's own equality (case-insensitive, and the unique index's), named because search_path is empty.
  select s.workspace_id into v_ws from app.booking_sites s
  where s.slug operator(extensions.=) p_site_slug::extensions.citext;
  if v_ws is null then
    return;
  end if;
  select f.id into v_form from app.forms f where f.workspace_id = v_ws and f.slug = lower(p_form_slug);
  if v_form is null then
    select fs.form_id into v_form from app.form_slugs fs
    where fs.workspace_id = v_ws and fs.slug = lower(p_form_slug);
    if v_form is null then
      return;
    end if;
    v_redirected := true;
  end if;
  return query
    select w.id, w.organization_id, w.timezone, s.name, f.id, f.slug, f.name, f.mode, f.status, v.id,
      v.definition, f.response_count, v_redirected
    from app.forms f
    join app.workspaces w on w.id = f.workspace_id
    left join app.booking_sites s on s.workspace_id = f.workspace_id
    left join app.form_versions v on v.id = f.active_version_id
    where f.id = v_form and f.archived_at is null;
end $$;

-- The embed asks by origin instead of by name: which form is this script tag allowed to show?
create or replace function private.form_embed(p_form_id uuid, p_origin text)
returns table (workspace_id uuid, form_id uuid, status app.form_status, version_id uuid, definition jsonb)
language sql stable security definer set search_path = '' as $$
  select f.workspace_id, f.id, f.status, v.id, v.definition
  from app.forms f
  left join app.form_versions v on v.id = f.active_version_id
  where f.id = p_form_id and f.archived_at is null
    and lower(p_origin) = any (f.embed_origins)
$$;

revoke all on function private.form_route(text, text), private.form_embed(uuid, text),
  private.count_form_response() from public, authenticated, anon;
grant execute on function private.form_route(text, text), private.form_embed(uuid, text) to service_actor;
