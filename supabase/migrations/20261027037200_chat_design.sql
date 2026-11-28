-- Website chat in design tools (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 4): a chat gets the font and
-- corners forms have (or follows the brand kit's), a greeting bubble that pops up beside its button after a few
-- seconds, and a face in its top bar (a picture from Your pictures) instead of the logo or initials. Match my
-- website fills its colours, font and corners from the business's site.
--
-- Only columns are added, each null or with a default that keeps what every chat already does: running code that
-- never reads them keeps working, and a chat nobody touches looks as it did.

alter table app.chat_widgets
  -- A Google font's name, as Google spells it; null: the brand kit's, and the computer's own when it has none.
  add column font text check (
    font is null or (length(font) <= 60 and font ~ '^[A-Za-z0-9]([A-Za-z0-9]| [A-Za-z0-9])*$')
  ),
  -- The corners of the chat, its boxes and its button; null: the brand kit's, and slight when it has none.
  add column corners text check (corners is null or corners in ('square', 'slight', 'round')),
  -- The words that pop up beside the button ("Need a quote? I can help."); null: no bubble.
  add column bubble text check (bubble is null or length(btrim(bubble)) between 1 and 120),
  -- How many seconds on the page before the bubble shows.
  add column bubble_after smallint not null default 8 check (bubble_after between 1 and 120),
  -- A picture from Your pictures in the top bar: {path, width, height}; null: the logo or the initials.
  add column face jsonb check (
    face is null or (
      jsonb_typeof(face) = 'object'
      and face ->> 'path' ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.webp$'
    )
  );

-- People change these through chat_widget.update, like the look columns granted beside them.
grant update (font, corners, bubble, bubble_after, face) on app.chat_widgets to authenticated;
