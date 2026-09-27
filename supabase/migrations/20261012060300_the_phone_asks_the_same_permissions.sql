-- =============================================================================
-- The phone asks the same permissions RLS does: the catalogue and the AI's
-- drafts.
--
--        business_v1 sent products and plans, and the AI teammate's pending
--        drafts, to everyone who could open the business (`access`). RLS
--        reads them only with money.read (products, plans) and inbox.use
--        (drafts), which since 0106 a business can take away. A member it
--        took them from was refused on the web and the API while their phone
--        went on holding the price list and every draft reply.
--
--        Two more flags on app.workspace_access, off the stored permissions,
--        like manages_money: reads_money and uses_inbox. The sync config reads
--        them as two more business_v1 lookups (`reads_money`, `uses_inbox`),
--        because a stream's lookup cannot look inside the permissions array.
--        The same BEFORE trigger that keeps sees_whole_inbox and manages_money
--        keeps them, whoever writes the row.
-- =============================================================================

alter table app.workspace_access
  add column if not exists reads_money boolean not null default false,
  add column if not exists uses_inbox boolean not null default false;
comment on column app.workspace_access.reads_money is
  'Whether this person may see money here (money.read): what the business_v1 `reads_money` sync parameter reads for the catalogue.';
comment on column app.workspace_access.uses_inbox is
  'Whether this person may use the inbox here (inbox.use): what the business_v1 `uses_inbox` sync parameter reads for the AI teammate''s drafts.';

-- The flags the sync config reads, off the stored permissions, whoever writes the row (0083, 0106, and now these two).
create or replace function private.inbox_access_flag()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.sees_whole_inbox := not private.inbox_per_person(new.workspace_id)
    or 'channels.manage' = any (new.permissions);
  new.manages_money := 'money.manage' = any (new.permissions);
  new.reads_money := 'money.read' = any (new.permissions);
  new.uses_inbox := 'inbox.use' = any (new.permissions);
  return new;
end $$;

-- Everyone, now. The trigger above works out all four; only the rows it would change are written.
update app.workspace_access wa
set reads_money = 'money.read' = any (wa.permissions),
    uses_inbox = 'inbox.use' = any (wa.permissions)
where wa.reads_money is distinct from ('money.read' = any (wa.permissions))
   or wa.uses_inbox is distinct from ('inbox.use' = any (wa.permissions));
