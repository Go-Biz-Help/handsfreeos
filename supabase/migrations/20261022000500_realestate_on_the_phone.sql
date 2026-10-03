-- =============================================================================
-- Real Estate on the phone (round six, step 7).
--
--        Chris decided (2026-10-03) that every deal page works on the phone
--        with no signal: an agent's own deals in full, and for anyone who sees
--        every deal, every other deal's summary, duties and dates. This names
--        what phones keep of Real Estate (20261022000100's
--        private.addon_phone_table: the columns of each table, the deal each
--        row follows, and `all` for the summary, duties, dates and who is on
--        it). Left out: lockbox instructions, tokens and their hashes, the
--        provider's own ids and links, pasted text, the AI's raw answers, the
--        fair-housing checks, the duty list's templates and anything only the
--        web's settings use. The manifest's `offline` says the same; a test
--        holds them equal.
--
--        **New this round:**
--          - realestate.export: exporting a whole transaction (owners and
--            admins);
--          - field_notes: what an agent notes at a stop, a showing or an open
--            house, typed, spoken (with its words when they come) or
--            photographed, made on the phone (B-07);
--          - walkthroughs and walkthrough_items: the final walkthrough's
--            checklist, built from the contract, the repairs, the inspection
--            and the condition photos, checked on the phone (X-24);
--          - exports: each transaction export and where it stands.
-- =============================================================================

select private.register_addon_permissions('realestate', '[
  {"key": "realestate.export", "label": "Export deals",
   "description": "Export a whole transaction: every document, date and decision in one file.",
   "defaultRoles": ["admin"], "requires": ["realestate.use"]}
]'::jsonb);

-- ---------- field notes ----------
create table addon_realestate.field_notes (
  -- Made on the phone.
  id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  -- What it's about: a home on a tour, a showing, an open house, or the deal itself.
  about_kind text not null check (about_kind in ('deal', 'home', 'tour_stop', 'showing', 'open_house', 'walkthrough')),
  about_id uuid,
  body text check (body is null or length(body) <= 4000),
  -- A voice note: the recording (a core file on the deal), and its words once they come.
  audio_file_id uuid references app.files (id) on delete set null,
  transcript text check (transcript is null or length(transcript) <= 20000),
  transcript_state text not null default 'none' check (transcript_state in ('none', 'waiting', 'done', 'failed')),
  photo_file_ids uuid[] not null default '{}' check (cardinality(photo_file_ids) <= 20),
  created_by uuid references app.users (id) on delete set null,
  -- When it was taken (the phone's moment), not when it arrived.
  noted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (body is not null or audio_file_id is not null or cardinality(photo_file_ids) > 0),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index field_notes_deal_idx on addon_realestate.field_notes (deal_record_id, about_kind, about_id);
create index field_notes_audio_idx on addon_realestate.field_notes (audio_file_id) where audio_file_id is not null;
create index field_notes_created_by_idx on addon_realestate.field_notes (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.field_notes', 'realestate.use', 'realestate.use',
  'realestate.use', 'deal_record_id');

-- ---------- the final walkthrough ----------
create table addon_realestate.walkthroughs (
  id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  appointment_id uuid references app.appointments (id) on delete set null,
  scheduled_at timestamptz,
  state text not null default 'planned' check (state in ('planned', 'started', 'done')),
  started_at timestamptz,
  finished_at timestamptz,
  -- The clients said it's as agreed (ticked on the phone with them).
  clients_agreed_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create unique index walkthroughs_one_open on addon_realestate.walkthroughs (deal_record_id) where state <> 'done';
create index walkthroughs_appointment_idx on addon_realestate.walkthroughs (appointment_id) where appointment_id is not null;
create index walkthroughs_created_by_idx on addon_realestate.walkthroughs (created_by) where created_by is not null;
select private.addon_table_policies('addon_realestate.walkthroughs', 'realestate.use', 'realestate.use', null,
  'deal_record_id');

create table addon_realestate.walkthrough_items (
  -- Made on the phone for one added there; the server's for the list it builds.
  id uuid primary key,
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  walkthrough_id uuid not null references addon_realestate.walkthroughs (id) on delete cascade,
  -- Where it came from: a repair agreed, an item that stays or goes (the contract), an inspection finding, a room
  -- against its listing photos, or added by hand.
  source text not null check (source in ('repair', 'included', 'excluded', 'finding', 'room', 'added')),
  source_ref uuid,
  title text not null check (length(btrim(title)) between 1 and 200),
  detail text check (detail is null or length(detail) <= 1000),
  state text not null default 'unchecked' check (state in ('unchecked', 'ok', 'not_ok', 'unsure')),
  note text check (note is null or length(note) <= 2000),
  photo_file_ids uuid[] not null default '{}' check (cardinality(photo_file_ids) <= 10),
  checked_by uuid references app.users (id) on delete set null,
  checked_at timestamptz,
  -- A failed item's duty before closing.
  duty_id uuid,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index walkthrough_items_walkthrough_idx on addon_realestate.walkthrough_items (walkthrough_id, position);
create index walkthrough_items_deal_idx on addon_realestate.walkthrough_items (deal_record_id);
create index walkthrough_items_checked_by_idx on addon_realestate.walkthrough_items (checked_by) where checked_by is not null;
select private.addon_table_policies('addon_realestate.walkthrough_items', 'realestate.use', 'realestate.use',
  'realestate.use', 'deal_record_id');

-- ---------- transaction exports ----------
create table addon_realestate.exports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  deal_record_id uuid not null,
  state text not null default 'building' check (state in ('building', 'ready', 'failed')),
  -- The zip, a core file on the deal.
  file_id uuid references app.files (id) on delete set null,
  manifest_sha256 text check (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$'),
  counts jsonb not null default '{}',
  failure text check (failure is null or length(failure) <= 500),
  requested_by uuid references app.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, deal_record_id) references addon_realestate.deals (workspace_id, record_id)
    on delete cascade
);
create index exports_deal_idx on addon_realestate.exports (deal_record_id, requested_at desc);
create index exports_file_idx on addon_realestate.exports (file_id) where file_id is not null;
create index exports_requested_by_idx on addon_realestate.exports (requested_by) where requested_by is not null;
select private.addon_table_policies('addon_realestate.exports', 'realestate.export', 'realestate.export', null,
  'deal_record_id');

-- ---------- what phones keep ----------
select private.addon_phone_addon('realestate', 'realestate.use');

-- The summary, duties, dates and who is on it: also for whoever sees every deal.
select private.addon_phone_table('addon_realestate.deals', 'record_id', array['side', 'stage', 'stage_entered_at',
  'outcome', 'outcome_at', 'health', 'health_reasons', 'health_at', 'created_at', 'updated_at'], 'all', 'record_id');
select private.addon_phone_table('addon_realestate.duties', 'deal_record_id', array['duty_key', 'pass', 'title',
  'tracker', 'status', 'materiality', 'accountable_role', 'accountable_user_id', 'performers', 'definition',
  'due_state', 'due_at', 'due_date', 'due_time', 'blocker', 'blocker_owner', 'waiting_on', 'waiting_since',
  'finished_at', 'finished_by', 'exception', 'acknowledged_at', 'at_risk_since', 'escalated_at', 'updated_at'], 'all');
select private.addon_phone_table('addon_realestate.term_entries', 'deal_record_id', array['key', 'value_date',
  'value_time', 'value_cents', 'value_text', 'source', 'page', 'entered_at', 'confirmed_at', 'superseded_at',
  'rejected_at'], 'all');
select private.addon_phone_table('addon_realestate.deal_roles', 'deal_record_id', array['user_id', 'role'], 'all');

-- The rest of a deal: to its people.
select private.addon_phone_table('addon_realestate.deal_links', 'deal_record_id', array['other_record_id', 'kind']);
select private.addon_phone_table('addon_realestate.deal_history', 'deal_record_id', array['at', 'actor_type',
  'actor_user_id', 'what', 'note']);
select private.addon_phone_table('addon_realestate.duty_evidence', 'deal_record_id', array['duty_id', 'kind',
  'document_id', 'file_id', 'appointment_id', 'body', 'added_by', 'added_at', 'withdrawn_at']);
select private.addon_phone_table('addon_realestate.duty_links', 'deal_record_id', array['duty_id', 'depends_on_id',
  'kind']);
select private.addon_phone_table('addon_realestate.duty_log', 'deal_record_id', array['duty_id', 'at', 'actor_type',
  'actor_user_id', 'what', 'note']);
select private.addon_phone_table('addon_realestate.duty_vendors', 'deal_record_id', array['duty_id', 'vendor_id',
  'service', 'quote_cents', 'quote_document_id', 'appointment_id', 'note', 'picked_at', 'removed_at']);
select private.addon_phone_table('addon_realestate.documents', 'deal_record_id', array['file_id', 'kind', 'title',
  'lineage_id', 'version', 'supersedes_id', 'status', 'controlling', 'signed_at', 'voided_at', 'offer_version_id',
  'created_at']);
select private.addon_phone_table('addon_realestate.esign_envelopes', 'deal_record_id', array['document_id',
  'provider', 'state', 'subject', 'signers', 'sent_at', 'completed_at', 'signed_document_id']);
select private.addon_phone_table('addon_realestate.contingencies', 'deal_record_id', array['kind', 'label',
  'end_key', 'ends_on', 'source', 'state', 'resolved_at', 'document_id', 'note']);
select private.addon_phone_table('addon_realestate.contract_reads', 'deal_record_id', array['document_id', 'kind',
  'state', 'scan', 'pages', 'found', 'unclear', 'read_at']);
select private.addon_phone_table('addon_realestate.drafts', 'deal_record_id', array['kind', 'milestone', 'person_id',
  'subject', 'body', 'status', 'edited_at', 'flags_acknowledged_at', 'sent_at']);
select private.addon_phone_table('addon_realestate.buyer_profiles', 'deal_record_id', array['budget_min_cents',
  'budget_max_cents', 'areas', 'home_types', 'beds_min', 'baths_min', 'sqft_min', 'move_by', 'must_haves',
  'deal_breakers', 'search_on', 'search_checked_at', 'version'], 'team', 'deal_record_id');
select private.addon_phone_table('addon_realestate.homes', 'deal_record_id', array['address', 'source', 'link',
  'facts', 'fact_sources', 'facts_state', 'facts_confirmed_at', 'status', 'status_note', 'added_by',
  'added_by_person_id', 'mls', 'mls_state', 'mls_checked_at', 'created_at']);
select private.addon_phone_table('addon_realestate.home_reactions', 'deal_record_id', array['home_id', 'person_id',
  'reaction', 'note', 'reacted_at']);
select private.addon_phone_table('addon_realestate.feed_matches', 'deal_record_id', array['listing_key',
  'mls_number', 'mls', 'state', 'found_at', 'decided_at', 'home_id']);
select private.addon_phone_table('addon_realestate.tours', 'deal_record_id', array['appointment_id', 'status',
  'starts_at', 'ends_at', 'agent_user_id', 'agreement_document_id', 'note', 'canceled_at']);
select private.addon_phone_table('addon_realestate.tour_stops', 'deal_record_id', array['tour_id', 'home_id',
  'position', 'status', 'visited_at', 'note']);
select private.addon_phone_table('addon_realestate.tour_feedback', 'deal_record_id', array['tour_id', 'stop_id',
  'home_id', 'person_id', 'interest', 'rating', 'words', 'created_at']);
select private.addon_phone_table('addon_realestate.cmas', 'deal_record_id', array['home_id', 'subject_address',
  'subject_beds', 'subject_baths', 'subject_sqft', 'subject_list_price_cents', 'number', 'status', 'as_of',
  'low_cents', 'likely_cents', 'high_cents', 'per_sqft_cents', 'summary', 'summary_state', 'finalized_at',
  'shared_at']);
select private.addon_phone_table('addon_realestate.cma_comps', 'deal_record_id', array['cma_id', 'address',
  'price_cents', 'status', 'sold_on', 'beds', 'baths', 'sqft', 'year_built', 'distance_miles', 'used', 'note',
  'source', 'position', 'mls_number', 'mls']);
select private.addon_phone_table('addon_realestate.offers', 'deal_record_id', array['home_id', 'number', 'status',
  'their_agent_name', 'their_brokerage', 'their_email', 'their_phone', 'accepted_version_id', 'ended_at',
  'ended_reason', 'buyer_names', 'created_at']);
select private.addon_phone_table('addon_realestate.offer_versions', 'deal_record_id', array['offer_id', 'number',
  'side', 'at', 'price_cents', 'emd_cents', 'emd_days', 'seller_credit_cents', 'inspection_days', 'loan_type',
  'financing_days', 'appraisal_contingency', 'closing_date', 'other_terms', 'respond_by', 'down_payment_pct',
  'home_sale_contingency', 'escalation_cap_cents', 'escalation_step_cents', 'possession', 'buyer_agent_fee_bp',
  'buyer_agent_fee_cents']);
select private.addon_phone_table('addon_realestate.offer_choices', 'deal_record_id', array['offer_id', 'person_id',
  'choice', 'words', 'at']);
select private.addon_phone_table('addon_realestate.financing', 'deal_record_id', array['lender_name',
  'officer_name', 'officer_email', 'officer_phone', 'loan_type', 'loan_amount_cents'], 'team', 'deal_record_id');
select private.addon_phone_table('addon_realestate.financing_steps', 'deal_record_id', array['step', 'status',
  'started_on', 'expected_on', 'done_on', 'amount_cents', 'rate', 'expires_on', 'note', 'done_at']);
select private.addon_phone_table('addon_realestate.inspections', 'deal_record_id', array['kind', 'inspector',
  'scheduled_at', 'report_expected_on', 'status', 'report_document_id', 'report_in_on', 'note']);
select private.addon_phone_table('addon_realestate.inspection_findings', 'deal_record_id', array['inspection_id',
  'title', 'location', 'severity', 'estimate_cents', 'client_priority', 'ask', 'credit_cents', 'position', 'note']);
select private.addon_phone_table('addon_realestate.repair_requests', 'deal_record_id', array['number', 'side', 'at',
  'words', 'items', 'credit_cents', 'respond_by', 'outcome']);
select private.addon_phone_table('addon_realestate.client_tasks', 'deal_record_id', array['kind', 'title', 'detail',
  'for_person_id', 'due_on', 'status', 'done_at', 'ref_kind', 'ref_id']);
select private.addon_phone_table('addon_realestate.listings', 'deal_record_id', array['facts', 'fact_sources',
  'facts_confirmed_at', 'highlights', 'mls_number', 'mls_live_on', 'slug', 'page_state', 'mls', 'mls_state',
  'mls_checked_at', 'showings_open', 'showing_confirm', 'showing_minutes'], 'team', 'deal_record_id');
select private.addon_phone_table('addon_realestate.listing_photos', 'deal_record_id', array['file_id', 'position',
  'caption', 'public']);
select private.addon_phone_table('addon_realestate.listing_descriptions', 'deal_record_id', array['version', 'words',
  'source', 'state', 'sent_at', 'signed_at', 'created_at']);
select private.addon_phone_table('addon_realestate.listing_posts', 'deal_record_id', array['batch', 'position',
  'words', 'state']);
select private.addon_phone_table('addon_realestate.listing_prices', 'deal_record_id', array['from_cents', 'to_cents',
  'words', 'note', 'state', 'applied_at', 'proposed_at']);
select private.addon_phone_table('addon_realestate.open_houses', 'deal_record_id', array['starts_at', 'ends_at',
  'host_user_id', 'appointment_id', 'state']);
select private.addon_phone_table('addon_realestate.open_house_visitors', 'deal_record_id', array['open_house_id',
  'person_id', 'first_name', 'last_name', 'email', 'phone', 'with_agent', 'agent_name', 'sms_consent', 'signed_in_at',
  'followed_up_at']);
select private.addon_phone_table('addon_realestate.net_sheets', 'deal_record_id', array['version', 'payoff_cents',
  'listing_fee_bp', 'listing_fee_cents', 'title_escrow_cents', 'transfer_tax_bp', 'other_cents', 'other_note', 'note',
  'saved_at']);
select private.addon_phone_table('addon_realestate.showings', 'deal_record_id', array['source', 'state', 'starts_at',
  'ends_at', 'agent_name', 'brokerage', 'agent_email', 'agent_phone', 'requested_at', 'decided_at', 'decision_note',
  'feedback', 'feedback_at', 'feedback_shared_at']);
select private.addon_phone_table('addon_realestate.field_notes', 'deal_record_id', array['about_kind', 'about_id',
  'body', 'audio_file_id', 'transcript', 'transcript_state', 'photo_file_ids', 'created_by', 'noted_at']);
select private.addon_phone_table('addon_realestate.walkthroughs', 'deal_record_id', array['appointment_id',
  'scheduled_at', 'state', 'started_at', 'finished_at', 'clients_agreed_at']);
select private.addon_phone_table('addon_realestate.walkthrough_items', 'deal_record_id', array['walkthrough_id',
  'source', 'source_ref', 'title', 'detail', 'state', 'note', 'photo_file_ids', 'checked_by', 'checked_at', 'duty_id',
  'position']);

-- The business's own: its vendors.
select private.addon_phone_table('addon_realestate.vendors', null, array['company_id', 'services', 'areas',
  'approved', 'disclosure', 'note', 'archived_at']);
