/**
 * "Intake questions": the text or email that sends a first-time customer the business's intake form right after
 * they book. Browser-safe, so Settings shows the same preview and verdict the worker sends with.
 *
 * It may fill in only {firstName}, {businessName} and {link}, and it must have {link}: a message about a form
 * that doesn't carry the form is no use to anybody.
 */
import { plainSmsText } from '../ai-team/guardrails';

export const INTAKE_PLACEHOLDERS = ['firstName', 'businessName', 'link'] as const;
export type IntakePlaceholder = (typeof INTAKE_PLACEHOLDERS)[number];

/** Straight apostrophes: a curly one sends a text in the slower encoding. */
export const DEFAULT_INTAKE_MESSAGE =
  'Hi {firstName}, thanks for booking with {businessName}! Before your visit, could you answer a few quick questions? {link}';

const TOKEN_RE = /\{\{[^{}]*\}\}|\{[^{}]*\}/g;
const isPlaceholder = (name: string): name is IntakePlaceholder =>
  (INTAKE_PLACEHOLDERS as readonly string[]).includes(name);

/** What's wrong with the wording, in plain words, or null. */
export function intakeMessageProblem(template: string): string | null {
  for (const m of template.matchAll(TOKEN_RE)) {
    const name = m[0].replace(/[{}]/g, '').trim();
    if (m[0].startsWith('{{') || !isPlaceholder(name))
      return `${m[0]} can't be filled in. Use {firstName}, {businessName} or {link}.`;
  }
  if (!/\{\s*link\s*\}/.test(template)) return 'Put {link} where the form’s link goes.';
  return null;
}

/** Fills the wording: a blank first name reads "there". */
export function renderIntakeMessage(
  template: string,
  values: {
    readonly firstName: string | null;
    readonly businessName: string;
    readonly link: string;
  },
): string {
  const text = template.replace(TOKEN_RE, (whole) => {
    const name = whole.slice(1, -1).trim();
    if (whole.startsWith('{{') || !isPlaceholder(name)) return whole;
    if (name === 'firstName') return values.firstName?.trim() || 'there';
    return values[name];
  });
  return plainSmsText(text)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .trim();
}
