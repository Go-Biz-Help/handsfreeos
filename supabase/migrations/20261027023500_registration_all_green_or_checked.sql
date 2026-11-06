-- =============================================================================
-- Texting registrations go to the carriers all green, or after HandsFreeOS
-- checks them by hand.
--
--        Two campaigns were turned down in a week (Twilio's 30896 and 30924):
--        a sign-up page whose Send didn't sign anyone up, and words by the
--        phone field that didn't name the kinds of texts or say "Message
--        frequency varies". Both were things a check could have caught, and
--        one was only a warning. So the owner's rule (2026-11-05): a
--        registration goes only when every row on its last step is green;
--        otherwise the business asks HandsFreeOS to check it, and staff
--        approve it (it's sent as the business left it) or send it back.
--
--        **app.registration_checks** is what the worker's checks last found
--        for exactly which details (a fingerprint of them), one row per
--        business. registration.submit sends only details found all green
--        in the last day, so the rule holds for the Assistant and for any
--        direct call, not only for the button the wizard greys out. Only
--        the worker writes it.
--
--        **app.registration_reviews** is each "Ask HandsFreeOS to check it":
--        the details as they'd be sent, what wasn't green, the business's
--        note and the support ticket it opened. The business may only
--        withdraw a waiting one (by sending, or asking again); staff decide
--        through private.decide_registration_review(), which checks
--        support.reply for itself; the worker sends an approved one.
--
--        Both hold the EIN (inside the details), so only people who can
--        manage the business's channels see them, and neither is in the
--        powersync publication.
-- =============================================================================

create table app.registration_checks (
  workspace_id uuid primary key references app.workspaces (id) on delete cascade,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  all_green boolean not null,
  not_green jsonb not null default '[]'::jsonb
    check (jsonb_typeof(not_green) = 'array' and pg_column_size(not_green) <= 131072),
  checks jsonb not null default '[]'::jsonb
    check (jsonb_typeof(checks) = 'array' and pg_column_size(checks) <= 131072),
  checked_at timestamptz not null default now()
);
create trigger registration_checks_immutable before update on app.registration_checks
  for each row execute function private.forbid_tenant_column_change('workspace_id');

alter table app.registration_checks enable row level security;

create policy registration_checks_select on app.registration_checks for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
create policy registration_checks_service_all on app.registration_checks for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.registration_checks from public;
grant select on app.registration_checks to authenticated;
grant select, insert, update, delete on app.registration_checks to service_actor;

create type app.registration_review_status as enum ('waiting', 'approved', 'sent_back', 'withdrawn');

create table app.registration_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  kind text not null check (kind in ('a2p_10dlc', 'toll_free_verification')),
  status app.registration_review_status not null default 'waiting',
  submission jsonb not null
    check (jsonb_typeof(submission) = 'object' and pg_column_size(submission) <= 65536),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  not_green jsonb not null default '[]'::jsonb
    check (jsonb_typeof(not_green) = 'array' and pg_column_size(not_green) <= 131072),
  note text check (char_length(note) <= 2000),
  -- The support desk's ticket. Not a foreign key, like app.rcs_requests: the desk is HandsFreeOS's own.
  ticket_id uuid,
  ticket_number bigint,
  requested_by uuid references app.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_by uuid references app.users (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 4000),
  registration_ids uuid[] not null default '{}'::uuid[],
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One waiting at a time: asking again withdraws the last one first.
create unique index registration_reviews_one_waiting on app.registration_reviews (workspace_id)
  where status = 'waiting';
create index registration_reviews_latest on app.registration_reviews (workspace_id, requested_at desc);

create trigger registration_reviews_updated_at before update on app.registration_reviews
  for each row execute function private.set_updated_at();
create trigger registration_reviews_immutable before update on app.registration_reviews
  for each row execute function private.forbid_tenant_column_change('workspace_id');

alter table app.registration_reviews enable row level security;

create policy registration_reviews_select on app.registration_reviews for select to authenticated
  using (private.has_permission(workspace_id, 'channels.manage'));
-- Asked for as the person, waiting and undecided.
create policy registration_reviews_insert on app.registration_reviews for insert to authenticated
  with check (
    private.has_permission(workspace_id, 'channels.manage')
    and status = 'waiting'
    and decided_by is null and decided_at is null and decision_note is null
    and sent_at is null and registration_ids = '{}'::uuid[]
    and requested_by = auth.uid()
  );
-- The business only ever withdraws a waiting one (the column grant below keeps it to the status).
create policy registration_reviews_withdraw on app.registration_reviews for update to authenticated
  using (private.has_permission(workspace_id, 'channels.manage') and status = 'waiting')
  with check (private.has_permission(workspace_id, 'channels.manage') and status = 'withdrawn');
create policy registration_reviews_service_all on app.registration_reviews for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.registration_reviews from public;
grant select, insert on app.registration_reviews to authenticated;
grant update (status) on app.registration_reviews to authenticated;
grant select, insert, update, delete on app.registration_reviews to service_actor;

-- Staff read the review a ticket is about, with the business's name: by its id, or by the ticket it opened.
create or replace function private.registration_review_for_staff(p_review uuid, p_ticket uuid default null)
returns table (
  id uuid,
  workspace_id uuid,
  business_name text,
  kind text,
  status app.registration_review_status,
  submission jsonb,
  not_green jsonb,
  note text,
  ticket_number bigint,
  requested_at timestamptz,
  decided_at timestamptz,
  decision_note text,
  sent_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.staff_can('support.read') then
    raise exception 'Not support staff' using errcode = '42501', detail = 'not_staff';
  end if;
  return query
    select r.id, r.workspace_id, w.name::text, r.kind, r.status, r.submission, r.not_green, r.note,
      r.ticket_number, r.requested_at, r.decided_at, r.decision_note, r.sent_at
    from app.registration_reviews r
    join app.workspaces w on w.id = r.workspace_id
    where (p_review is not null and r.id = p_review)
       or (p_review is null and p_ticket is not null and r.ticket_id = p_ticket)
    order by r.requested_at desc
    limit 1;
end $$;

-- Staff decide a waiting review: approve it (the worker then sends it) or send it back with a note.
create or replace function private.decide_registration_review(
  p_review uuid,
  p_status app.registration_review_status,
  p_note text
)
returns table (workspace_id uuid, organization_id uuid, ticket_id uuid, status app.registration_review_status, decided boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_row app.registration_reviews;
begin
  if not private.staff_can('support.reply') then
    raise exception 'Not support staff' using errcode = '42501', detail = 'not_staff';
  end if;
  if p_status not in ('approved', 'sent_back') then
    raise exception 'Approve it or send it back' using errcode = '22023', detail = 'bad_decision';
  end if;
  select * into v_row from app.registration_reviews r where r.id = p_review for update;
  if v_row.id is null then
    return;
  end if;
  if v_row.status = 'waiting' then
    update app.registration_reviews r
      set status = p_status, decided_by = auth.uid(), decided_at = now(),
          decision_note = nullif(btrim(coalesce(p_note, '')), '')
      where r.id = p_review;
  end if;
  return query
    select v_row.workspace_id, w.organization_id, v_row.ticket_id,
      case when v_row.status = 'waiting' then p_status else v_row.status end,
      v_row.status = 'waiting'
    from app.workspaces w where w.id = v_row.workspace_id;
end $$;

revoke all on function private.registration_review_for_staff(uuid, uuid) from public;
revoke all on function private.decide_registration_review(uuid, app.registration_review_status, text) from public;
grant execute on function private.registration_review_for_staff(uuid, uuid) to authenticated;
grant execute on function private.decide_registration_review(uuid, app.registration_review_status, text) to authenticated;
