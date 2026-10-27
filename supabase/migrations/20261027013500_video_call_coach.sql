-- =============================================================================
-- HandsFreeOS's own video calls, part 3: the Sales Coach in the call
-- (docs/video-calls.md; the owner's answers of 27 October 2026).
--
--        The AI's listener already hears each person in a call (part 2).
--        While the call's AI notes are on and someone on the team in it is
--        coached, each stretch of the call becomes a live meeting
--        (app.live_meetings) for that person, as a Zoom meeting is, and the
--        words go to the add-ons that listen: the coach's cards beside the
--        video, its write-up and score after. Nobody claims it: the call
--        knows who's in it and who the customer is.
--
-- Only widens: live meetings can come from HandsFreeOS video calls too.
-- =============================================================================

alter table app.live_meetings drop constraint live_meetings_provider_check,
  add constraint live_meetings_provider_check check (provider in ('zoom', 'handsfree'));
