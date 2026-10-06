-- =============================================================================
-- Lockboxes (Real Estate round seven, step 4).
--
--        Chris decided (2026-10-05): read SentriLock's and Supra's "opened" emails into the listing, with an alert
--        when no showing was booked; keep the code sealed, sent only to the confirmed agent just before a showing,
--        never on phones or in exports.
--
--        **A listing's lockboxes**: what kind, where it is, its serial, and its code, sealed by the worker
--        (`code_enc`, `sealed:v1.…`). People may write a sealed code but never read one back: their role can't
--        select `code_enc`. The worker opens it only to put it in the access email (message_sealed_parts) or to
--        show it again to someone who may (/v1/addons/sealed/reveal, kept in the deal's history).
--
--        **Openings**: each "opened" email read into the listing it's about (by serial, then address), with the
--        showing it fits, if any. One that fits no showing raises an alert to the listing's agents.
-- =============================================================================

create table addon_realestate.lockboxes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  kind text not null check (kind in ('sentrilock', 'supra', 'combination', 'keypad', 'other')),
  -- Where it is: "On the side gate".
  place text check (place is null or length(btrim(place)) between 1 and 120),
  serial text check (serial is null or length(btrim(serial)) between 1 and 60),
  code_enc text check (code_enc is null or (code_enc like 'sealed:v1.%' and length(code_enc) <= 8200)),
  code_set_at timestamptz,
  code_set_by uuid references app.users (id) on delete set null,
  removed_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((code_enc is null) = (code_set_at is null)),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index lockboxes_deal_idx on addon_realestate.lockboxes (workspace_id, deal_record_id)
  where removed_at is null;
create index lockboxes_serial_idx on addon_realestate.lockboxes (workspace_id, lower(serial))
  where serial is not null and removed_at is null;
create index lockboxes_code_set_by_idx on addon_realestate.lockboxes (code_set_by) where code_set_by is not null;
create index lockboxes_created_by_idx on addon_realestate.lockboxes (created_by) where created_by is not null;
comment on column addon_realestate.lockboxes.code_enc is
  'The code, sealed by the worker (round seven). No person''s role can read it; it goes only to the confirmed agent, in the access email.';
select private.addon_table_policies('addon_realestate.lockboxes', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
-- People write a sealed code but never read one back.
revoke select on addon_realestate.lockboxes from authenticated;
grant select (id, workspace_id, deal_record_id, kind, place, serial, code_set_at, code_set_by, removed_at, created_by,
  created_at, updated_at) on addon_realestate.lockboxes to authenticated;

create table addon_realestate.lockbox_openings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  lockbox_id uuid references addon_realestate.lockboxes (id) on delete set null,
  vendor text not null check (vendor in ('sentrilock', 'supra')),
  opened_at timestamptz not null,
  serial text check (serial is null or length(btrim(serial)) between 1 and 60),
  -- Who opened it, as the email says.
  opened_by text check (opened_by is null or length(btrim(opened_by)) between 1 and 120),
  company text check (company is null or length(btrim(company)) between 1 and 120),
  phone text check (phone is null or length(phone) <= 40),
  -- The showing it fits, if one was booked.
  showing_id uuid references addon_realestate.showings (id) on delete set null,
  booked boolean not null,
  message_id uuid references app.messages (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, message_id),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index lockbox_openings_deal_idx on addon_realestate.lockbox_openings
  (workspace_id, deal_record_id, opened_at desc);
create index lockbox_openings_lockbox_idx on addon_realestate.lockbox_openings (lockbox_id)
  where lockbox_id is not null;
create index lockbox_openings_showing_idx on addon_realestate.lockbox_openings (showing_id)
  where showing_id is not null;
create index lockbox_openings_message_idx on addon_realestate.lockbox_openings (message_id)
  where message_id is not null;
select private.addon_table_policies('addon_realestate.lockbox_openings', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
