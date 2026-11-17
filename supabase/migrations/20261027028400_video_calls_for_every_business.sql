-- HandsFreeOS video calls for every business.
--
--   The owner's decision 16 (docs/video-calls.md) was test businesses first, then every business once the call, the
--   AI's notes and the coach were in. They are, and on 17 November 2026 the owner chose to turn calls on for every
--   business so the website can sell video calls and webinars. Until now support turned them on one business at a
--   time in /admin (`private.set_video_calls`).
--
--   From here every new business starts with calls on, and every business that has them off gets them. None was
--   ever turned off on purpose (one `video_calls.changed` event, turning one on), and no business with calls off had
--   an Online place, so no booking changes under anyone. Support can still turn one business off in /admin.
--
--   Calls are paid for on the business's usage balance, as before ("Usage balances: what businesses pay us" in
--   docs/operations.md).

alter table app.workspaces alter column video_calls set default true;

update app.workspaces set video_calls = true where not video_calls;

comment on column app.workspaces.video_calls is
  'HandsFreeOS video calls: on for every business since 20261027028400; support can turn one off in /admin (private.set_video_calls).';
