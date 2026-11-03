-- =============================================================================
-- AI Sales Coach: start the coach again on a call you stopped it on (docs/salescoach.md).
--
--        Stopping the coach used to end its call there. Now a stopped call stays open until the call itself ends
--        (`salescoach.call.end` sets `ended_at`), and the rep may start the coach again until then
--        (`salescoach.call.resume`). Row security lets the rep change their own call while it's live, or stopped
--        and still going, only to live or stopped, and never once it has a write-up.
--
--        Altered, not dropped: the rule before still holds for the code running while this goes out.
-- =============================================================================

alter policy calls_own_stop on addon_salescoach.calls
  using (
    user_id = (select auth.uid())
    and (state = 'live' or (state = 'stopped' and ended_at is null))
  )
  with check (
    user_id = (select auth.uid())
    and state in ('live', 'stopped')
    and result is null
  );
