-- Website chats in Forms (2026-11-01): every chat a business has is listed under Forms and edited the same way,
-- the texting registration's chat included. A chat gets a name of its own, its button is placed separately on
-- phones and computers (which corner, how far up from the bottom, the full label or only the round icon, or
-- hidden on phones), it gets more of its colours and the choice of showing the business's logo, and it says
-- what happens while nobody is answering.
--
-- Only columns are added, each with a default that keeps what every chat already does: running code that never
-- reads them keeps working, and a chat nobody touches looks and behaves as it did.

alter table app.chat_widgets
  -- What the business calls it in Forms; null: its first site ("lonestarhvac.com").
  add column name text check (name is null or length(btrim(name)) between 1 and 60),
  -- The button on a phone (a screen up to 480 pixels wide): its corner, null meaning the same as on a computer.
  add column mobile_position text check (mobile_position is null or mobile_position in ('right', 'left')),
  -- How many pixels higher than its usual spot the button sits, so it can clear a bar along the bottom of the site.
  add column desktop_lift smallint not null default 0 check (desktop_lift between 0 and 300),
  add column mobile_lift smallint not null default 0 check (mobile_lift between 0 and 300),
  -- The button's shape: its label beside the icon, or only the round icon; on phones it can also be hidden, the
  -- chat then opening from a link to #hfos-chat on the site.
  add column desktop_button text not null default 'label' check (desktop_button in ('label', 'icon')),
  add column mobile_button text not null default 'label' check (mobile_button in ('label', 'icon', 'hidden')),
  -- The words on the button and the chat's top bar; null: white or near-black, whichever reads on its colour.
  add column text_color text check (text_color is null or text_color ~ '^#[0-9a-fA-F]{6}$'),
  -- The chat's top bar; null: the button's colour (accent_color).
  add column header_color text check (header_color is null or header_color ~ '^#[0-9a-fA-F]{6}$'),
  -- The business's logo (Settings → Workspace) at the top of the chat; off: its initials.
  add column show_logo boolean not null default true,
  -- While nobody is answering (no AI teammate working and the business closed): the away message with a short
  -- form first ('away_form', as every chat did), or the chat as usual, saying the team will answer later ('chat').
  add column when_away text not null default 'away_form' check (when_away in ('away_form', 'chat'));

-- People change these through chat_widget.update, like the columns granted beside them in ai_team_grants.
grant update (name, mobile_position, desktop_lift, mobile_lift, desktop_button, mobile_button, text_color,
  header_color, show_logo, when_away)
  on app.chat_widgets to authenticated;
