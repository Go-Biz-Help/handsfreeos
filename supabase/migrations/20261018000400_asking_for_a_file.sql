-- =============================================================================
-- Asking a customer for a file: a qualifying question they answer by sending
--        something, like a photo or PDF of their electric bill.
--
--        **The same link as a video's.** The AI teammate texts a link (the
--        video link of 20261018000300, asking for a file instead) and the
--        customer opens it signed out and sends photos or PDFs. Each one
--        lands in the conversation as their reply, exactly as a video does,
--        and is copied onto the lead's Files by the worker. A link that asks
--        for a file is made for one question of the AI teammate's settings
--        (`question_id`), with the question's words as they were asked
--        (`ask`), and for the lead it answers (`lead_id`), so whatever comes
--        back answers that question on that lead.
--
--        **Only the AI teammate asks for a file, for now.** It makes its links
--        as the worker, so a person's insert stays a video link, as before.
--
--        A file link lasts a week and takes five files, each up to 25 MB, the
--        `attachments` bucket's own limit, since that is where they end up.
-- =============================================================================

alter table app.video_links
  add column asks_for text not null default 'video' check (asks_for in ('video', 'file')),
  -- The lead the file answers. A lead deleted since leaves the file on the customer instead.
  add column lead_id uuid references app.leads (id) on delete set null,
  -- The qualifying question it answers (an id in the AI teammate's settings), and its words as asked.
  add column question_id text check (question_id is null or length(question_id) between 1 and 40),
  add column ask text check (ask is null or length(ask) between 1 and 200),
  add constraint video_links_file_question
    check (asks_for = 'video' or (question_id is not null and ask is not null));

create index video_links_lead_idx on app.video_links (lead_id) where lead_id is not null;

-- A person still makes video links only: a file link names a lead and a question, which the worker checks.
drop policy video_links_insert on app.video_links;
create policy video_links_insert on app.video_links for insert to authenticated
  with check (private.has_permission(workspace_id, 'inbox.use')
    and exists (select 1 from app.conversations c
                where c.id = conversation_id and c.workspace_id = video_links.workspace_id)
    and created_by = (select auth.uid()) and created_by_teammate_id is null
    and uploads_started = 0 and uploads_received = 0 and last_upload_at is null
    and asks_for = 'video' and lead_id is null and question_id is null and ask is null);

grant select (asks_for, lead_id, question_id, ask) on app.video_links to authenticated;
