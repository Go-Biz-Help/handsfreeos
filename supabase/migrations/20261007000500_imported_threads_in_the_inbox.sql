-- =============================================================================
-- 0108 · The threads a move from GoHighLevel brought, back in the inbox.
--
--        The GoHighLevel adapter brought every thread with no unread message
--        across closed, and every thread split off by channel closed too. The
--        inbox lists open threads, so a business opened it after the move and
--        found most of its customers missing: the conversation was on the
--        customer's page and nowhere in the list. The adapter now brings them
--        open, because GoHighLevel has no closed thread and its inbox lists
--        every one. This puts the ones already brought where they belong.
--
--        Only threads nobody here has touched the status of, and only threads
--        a GoHighLevel move made:
--
--          made by the move       its 'create' in the change journal, not
--                                 taken back. A thread the move only folded
--                                 into was the business's own and stays as it
--                                 is.
--          closed by the import   closed_at is null. Closing a thread by hand
--                                 stamps it, and so does a thread HandsFreeOS
--                                 starts closed for a booking reminder.
--          never changed since    status_changed_at is null (0063). A thread a
--                                 person closed and a customer reopened, or
--                                 the other way round, says when; this one
--                                 still reads as the import left it.
--          not archived           a thread somebody put away stays put away.
--
--        Still not work: nothing here writes an unread count or a waiting
--        clock, so nothing lands on a badge or in the Action Center. Reopening
--        brings each thread's older messages back to the phone, through 0056's
--        trigger, which is what an open thread is for.
-- =============================================================================

update app.conversations c
set status = 'open'
where c.status = 'closed'
  and c.closed_at is null
  and c.status_changed_at is null
  and c.archived_at is null
  and exists (
    select 1
    from app.migration_change_journal j
    join app.migrations m on m.id = j.migration_id
    where j.workspace_id = c.workspace_id
      and j.target_type = 'conversation'
      and j.target_id = c.id
      and j.action = 'create'
      and j.reverted_at is null
      and m.source_system = 'gohighlevel');
