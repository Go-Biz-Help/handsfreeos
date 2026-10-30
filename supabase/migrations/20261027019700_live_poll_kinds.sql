-- =============================================================================
-- Webinars, part 2, a: a live poll is a kind of form, and its answers come
-- from a video call (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md; the owner's
-- 8). Alone in their file: Postgres can't use a new enum value in the
-- transaction that adds it, and 20261027019800_live_polls.sql uses them.
-- =============================================================================

alter type app.form_mode add value if not exists 'poll';
alter type app.form_source add value if not exists 'video_call';
