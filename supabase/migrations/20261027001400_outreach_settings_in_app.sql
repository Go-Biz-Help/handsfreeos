-- =============================================================================
-- Social Outreach (outreach): every setting in HandsFreeOS (docs/outreach.md,
-- decisions 37 to 40).
--
--        `automation` takes in the extension's three switches, which it
--        kept on each computer until now (noting the person's steps,
--        reading chats as they're opened, looking for posts while
--        scrolling), how the phone hears about messages waiting, and who
--        last changed someone's choices when it wasn't them (an owner or
--        admin). The business's rules live with its Social Outreach
--        settings, in `app.addon_installations.settings`.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

alter table addon_outreach.automation
  add column noting boolean not null default true,
  add column read_chats boolean not null default true,
  add column mark_posts boolean not null default true,
  add column pushes text not null default 'bundled' check (pushes in ('bundled', 'each')),
  add column changed_by uuid references app.users (id) on delete set null;
