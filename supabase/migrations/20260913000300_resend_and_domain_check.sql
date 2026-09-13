-- =============================================================================
-- 0013 · Sending a registration again, and the daily check of email domains.
--        A registration remembers which version of its details the carrier
--        has, so details people send again after the carriers turned them
--        down go back to the carrier, instead of the worker asking about the
--        old request. Once a day the worker lists every workspace's own email
--        domains to look at their DNS records again.
-- =============================================================================

-- ---------- registrations: which details the carrier has ----------
-- The submitted_at of the details the carrier last received (null until the worker sends them). A registration
-- whose submitted_at differs has details the carrier has not seen: never sent, or sent again by people.
alter table app.telephony_registrations add column carrier_submitted_at timestamptz;

-- Everything already at the carrier went as it stands.
update app.telephony_registrations set carrier_submitted_at = submitted_at where provider_sid is not null;

-- People edit a draft, a turned-down registration or one the carrier has not seen yet, and send it; the
-- carrier's answers, and which details it has, are the worker's.
create or replace function private.guard_registration_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.provider_sid is distinct from new.provider_sid or old.provider_status is distinct from new.provider_status
     or old.rejection_reason is distinct from new.rejection_reason or old.approved_at is distinct from new.approved_at
     or old.next_poll_at is distinct from new.next_poll_at or old.poll_count is distinct from new.poll_count
     or old.account_id is distinct from new.account_id or old.depends_on_id is distinct from new.depends_on_id
     or old.carrier_submitted_at is distinct from new.carrier_submitted_at then
    raise exception 'Only HandsFreeOS records the carrier''s answer' using errcode = '42501', detail = 'registration_provider_fields';
  end if;
  if old.status not in ('draft', 'rejected', 'failed')
     and not (old.status = 'submitted' and old.carrier_submitted_at is distinct from old.submitted_at)
     and (old.status is distinct from new.status or old.submission is distinct from new.submission) then
    raise exception 'A registration under review cannot be changed' using errcode = '42501', detail = 'registration_in_review';
  end if;
  if old.status is distinct from new.status and new.status not in ('draft', 'submitted') then
    raise exception 'People can only save or send a registration' using errcode = '42501', detail = 'registration_status_transition';
  end if;
  return new;
end $$;

drop policy telephony_registrations_insert on app.telephony_registrations;
create policy telephony_registrations_insert on app.telephony_registrations for insert to authenticated
  with check (private.has_permission(workspace_id, 'channels.manage') and created_by = (select auth.uid())
    and status in ('draft', 'submitted') and provider_sid is null and carrier_submitted_at is null);

-- ---------- the daily domain check ----------
-- Every workspace domain the mail service knows, with its tenant: pending and failed ones may verify now,
-- verified ones may have stopped. Listed before a tenant is known, like the outbox.
create or replace function private.email_domains_to_check()
returns table (email_domain_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select d.id, d.workspace_id, w.organization_id
  from app.email_domains d join app.workspaces w on w.id = d.workspace_id
  where d.provider_domain_id is not null
  order by d.last_checked_at nulls first, d.id
$$;

revoke all on function private.email_domains_to_check() from public;
grant execute on function private.email_domains_to_check() to service_actor;
