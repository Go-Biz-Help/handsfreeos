-- =============================================================================
-- 0095 · A website chat visitor proves who they are (M18 step 2). Anyone can
--        type someone else's number into a chat, so until now the AI teammate
--        never read a customer's bookings, bills or details back in a chat.
--        Now it can send a six-digit code to the phone (or else the email) on
--        file for the customer the chat matched; typing it back in the chat
--        marks the visitor as that customer for twelve hours.
--
--        Only a hash of each code is kept, codes last ten minutes, a visitor
--        gets three an hour, and five wrong tries end a code.
-- =============================================================================

alter table app.chat_visitors
  add column verified_person_id uuid references app.people (id) on delete set null,
  add column verified_at timestamptz,
  add constraint chat_visitors_verified_check check ((verified_person_id is null) = (verified_at is null));
create index chat_visitors_verified_person_idx on app.chat_visitors (verified_person_id)
  where verified_person_id is not null;

create table app.chat_verification_codes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  visitor_id uuid not null references app.chat_visitors (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  -- sha256 of "<visitor id>:<code>"; the code itself is never kept.
  code_hash bytea not null check (length(code_hash) = 32),
  channel text not null check (channel in ('sms', 'email')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index chat_verification_codes_visitor_idx on app.chat_verification_codes (visitor_id, created_at desc);
create index chat_verification_codes_person_idx on app.chat_verification_codes (person_id);
create index chat_verification_codes_workspace_idx on app.chat_verification_codes (workspace_id);

alter table app.chat_verification_codes enable row level security;
create policy chat_verification_codes_service_all on app.chat_verification_codes for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert, update on app.chat_verification_codes to service_actor;
revoke all on app.chat_verification_codes from anon, authenticated;
