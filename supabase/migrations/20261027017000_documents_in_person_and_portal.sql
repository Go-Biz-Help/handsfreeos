-- =============================================================================
-- Documents and e-signatures, part 2: the AI places the fields, Sign now in
-- person, and documents in the customer's portal (docs/documents.md; the
-- owner's answers 4a, 10b and 13a of 28 October 2026).
--
--        - **The AI placing fields** on an uploaded PDF counts its tokens as
--          `documents` (app.ai_usage). Nothing new is kept: the fields it
--          suggests are saved with the template, as the editor saves any.
--        - **Sign now** (13a): a signer marked "with you" when it's sent
--          (`in_person`) gets no link at their turn; the team member hands
--          their phone or tablet over instead, through `document.sign_now`,
--          which records the hand-over (an `in_person` step, by them) and,
--          when the template asks for a code, checks it for them: they say
--          who's holding it. That command runs as the person, so they may
--          note a code checked on a signer whose turn it is, on a document
--          still out, and add that step.
--        - **The portal** (10b): a customer signed in to their portal sees
--          the documents they sign or get a copy of (not voided ones), whose
--          turn it is, and opens one there. Opening from the portal checks
--          their code, if the template asks for one: signing in to the
--          portal was a code to the same person.
--
-- Only adds: an AI usage source, a column, a step kind, a policy and a column
-- grant for the person, and the portal's reads.
-- =============================================================================

alter type app.ai_usage_source add value if not exists 'documents';

-- ---------- Sign now ----------
alter table app.document_signers add column in_person boolean not null default false;
comment on column app.document_signers.in_person is
  'Marked "with you" when it was sent: no link goes at their turn, they sign on the team''s device (answer 13a).';

alter table app.document_steps drop constraint document_steps_kind_check;
alter table app.document_steps add constraint document_steps_kind_check
  check (kind in ('prepared', 'sent', 'reminded', 'opened', 'code_sent', 'code_checked', 'agreed', 'signed',
    'declined', 'voided', 'expired', 'completed', 'copy_sent', 'in_person'));

-- Handing a document over: its code checked by the team member, on a signer still to sign a document still out.
create policy document_signers_update on app.document_signers for update to authenticated
  using (private.has_permission(workspace_id, 'documents.send') and kind = 'signer'
    and status in ('waiting', 'sent', 'opened')
    and document_id in (select d.id from app.documents d where d.status = 'out'))
  with check (private.has_permission(workspace_id, 'documents.send'));
grant update (code_checked_at, updated_at) on app.document_signers to authenticated;

alter policy document_steps_insert on app.document_steps
  with check (private.has_permission(workspace_id, 'documents.send') and by_user_id = (select auth.uid())
    and ((kind in ('prepared', 'voided') and signer_id is null)
      or (kind = 'in_person' and signer_id is not null))
    and document_id in (select d.id from app.documents d));

-- ---------- the portal ----------
-- The documents the customer asking is on (not voided ones), and their own places on them. Only under
-- portal_actor.
create or replace function portal.document_signer_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select s.id
  from app.document_signers s join portal.session() p
    on p.person_id = s.person_id and p.workspace_id = s.workspace_id
  join app.documents d on d.id = s.document_id
  where d.status <> 'voided'
$$;

create or replace function portal.document_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select s.document_id
  from app.document_signers s join portal.session() p
    on p.person_id = s.person_id and p.workspace_id = s.workspace_id
  join app.documents d on d.id = s.document_id
  where d.status <> 'voided'
$$;

revoke all on function portal.document_signer_ids(), portal.document_ids() from public;
grant execute on function portal.document_signer_ids(), portal.document_ids() to portal_actor;

-- Every signer of their documents, for whose turn it is, without who the others are or how to reach them.
create policy document_signers_portal_select on app.document_signers for select to portal_actor
  using (document_id in (select portal.document_ids()));
grant select (id, workspace_id, document_id, kind, role_label, position, status, in_person, signed_at, declined_at)
  on app.document_signers to portal_actor;

create policy documents_portal_select on app.documents for select to portal_actor
  using (id in (select portal.document_ids()) and status <> 'voided');
grant select (id, workspace_id, name, status, sent_at, expires_at, completed_at, all_signed_at, signed_file_id)
  on app.documents to portal_actor;
