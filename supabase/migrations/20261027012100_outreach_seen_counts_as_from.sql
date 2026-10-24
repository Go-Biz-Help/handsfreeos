-- Social Outreach: where people live (docs/outreach.md, decision 86). A country "seen" until now could be a "From"
-- line, or the AI's word for one, so it can't be told from From: each such country counts as From, which skips nobody
-- until a look says where they live. One the setting lets through still is.
--
-- Apply it once the code that knows `from` is running: the code before it refuses to list a `from` on the Skipped for
-- country list. Until then, the new code reads these as seen, as the old code did.
update addon_outreach.profiles set country_how = 'from' where country_how = 'seen';
