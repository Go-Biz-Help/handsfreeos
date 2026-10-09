/**
 * Facebook's warnings: that you're blocked from something for a while, that you went too fast, that your account
 * needs checking. The extension stops for the day on any of them (../panel/warnings.ts). Only dialogs, alerts, headings
 * and Facebook's checkpoint pages count, never a post or a comment in them: a post about being blocked is not a
 * warning.
 */
import { clean, textLines } from './dom';
import { facebookUrl, pathParts } from './urls';

const WARNINGS: readonly RegExp[] = [
  /\btemporarily (blocked|restricted|limited)\b/i,
  /\byou can(['’]t|not) (use this feature|send|comment|post|join|react|add|message|reply)\b/i,
  /\b(misusing (this|a) feature|going too fast|too fast|too often|suspicious activity|unusual activity)\b/i,
  /\bwe limit how often\b/i,
  /\byour account (has been|was|is|got) (locked|restricted|suspended|disabled|limited)\b/i,
  /\b(confirm|verify) (your identity|it['’]s you|that this is your account)\b/i,
  /\bsecurity check\b/i,
  /\breached (the|your) limit\b/i,
  /\b(looks like spam|marked as spam|against our community standards)\b/i,
];

/** Where Facebook puts its warnings. */
const PLACES = '[role="dialog"], [role="alertdialog"], [role="alert"], h1, h2, [role="heading"]';

/** Facebook's warnings on the page, each once, as Facebook worded them. */
export function readWarnings(doc: Document, href: string): string[] {
  const found = new Set<string>();
  const url = facebookUrl(href);
  if (url && pathParts(url)[0]?.toLowerCase() === 'checkpoint')
    found.add('Facebook is asking you to check your account before you go on.');
  for (const place of doc.querySelectorAll(PLACES)) {
    // A heading in a post or a comment is somebody's writing, not Facebook's.
    if (!place.matches('[role="dialog"], [role="alertdialog"], [role="alert"]')) {
      if (place.closest('[role="article"], [role="feed"]')) continue;
    }
    for (const line of textLines(place, 40, '[role="article"], [role="feed"]')) {
      if (line.length <= 300 && WARNINGS.some((pattern) => pattern.test(line)))
        found.add(clean(line));
      if (found.size >= 5) return [...found];
    }
  }
  return [...found];
}
