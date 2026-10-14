-- =============================================================================
-- Social Outreach (outreach): the Never contact list (docs/outreach.md).
--
--        Stronger than Don't pitch: nobody here sends them a friend request,
--        a like, a comment or a message, not even a reply; their friend
--        requests are never confirmed and never shown to decide; a reply of
--        theirs pushes nobody; and they're never checked or researched.
--        Like Don't pitch, it's the business's, says who added each person
--        and when, and covers a profile kept twice under the same name.
-- =============================================================================

alter table addon_outreach.profiles
  add column never_contact boolean not null default false,
  add column never_contact_by uuid references app.users (id) on delete set null,
  add column never_contact_at timestamptz,
  add constraint profiles_never_contact_check
    check (never_contact or (never_contact_by is null and never_contact_at is null));
create index profiles_never_contact_idx on addon_outreach.profiles (workspace_id) where never_contact;
create index profiles_never_contact_by_idx on addon_outreach.profiles (never_contact_by)
  where never_contact_by is not null;
