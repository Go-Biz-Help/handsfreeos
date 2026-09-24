-- Automations' "Repeated corrections" no longer waits for three: the AI reads each edit or rejection of the AI
-- teammate's drafts as it happens, and offers a line of guidance from the first one that teaches it something.
--
-- A lesson that goes against what the AI already knows says so, instead of adding a line that contradicts it:
-- `conflict` holds where (a field of the business profile, or a knowledge item), the words there now, what they'd
-- become, and the clash in plain words. The card asks which is right; teammate_lesson.apply with `replace` swaps
-- the old words for the new ones, and dismissing it keeps them.

alter table app.teammate_lessons
  add column conflict jsonb check (conflict is null or jsonb_typeof(conflict) = 'object');

-- What it goes against is part of what the worker suggested, like the line itself.
drop trigger teammate_lessons_immutable on app.teammate_lessons;
create trigger teammate_lessons_immutable before update on app.teammate_lessons
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'teammate_id', 'line',
    'conflict');
