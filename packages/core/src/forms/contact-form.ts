/**
 * The contact form a business's texting approval rests on (the owner, 2026-11-22): "we should just automatically
 * create an a2p compliant contact form when someone creates an account and if it's not there it should be created
 * when they start the a2p process".
 *
 * **Which form it is.** Any published form that asks who they are and for a phone number already shows our box to
 * agree to texts (`texting-box.ts`), so a business that has one keeps it: the one already allowed on its website
 * first, then the one it has had longest, so the answer doesn't change from one day to the next. A business with
 * none gets the "Get in touch" starter, published, with a public link.
 *
 * **Where it may show.** A form is framed only on the sites it lists, so the business's website is added to them
 * here, and texting approval's code works the moment it's pasted.
 *
 * Runs inside `registration.ensure_contact_form`: for the person starting texting approval, and for the system when
 * a business is made. Safe to run again. Server-only.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { sql } from '@hfos/db/client';
import { forms, formVersions, workspaces } from '@hfos/db/schema';
import { ensureBookingSite } from '../calendar/site';
import { normalizeChatOrigins } from '../chat/origins';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import type { CommandContext } from '../kernel/types';
import { allQuestions, type FormDefinition } from './definition';
import { formIssues, freeFormSlug, parseStoredForm } from './load';
import { asksSomething } from './questions';
import { starterByKey, starterForm } from './starters';
import { worksAsContactForm } from './texting-box';

/** The starter a business without a contact form is given. */
export const CONTACT_FORM_STARTER = 'enquiry';

export interface ContactForm {
  readonly formId: string;
  readonly name: string;
  readonly slug: string;
  /** Its public link is `/f/<siteSlug>/<slug>`. */
  readonly siteSlug: string;
  readonly embedOrigins: string[];
  /** Made just now, rather than one the business already had. */
  readonly created: boolean;
}

const asJson = (d: FormDefinition) => d as unknown as Record<string, unknown>;

/** A stored version as a form, or null when it can't be read: such a form is passed over, not a reason to stop. */
function readable(raw: unknown): FormDefinition | null {
  try {
    return parseStoredForm(raw);
  } catch {
    return null;
  }
}

/** The website's exact addresses (with the www twin), or none when it isn't an address a form can be listed on. */
function sitesOf(website: string): string[] {
  if (!website) return [];
  const { origins, issues } = normalizeChatOrigins([website], { allowNone: true, what: 'A form' });
  return issues.length ? [] : origins;
}

export async function ensureContactForm(
  ctx: CommandContext,
  typedWebsite?: string | null,
): Promise<ContactForm> {
  const ws = ctx.scope.workspaceId!;
  const by = userIdOf(ctx.actor);
  // One at a time for a business: sign-up's and texting approval's can arrive together, and would each make one.
  await ctx.tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`contact_form:${ws}`}, 0))`,
  );

  const [business] = await ctx.tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ws));
  const settings = (business?.settings ?? {}) as Record<string, unknown>;
  const website =
    (typedWebsite ?? '').trim() ||
    (typeof settings['website'] === 'string' ? settings['website'].trim() : '');
  const sites = sitesOf(website);

  const live = await ctx.tx
    .select({
      id: forms.id,
      name: forms.name,
      slug: forms.slug,
      embedOrigins: forms.embedOrigins,
      inChat: forms.inChat,
      definition: formVersions.definition,
    })
    .from(forms)
    .innerJoin(formVersions, eq(formVersions.id, forms.activeVersionId))
    .where(
      and(
        eq(forms.workspaceId, ws),
        isNull(forms.archivedAt),
        eq(forms.status, 'live'),
        eq(forms.mode, 'form'),
      ),
    )
    .orderBy(asc(forms.createdAt), asc(forms.id));
  const usable = live.filter((f) => {
    const definition = readable(f.definition);
    return !!definition && worksAsContactForm(definition);
  });
  const allowedOn = (f: (typeof usable)[number]) =>
    sites.length > 0 && sites.some((s) => (f.embedOrigins ?? []).includes(s));
  const found = usable.find(allowedOn) ?? usable[0];

  if (found) {
    const site = await ensureBookingSite(ctx.tx, ws, by);
    const had = found.embedOrigins ?? [];
    const missing = sites.filter((s) => !had.includes(s));
    const embedOrigins = [...had, ...missing];
    if (missing.length) {
      await ctx.tx.update(forms).set({ embedOrigins }).where(eq(forms.id, found.id));
      await ctx.emit({
        type: 'form.delivery_changed',
        entityType: 'form',
        entityId: found.id,
        payload: { embedOrigins, inChat: found.inChat },
        before: { sites: had, inChat: found.inChat },
        after: { sites: embedOrigins, inChat: found.inChat },
      });
    }
    return {
      formId: found.id,
      name: found.name,
      slug: found.slug,
      siteSlug: site.slug,
      embedOrigins,
      created: false,
    };
  }

  const starter = starterByKey(CONTACT_FORM_STARTER)!;
  const definition = starterForm(CONTACT_FORM_STARTER);
  const { issues } = await formIssues(ctx.tx, ws, definition);
  if (issues.length)
    throw HfosError.internal(
      'Your contact form couldn’t be made just now. Try again in a minute, or make one in Forms.',
    );
  const slug = await freeFormSlug(ctx.tx, ws, starter.name);
  const [row] = await ctx.tx
    .insert(forms)
    .values({
      workspaceId: ws,
      name: starter.name,
      mode: definition.mode,
      status: 'draft',
      slug,
      definition: asJson(definition),
      definitionVersion: definition.version,
      revision: 1,
      embedOrigins: sites,
      createdBy: by,
    })
    .returning({ id: forms.id });
  if (!row) throw HfosError.forbidden();
  await ctx.emit({
    type: 'form.created',
    entityType: 'form',
    entityId: row.id,
    payload: { name: starter.name, mode: definition.mode, slug, starter: starter.key },
    after: {
      name: starter.name,
      mode: definition.mode,
      status: 'draft',
      link: slug,
      from: starter.name,
      sites,
    },
  });

  const [version] = await ctx.tx
    .insert(formVersions)
    .values({
      workspaceId: ws,
      formId: row.id,
      version: 1,
      definition: asJson(definition),
      definitionVersion: definition.version,
      revision: 1,
      source: 'template',
      publishedBy: by,
    })
    .returning({ id: formVersions.id });
  if (!version) throw HfosError.forbidden();
  // Its link is built from the business's public name, which a business that never set up booking doesn't have yet.
  const site = await ensureBookingSite(ctx.tx, ws, by);
  await ctx.tx
    .update(forms)
    .set({ activeVersionId: version.id, status: 'live' })
    .where(eq(forms.id, row.id));
  const questionCount = allQuestions(definition).filter(asksSomething).length;
  await ctx.emit({
    type: 'form.published',
    entityType: 'form',
    entityId: row.id,
    payload: { versionId: version.id, version: 1, source: 'template', questionCount },
    before: { status: 'draft' },
    after: { status: 'live', version: 1, questions: questionCount },
  });

  return {
    formId: row.id,
    name: starter.name,
    slug,
    siteSlug: site.slug,
    embedOrigins: sites,
    created: true,
  };
}
