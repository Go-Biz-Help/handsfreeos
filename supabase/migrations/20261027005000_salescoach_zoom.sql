-- =============================================================================
-- AI Sales Coach, round three: Zoom meetings
-- (HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md, docs/salescoach.md).
--
--        A coached record was one of core's phone calls or a stretch of a
--        written conversation. Now it can be a Zoom meeting the coach heard
--        live (core's `app.live_meetings`), coached and written up like a call.
--        Exactly one of the three is set, and a meeting has one coached record.
-- =============================================================================

alter table addon_salescoach.calls
  add column live_meeting_id uuid references app.live_meetings (id) on delete cascade,
  drop constraint calls_call_or_conversation,
  add constraint calls_call_conversation_or_meeting
    check (num_nonnulls(call_id, conversation_id, live_meeting_id) = 1);

create unique index calls_live_meeting_idx on addon_salescoach.calls (live_meeting_id)
  where live_meeting_id is not null;
