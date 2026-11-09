-- AI Social Media Content Creator: what the reading computer is doing, as it does it (docs/socialcontent.md, "What
-- it's doing"). Only adds columns.
--
-- work.progress: the extension's running account of one thing it's doing (the words it's searching, the searches
--   done, how many accounts it looked at, profiles it read, posts it read), and HandsFreeOS's own counts of who was
--   suggested and who didn't fit. Shown on the Creators page while it works and after.
-- settings.reader_seen_at, reader_version: when the reading computer last asked for work, and its extension's
--   version, so the page can say whether it's there at all.

alter table addon_socialcontent.work
  add column progress jsonb
    check (progress is null or (jsonb_typeof(progress) = 'object' and octet_length(progress::text) <= 4000));

alter table addon_socialcontent.settings
  add column reader_seen_at timestamptz,
  add column reader_version text check (reader_version is null or length(reader_version) <= 20);
