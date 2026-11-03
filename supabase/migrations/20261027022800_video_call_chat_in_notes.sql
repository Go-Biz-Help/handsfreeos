-- =============================================================================
-- HandsFreeOS video calls: the chat goes in the AI's notes too
-- (docs/video-calls.md, "The chat in the AI's notes"; the owner, 3 November 2026).
--
--        The owner asked for HandsFreeOS to get what people type in a
--        call's chat as well as what they say. While a call's AI notes are
--        on, the AI's listener, already in the room unseen, reads the chat
--        too, and keeps each message as a line beside the spoken ones. So
--        the appointment's transcript has it ("Dana (in the chat): …"), and
--        the summary, the follow-up, the new email or phone number it
--        suggests and the coach all use it. With AI notes off nothing of
--        the chat is kept, as before, and turning them off forgets what was
--        typed with what was said.
--
-- Only widens: one column, false for every line kept so far, so the running
-- listener (which doesn't send it) keeps working.
-- =============================================================================

alter table app.video_call_lines
  add column typed boolean not null default false;

comment on column app.video_call_lines.typed is
  'Typed in the call''s chat rather than said: shown as "(in the chat)" in the transcript and to the coach.';
