-- =============================================================================
-- AI Social Media Content Creator: how its pictures look
-- (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 6; docs/socialcontent.md,
-- "How your pictures look").
--
--        settings.picture_look  the logo on its pictures ("corner", "last" or
--                               "never"), and the fonts and layouts the design
--                               AI may use (null or left out: the brand kit's
--                               font, and every layout). Saved with
--                               socialcontent.settings.save; read forgivingly
--                               (picture-look.ts, pictureLookOf).
--
--        Only adds a column, with a default, so the running code keeps working.
-- =============================================================================

alter table addon_socialcontent.settings
  add column picture_look jsonb not null default '{}'::jsonb;

alter table addon_socialcontent.settings
  add constraint settings_picture_look_object
    check (jsonb_typeof(picture_look) = 'object' and octet_length(picture_look::text) <= 2000);
