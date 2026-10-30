-- =============================================================================
-- Webinars, part 3: the AI asks the live poll's questions
-- (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md; the owner's answers of 29 October 2026).
--
--        The AI hearing the team in a HandsFreeOS video call matches what they
--        say to the call's live poll (20261027019800). How far it goes is the
--        call's `poll_ai` (the owner's 12):
--
--        - **ask** (the default): it pops a question up on its own when it's
--          sure the moment has come, and offers the team "Ask now?" when it's
--          only fairly sure;
--        - **suggest**: it only offers;
--        - **off**: the team asks every question.
--
--        A session's call starts with its calendar's choice; the team changes
--        it during the call.
--
-- Only widens.
-- =============================================================================

alter table app.video_calls
  add column poll_ai text not null default 'ask' check (poll_ai in ('ask', 'suggest', 'off'));

comment on column app.video_calls.poll_ai is
  'How far the AI hearing the team goes with the live poll: ask (pops a question up when sure, offers the rest), suggest (only offers) or off.';

-- The team changes it during the call, like the poll itself.
grant update (poll_ai) on app.video_calls to authenticated;
