-- `private.form_route` never returned `embed_origins`, so embedding a form has never worked.
--
-- apps/worker/src/http/forms.ts declares the column on its row type and hands it back as `embedOrigins`, but the
-- function's `returns table (…)` left it out, so `select * from private.form_route(...)` gave `undefined` every
-- time. apps/web/src/lib/forms/frame.ts therefore always saw an empty list and kept the page's frame rule at
-- `frame-ancestors 'self'` — a business that listed its own website still had the browser refuse the iframe.
-- Nothing caught it: no test asserts the value, and the page itself looks fine until you embed it.
--
-- The body is unchanged apart from selecting the column; `f.embed_origins` is `not null default '{}'`, so a form
-- nobody listed sites for still comes back as an empty list rather than null.

drop function if exists private.form_route(text, text);

create function private.form_route(p_site_slug text, p_form_slug text)
returns table (workspace_id uuid, organization_id uuid, timezone text, site_name text, form_id uuid,
  form_slug text, form_name text, mode app.form_mode, status app.form_status, version_id uuid,
  definition jsonb, response_count integer, redirected boolean, embed_origins text[])
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
      v.definition, f.response_count, v_redirected, f.embed_origins
    from app.forms f
    join app.workspaces w on w.id = f.workspace_id
    left join app.booking_sites s on s.workspace_id = f.workspace_id
    left join app.form_versions v on v.id = f.active_version_id
    where f.id = v_form and f.archived_at is null;
end $$;

grant execute on function private.form_route(text, text) to service_actor;
