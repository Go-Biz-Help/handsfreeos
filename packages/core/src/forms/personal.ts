/**
 * A form that knows who's filling it in (funnels): their own link, `/f/<site>/<form>?k=<key>`, or a sheet whose
 * details they already gave on an earlier page.
 *
 * Two things change for them. A question that fills a contact detail we already have is skipped, so a funnel
 * texted to a lead doesn't ask their name again. And the form's words can greet them: `{{person.first_name}}`
 * in a heading, a question or a block of text, written the way a workflow's texts write it, with an optional
 * `| default:"there"` for when we don't know it.
 *
 * Nothing on file is ever shown back: a forwarded link would show it to whoever opened it. Only the first name,
 * for the greeting. Browser-safe.
 */
import type { FormDefinition } from './definition';
import type { AnswerSheet } from './logic';

/** The contact details a personal link already has, and so doesn't ask for again. */
export const KNOWN_CONTACT_TARGETS = [
  'person.first_name',
  'person.last_name',
  'person.email',
  'person.phone',
] as const;

/** Who is filling it in, as far as the engine needs to know. */
export interface FillContext {
  /** Answer targets we already have for them: a question that fills one is skipped. */
  readonly known?: ReadonlySet<string>;
}

/** Which contact details the customer has on file, as answer targets. */
export function knownTargetsOf(person: {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
}): Set<string> {
  const known = new Set<string>();
  const has = (v: string | null | undefined) => typeof v === 'string' && v.trim() !== '';
  if (has(person.firstName)) known.add('person.first_name');
  if (has(person.lastName)) known.add('person.last_name');
  if (has(person.email)) known.add('person.email');
  if (has(person.phone)) known.add('person.phone');
  return known;
}

/** How long a personal link works. */
export const FORM_LINK_DAYS = 30;

/** `/f/<site>/<form>?k=<key>`: the form's own address, with the key that says who it's for. */
export const personalFormQuery = (key: string): string => `k=${encodeURIComponent(key)}`;

// ---- Their name in the words ----

const NAME_TAG =
  /\{\{\s*person\.first_name\s*(?:\|\s*default\s*:\s*(?:"([^"]*)"|'([^']*)'))?\s*\}\}/g;

/** Whether some words greet them by name. */
export const greetsByName = (text: string): boolean => new RegExp(NAME_TAG.source).test(text);

/**
 * The words with their first name in. Without a name and without a default, the tag goes along with the comma
 * or space that only made sense beside it: "Glad you’re here, {{person.first_name}}!" reads "Glad you’re here!",
 * and "Hi {{person.first_name}}, welcome" reads "Hi, welcome".
 */
export function fillWords(text: string, who: { readonly firstName: string | null }): string {
  if (!text.includes('{{')) return text;
  const name = who.firstName?.trim() || null;
  const out = text.replace(
    new RegExp(`(,?[ \\t]*)?${NAME_TAG.source}`, 'g'),
    (_all, before: string | undefined, dq: string | undefined, sq: string | undefined) => {
      const fallback = dq ?? sq;
      if (name) return `${before ?? ''}${name}`;
      if (fallback !== undefined) return `${before ?? ''}${fallback}`;
      return '';
    },
  );
  // A greeting that now starts with a stray comma: "{{person.first_name}}, welcome" without a name.
  return out.replace(/^\s*,\s*/, '').replace(/[ \t]{2,}/g, ' ');
}

/**
 * The first name to greet them with: what they typed into a question that fills it (its first word), else the
 * one we already have.
 */
export function firstNameFor(
  definition: Pick<FormDefinition, 'pages'>,
  answers: AnswerSheet,
  known: string | null,
): string | null {
  for (const page of definition.pages)
    for (const question of page.questions) {
      if (question.mapTo !== 'person.first_name') continue;
      const value = answers[question.id];
      if (typeof value === 'string' && value.trim()) return value.trim().split(/\s+/)[0]!;
    }
  return known?.trim() || null;
}

/**
 * The form as they read it: their first name in its title, intro, page headings, questions and text blocks. The
 * definition itself is never changed, so what's recorded keeps the business's own wording.
 */
export function fillFormWords(
  definition: FormDefinition,
  who: { readonly firstName: string | null },
): FormDefinition {
  const words = (text: string) => fillWords(text, who);
  return {
    ...definition,
    title: words(definition.title),
    intro: words(definition.intro),
    pages: definition.pages.map((page) => ({
      ...page,
      title: words(page.title),
      questions: page.questions.map((question) => ({
        ...question,
        title: words(question.title),
        help: words(question.help),
        ...(question.type === 'content'
          ? { config: { ...question.config, body: words(question.config.body) } }
          : {}),
      })) as typeof page.questions,
    })),
  };
}
