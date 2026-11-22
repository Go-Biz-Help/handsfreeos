-- Whether a caller is who their caller ID says (AI1). Anyone can fake a caller ID, so the AI phone teammate no
-- longer takes the number at its word. The owner's decision (22 Nov 2026, "Text a code first"): when the phone
-- company can't confirm the caller's number, the AI texts a code to the number on file before reading bookings or
-- bills, or changing a visit.
--
-- calls.caller_attestation: what the phone company said of an inbound call's number (Twilio's StirVerstat, from
--   STIR/SHAKEN): only `TN-Validation-Passed-A` proves it. Null when Twilio sent nothing, for calls the business
--   placed, and for calls from before this.
-- calls.caller_verified_at: when the caller read back a code sent to the phone (or else the email) on file for the
--   customer the call matched, which proves them for the rest of that call.
-- app.call_verification_codes: those codes, like a website chat's (0095): only a hash is kept, bound to the call; a
--   code lasts ten minutes, three go to one customer an hour, and five wrong tries end it. The worker alone reads
--   and writes them.
--
-- Additive: two nullable columns, covered by the calls table's existing grants and policies, and a new table.

alter table app.calls
  add column if not exists caller_attestation text
    check (caller_attestation is null or caller_attestation ~ '^[A-Za-z0-9-]{1,64}$'),
  add column if not exists caller_verified_at timestamptz;

comment on column app.calls.caller_attestation is
  'Inbound calls: the phone company''s word on the caller''s number (Twilio StirVerstat). Only TN-Validation-Passed-A proves it; null when none was sent.';
comment on column app.calls.caller_verified_at is
  'When the caller read back a code sent to the contact on file for the customer the call matched (AI1): proven for the rest of the call.';

create table if not exists app.call_verification_codes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  call_id uuid not null references app.calls (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  -- sha256 of "<call id>:<code>"; the code itself is never kept.
  code_hash bytea not null check (length(code_hash) = 32),
  channel text not null check (channel in ('sms', 'email')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists call_verification_codes_call_idx
  on app.call_verification_codes (call_id, created_at desc);
create index if not exists call_verification_codes_person_idx
  on app.call_verification_codes (person_id, created_at desc);
create index if not exists call_verification_codes_workspace_idx
  on app.call_verification_codes (workspace_id);

alter table app.call_verification_codes enable row level security;
create policy call_verification_codes_service_all on app.call_verification_codes for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert, update on app.call_verification_codes to service_actor;
revoke all on app.call_verification_codes from anon, authenticated;
