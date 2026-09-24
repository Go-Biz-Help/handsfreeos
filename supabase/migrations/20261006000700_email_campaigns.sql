-- Email campaigns: an outreach campaign can be one email instead of a text per person.
--
-- The AI drafts one subject and body from the goal (and the offer, if any); the owner changes it on the review
-- screen; only {first_name} changes per person. It goes to anyone with an email who hasn't unsubscribed, bounced
-- or complained, a few an hour like texts. Every one carries an unsubscribe link and the business's address
-- (CAN-SPAM), and the List-Unsubscribe headers so a mail app can offer its own button.
--
-- Unsubscribing stops campaign email only: visit confirmations, receipts and one-to-one replies still reach
-- them. So it lives in its own table, by address, not in `app.email_suppressions` (which stops all mail).

alter table app.campaigns
  add column channel text not null default 'sms' check (channel in ('sms', 'email')),
  add column email_subject text check (email_subject is null or length(btrim(email_subject)) between 1 and 150),
  add column email_body text check (email_body is null or length(btrim(email_body)) between 1 and 8000),
  -- A person changed the AI's words.
  add column email_edited boolean not null default false,
  -- Why the worker paused it (texting not set up, no broadcast stream, no address); null when a person did.
  add column paused_reason text check (paused_reason is null or length(paused_reason) <= 60);

drop trigger campaigns_immutable on app.campaigns;
create trigger campaigns_immutable before update on app.campaigns
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'channel');

grant update (email_subject, email_body, email_edited, paused_reason) on app.campaigns to authenticated;

-- Which campaign email a message is, so the sender adds the unsubscribe headers and uses the broadcast stream.
alter table app.messages
  add column campaign_recipient_id uuid references app.campaign_recipients (id) on delete set null;
create index messages_campaign_recipient_idx on app.messages (campaign_recipient_id)
  where campaign_recipient_id is not null;

create or replace function private.check_message_campaign_ref()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.campaign_recipient_id is not null and not exists (
    select 1 from app.campaign_recipients r
    where r.id = new.campaign_recipient_id and r.workspace_id = new.workspace_id) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger messages_check_campaign_ref before insert or update of campaign_recipient_id on app.messages
  for each row execute function private.check_message_campaign_ref();

-- ---------- who asked for no more campaign email ----------
create table app.email_unsubscribes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  address text not null check (address = lower(address) and position('@' in address) > 1),
  -- The campaign email they unsubscribed from, when there was one.
  campaign_id uuid references app.campaigns (id) on delete set null,
  -- The page's button, their mail app's one-click button, or Postmark's own link.
  source text not null check (source in ('link', 'one_click', 'postmark')),
  created_at timestamptz not null default now(),
  unique (workspace_id, address)
);
create index email_unsubscribes_campaign_idx on app.email_unsubscribes (campaign_id)
  where campaign_id is not null;

create or replace function private.check_email_unsubscribe_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.campaign_id is not null and not exists (
    select 1 from app.campaigns c where c.id = new.campaign_id and c.workspace_id = new.workspace_id) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger email_unsubscribes_check_refs before insert on app.email_unsubscribes
  for each row execute function private.check_email_unsubscribe_refs();

alter table app.email_unsubscribes enable row level security;
create policy email_unsubscribes_select on app.email_unsubscribes for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
-- Only the person themselves unsubscribes, through the worker; nobody on the team adds or removes one.
create policy email_unsubscribes_service_all on app.email_unsubscribes for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.email_unsubscribes to authenticated;
grant select, insert, update, delete on app.email_unsubscribes to service_actor;
revoke all on app.email_unsubscribes from anon;

-- ---------- the unsubscribe link (the tenant is not known yet) ----------
-- /u/<recipient id><code>: the id names the campaign email and its tenant, and the worker checks the HMAC over it
-- before doing anything under that workspace's scope. The address is the one the email went to.
create or replace function private.campaign_unsubscribe_lookup(p_id uuid)
returns table (recipient_id uuid, campaign_id uuid, workspace_id uuid, organization_id uuid, address text,
  business_name text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.campaign_id, r.workspace_id, w.organization_id,
    lower(coalesce(m.to_addresses[1], p.email::text)), w.name
  from app.campaign_recipients r
  join app.workspaces w on w.id = r.workspace_id
  join app.people p on p.id = r.person_id
  left join app.messages m on m.id = r.message_id
  where r.id = p_id
$$;
revoke all on function private.campaign_unsubscribe_lookup(uuid) from public;
grant execute on function private.campaign_unsubscribe_lookup(uuid) to service_actor;
