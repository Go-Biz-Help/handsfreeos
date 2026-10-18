-- Calls think with Claude Haiku 5.5 for every business.
--
--   The worker's VOICE_MODEL is now Claude Haiku 5.5 unless set. Support had moved most businesses to Claude
--   Haiku 4.5 under AI on their calls, for faster replies than the old default; those picks go back to Default
--   so they get Haiku 5.5 too. Support can still pick Haiku 4.5 for one business in /admin.
--
--   Apply it when the worker that defaults to Haiku 5.5 ships, not before: until then Default is AI_MODEL.

update app.workspaces set phone_model = null where phone_model = 'claude-haiku-4-5';
