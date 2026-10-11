-- Social Outreach: how the AI writes for each person (docs/outreach.md, "How the AI writes"). Each picks their own
-- voice on the Settings tab: short forms like "u", text acronyms like "lol", an emoji now and then, and whether a
-- message goes as a few short texts, a few seconds apart (on to start, the way people text).
alter table addon_outreach.automation
  add column voice_shorthand boolean not null default false,
  add column voice_acronyms boolean not null default false,
  add column voice_emoji boolean not null default false,
  add column voice_split boolean not null default true;
