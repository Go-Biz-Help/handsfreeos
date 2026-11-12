-- "Hide the website chat until texting is approved" (the owner, 2026-11-12).
--
-- A business whose customers agree to texts on a form sometimes wants its website chat out of the way while the
-- carriers review the registration. The chat is paused as usual (paused_at: its code on the site shows nothing), and
-- this says the pause lasts only until texting is approved: the worker turns those chats back on when the carriers say
-- yes. Turning a chat on by hand clears it too.
alter table app.chat_widgets
  add column if not exists hidden_until_texting boolean not null default false;

comment on column app.chat_widgets.hidden_until_texting is
  'Paused only until the business''s texting registration is approved, then turned back on by the worker.';

-- Set and cleared with paused_at, by chat_widget.hide_until_texting (and cleared by chat_widget.resume).
grant update (hidden_until_texting) on app.chat_widgets to authenticated;
