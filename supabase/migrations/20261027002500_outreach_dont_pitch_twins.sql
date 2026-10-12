-- Social Outreach: Don't pitch covers a person's twin (docs/outreach.md). Facebook shows one person by number in one
-- place and by username in another, so the same person can be kept twice; a profile kept under the same name on the
-- same network as one marked never pitched is never pitched either. This finds the twins by name quickly.
create index profiles_name_key_idx on addon_outreach.profiles
  (workspace_id, platform, lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')));
