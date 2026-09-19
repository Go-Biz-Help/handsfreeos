-- Give every business that already published a form the public name its links are built from.
--
-- `/f/<site>/<form>` takes its first part from `app.booking_sites`, which only Settings → Booking site ever created.
-- A business that published a form without ever setting up a booking page had no row, so its form had no address at
-- all: the Share tab rendered its headings with nothing under them, `private.form_route` found no workspace, and the
-- Assistant and workflows skipped sending the link. `form.publish` now makes one as it publishes; this gives the
-- same to the forms that went out before it did.
--
-- The name comes from the workspace's own slug, which is already the right shape and is unique within its
-- organization; a clash with another organization's gets a number after it. `enabled` is false: this names the
-- business's pages, it does not put its calendars up for booking. A form's page never reads `enabled`
-- (`private.form_route`), so the link works either way, and Settings → Booking site turns booking on when they
-- want it.

do $$
declare
  ws record;
  candidate text;
  suffix int;
begin
  for ws in
    select distinct w.id, w.slug, w.name
    from app.workspaces w
    join app.forms f on f.workspace_id = w.id
    where f.status in ('live', 'closed')
      and f.archived_at is null
      and not exists (select 1 from app.booking_sites s where s.workspace_id = w.id)
  loop
    candidate := left(regexp_replace(lower(ws.slug), '[^a-z0-9-]+', '-', 'g'), 56);
    candidate := btrim(candidate, '-');
    if candidate = '' or private.booking_slug_reserved(candidate) then
      candidate := 'business';
    end if;

    suffix := 1;
    while exists (
      select 1 from app.booking_sites s
      where s.slug operator(extensions.=) candidate::extensions.citext
    ) loop
      suffix := suffix + 1;
      candidate := left(btrim(regexp_replace(lower(ws.slug), '[^a-z0-9-]+', '-', 'g'), '-'), 56)
        || '-' || suffix::text;
      if suffix > 50 then
        raise exception 'could not find a free link name for workspace %', ws.id;
      end if;
    end loop;

    insert into app.booking_sites (workspace_id, slug, name, enabled)
    values (ws.id, candidate, ws.name, false);
  end loop;
end $$;
