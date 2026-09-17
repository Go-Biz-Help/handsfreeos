/**
 * How a "not applied" timeline entry reads after who made it (M10: newest wins). Browser-safe: the web's timeline and
 * the phone's say exactly the same thing.
 *
 * - A change of state a later change overtook carries `tried` and `because`: "tried to close the conversation, but
 *   Maria wrote again after that".
 * - An edit to a detail (field merge) carries the detail's label, what it wanted and what stays: "tried to change the
 *   phone number to “(713) 555-0199”, but Sam Admin’s later change to “(713) 555-0142” was kept". Values are shown for
 *   names, contact details and notes; a detail with no words to show (a company, a date) has none.
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The words after the actor's name, from the entry's `meta`. */
export function notAppliedWords(meta: Readonly<Record<string, unknown>>): string {
  const tried = str(meta.tried);
  const because = str(meta.because);
  if (tried && because) return `tried to ${tried}, but ${because}`;
  const detail = str(meta.label) ? `the ${str(meta.label)}` : 'a detail';
  const later = str(meta.keptBy) ? `${str(meta.keptBy)}’s later change` : 'a later change';
  const wanted = meta.wanted;
  const stays = meta.stays;
  if (typeof wanted !== 'string' || typeof stays !== 'string')
    return `tried to change ${detail}, but ${later} was kept`;
  const attempt = wanted ? `tried to change ${detail} to “${wanted}”` : `tried to clear ${detail}`;
  return `${attempt}, but ${later}${stays ? ` to “${stays}”` : ', which cleared it,'} was kept`;
}
