-- =============================================================================
-- Real Estate Agent, round five, step 7: e-sign through DocuSign or Dotloop.
--
--        Chris decided (2026-10-02): both, behind one e-sign connector, with
--        the brokerage's own account (it signs in). A deal's document goes
--        for signing from Documents:
--
--        **Prepared there, sent from there.** HandsFreeOS makes the envelope
--        (DocuSign) or the loop (Dotloop) with the document and its signers;
--        the agent places the fields and sends it in that service, where
--        signing happens. Nothing is signed on anyone's behalf.
--
--        **Where it stands** comes back from the service (DocuSign's updates
--        and a look every fifteen minutes; Dotloop says nothing about signing,
--        so its agent says when it's done). The signed copy and DocuSign's
--        certificate come back to Documents on their own, locked, as proof for
--        the duties that need them.
-- =============================================================================

create table addon_realestate.esign_envelopes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  -- The deal's document that went for signing.
  document_id uuid not null,
  provider text not null check (provider in ('docusign', 'dotloop')),
  connection_id uuid references app.addon_connections (id) on delete set null,
  -- The service's own id for it (an envelope, a loop) and where to open it there.
  external_id text check (external_id is null or length(external_id) <= 200),
  open_url text check (open_url is null or (open_url ~ '^https?://' and length(open_url) <= 2000)),
  state text not null default 'preparing'
    check (state in ('preparing', 'draft', 'sent', 'completed', 'declined', 'voided', 'failed')),
  subject text not null check (length(subject) between 1 and 200),
  message text check (message is null or length(message) <= 2000),
  -- Each signer: name, email, order, and where they stand (as the service last said).
  signers jsonb not null default '[]'::jsonb check (jsonb_typeof(signers) = 'array'),
  failure text check (failure is null or length(failure) <= 500),
  prepared_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  checked_at timestamptz,
  -- The signed copy and the certificate, as the deal's documents.
  signed_document_id uuid,
  certificate_document_id uuid,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade,
  foreign key (workspace_id, document_id) references addon_realestate.documents (workspace_id, id) on delete cascade,
  unique (provider, external_id)
);
create index esign_envelopes_deal_idx on addon_realestate.esign_envelopes (workspace_id, deal_record_id, created_at desc);
create index esign_envelopes_open_idx on addon_realestate.esign_envelopes (workspace_id, checked_at)
  where state in ('draft', 'sent');
create index esign_envelopes_document_idx on addon_realestate.esign_envelopes (workspace_id, document_id);
create index esign_envelopes_connection_idx on addon_realestate.esign_envelopes (connection_id)
  where connection_id is not null;
create index esign_envelopes_created_by_idx on addon_realestate.esign_envelopes (created_by)
  where created_by is not null;
select private.addon_table_policies('addon_realestate.esign_envelopes', 'realestate.use', 'realestate.use', null,
  'deal_record_id');
