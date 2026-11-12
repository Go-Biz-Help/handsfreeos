/**
 * What "Email your web person" writes its files from (website-fixes.ts), read for one business: the registration as it
 * is now (its privacy policy and terms, how customers agree), the form to put on the site, and the website chat.
 * `registration.email_web_person` reads it to refuse what can't be written, and the worker reads it again to write the
 * files it sends, so they say what's true when they go. Server-only.
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { bookingSites, chatWidgets, forms, workspaces } from '@hfos/db/schema';
import { normalizeChatOrigins } from '../chat/origins';
import { chatSnippet, chatSnippetSrc } from '../chat/snippet';
import { HfosError } from '../errors';
import { formEmbedSnippet, publicFormPath } from '../forms/links';
import { consentPolicyPath, consentTermsPath } from './consent';
import { legalSourceOf, optInNowOf, type LegalSource, type OptInNow } from './legal-source';
import {
  fixUnavailable,
  WEBSITE_FIX_IDS,
  type WebsiteFixFacts,
  type WebsiteFixId,
} from './website-fixes';

/** Everything the files are written from, before the addresses they're on are known. */
export interface WebsiteFixSources {
  readonly business: string;
  readonly siteSlug: string | null;
  readonly legal: LegalSource;
  readonly optIn: OptInNow;
  readonly website: string | null;
  /** The form picked, or null for a form of the business's own. */
  readonly form: { readonly id: string; readonly name: string; readonly slug: string } | null;
  readonly chat: { readonly publicKey: string; readonly hidden: boolean } | null;
}

/** The form as it's picked: by id, or left out for the newest published one (or a form of their own when none is). */
async function pickForm(tx: Tx, workspaceId: string, formId: string | null | undefined) {
  if (formId === null) return null;
  const live = await tx
    .select({
      id: forms.id,
      name: forms.name,
      slug: forms.slug,
      status: forms.status,
      embedOrigins: forms.embedOrigins,
    })
    .from(forms)
    .where(
      and(
        eq(forms.workspaceId, workspaceId),
        isNull(forms.archivedAt),
        formId ? eq(forms.id, formId) : eq(forms.status, 'live'),
      ),
    )
    .orderBy(desc(forms.updatedAt))
    .limit(1);
  const [row] = live;
  if (!row) {
    if (formId)
      throw HfosError.notFound(
        'That form isn’t there anymore. It may have been deleted. Pick another one.',
      );
    return null;
  }
  return row;
}

/** The chat the files are about: one with the box to agree to texts first, a hidden one counting as on. */
async function pickChat(tx: Tx, workspaceId: string) {
  const all = await tx
    .select({
      publicKey: chatWidgets.publicKey,
      pausedAt: chatWidgets.pausedAt,
      hidden: chatWidgets.hiddenUntilTexting,
      smsConsent: chatWidgets.smsConsent,
      allowedOrigins: chatWidgets.allowedOrigins,
      name: chatWidgets.name,
    })
    .from(chatWidgets)
    .where(eq(chatWidgets.workspaceId, workspaceId))
    .orderBy(asc(chatWidgets.createdAt));
  const on = all.filter((w) => !w.pausedAt || w.hidden);
  return on.find((w) => w.smsConsent) ?? on[0] ?? null;
}

/** Whether every one of the website's addresses (with its www twin) is among these sites. */
function allows(sites: readonly string[], website: string | null): boolean {
  if (!website) return true;
  const { origins } = normalizeChatOrigins([website], { allowNone: true });
  return origins.length === 0 || origins.some((o) => sites.includes(o));
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Reads what the files need for these fixes, refusing what can't be written as it would go: the person sending it
 * reads the refusal, so each says what to do. A form must be published and allowed on the website, the chat too.
 */
export async function websiteFixSourcesOf(
  tx: Tx,
  workspaceId: string,
  fixes: readonly WebsiteFixId[],
  formId: string | null | undefined,
): Promise<WebsiteFixSources> {
  const [ws] = await tx
    .select({ name: workspaces.name, settings: workspaces.settings, site: bookingSites.slug })
    .from(workspaces)
    .leftJoin(bookingSites, eq(bookingSites.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId));
  if (!ws) throw HfosError.notFound('That business isn’t there anymore.');
  const [legal, optIn] = await Promise.all([
    legalSourceOf(tx, workspaceId),
    optInNowOf(tx, workspaceId),
  ]);
  const settings = (ws.settings ?? {}) as Record<string, unknown>;
  const typed = typeof settings['website'] === 'string' ? settings['website'].trim() : '';
  const website =
    legal.business.website ??
    (typed ? (/^https?:\/\//i.test(typed) ? typed : `https://${typed}`) : null);
  const business = optIn.displayName ?? ws.name;
  const siteSlug = ws.site ? String(ws.site) : null;

  let form: WebsiteFixSources['form'] = null;
  if (fixes.includes('form')) {
    const row = await pickForm(tx, workspaceId, formId);
    if (row) {
      if (row.status !== 'live')
        throw HfosError.rule(
          'web_person_form_not_live',
          409,
          `“${row.name}” isn’t published, so it has no link to put on a website. Publish it in Forms, or pick another form, then send this again.`,
        );
      if (!siteSlug)
        throw HfosError.rule(
          'web_person_form_no_link',
          409,
          `“${row.name}” has no public link yet. Open it in Forms and press Share to get one, then send this again.`,
        );
      if (!allows(row.embedOrigins ?? [], website))
        throw HfosError.rule(
          'web_person_form_site',
          409,
          `“${row.name}” isn’t allowed on ${hostOf(website!)} yet, so it would show up blank there. Add ${hostOf(website!)} under Sites allowed on the form’s Share tab, then send this again.`,
        );
      form = { id: row.id, name: row.name, slug: row.slug };
    }
  }

  let chat: WebsiteFixSources['chat'] = null;
  const widget = fixes.includes('chat') ? await pickChat(tx, workspaceId) : null;
  if (widget) {
    if (!allows(widget.allowedOrigins, website))
      throw HfosError.rule(
        'web_person_chat_site',
        409,
        `Your website chat isn’t allowed on ${hostOf(website!)} yet, so it wouldn’t show there. Add ${hostOf(website!)} to its sites in Settings → Website chat, then send this again.`,
      );
    chat = { publicKey: widget.publicKey, hidden: !!widget.pausedAt && widget.hidden };
  }

  return { business, siteSlug, legal, optIn, website, form, chat };
}

/** An address without the slashes at its end (a loop, not a regex, which slows down on many slashes). */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/** The files' facts, once the addresses are known: ours (`app`) and the one the business's pages are on (`pages`). */
export function websiteFixFactsFrom(
  s: WebsiteFixSources,
  origins: { readonly app: string; readonly pages: string },
): WebsiteFixFacts {
  const pages = withoutTrailingSlashes(origins.pages);
  const app = withoutTrailingSlashes(origins.app);
  const publicUrl =
    s.form && s.siteSlug ? `${pages}${publicFormPath(s.siteSlug, s.form.slug)}` : null;
  return {
    business: s.business,
    website: s.website,
    offers: !!s.legal.business.offers,
    form:
      s.form && publicUrl
        ? {
            kind: 'ours',
            name: s.form.name,
            publicUrl,
            embed: formEmbedSnippet({ publicUrl, appOrigin: app, name: s.form.name }),
          }
        : { kind: 'own' },
    formPage: s.optIn.pageUrl,
    ownPrivacyUrl: s.legal.policyUrl,
    ownTermsUrl: s.legal.termsUrl,
    // On our address, as the registration gives them to the carriers.
    hostedPrivacyUrl: s.siteSlug ? `${app}${consentPolicyPath(s.siteSlug)}` : null,
    hostedTermsUrl: s.siteSlug ? `${app}${consentTermsPath(s.siteSlug)}` : null,
    policyBusiness: { name: s.business, ...s.legal.business },
    chat: s.chat
      ? { snippet: chatSnippet(chatSnippetSrc(pages, s.chat.publicKey)), hidden: s.chat.hidden }
      : null,
  };
}

/** Refuses the fixes that can't be written for this business yet, the first one's words first. */
export function refuseUnwritable(facts: WebsiteFixFacts, fixes: readonly WebsiteFixId[]): void {
  for (const id of WEBSITE_FIX_IDS) {
    if (!fixes.includes(id)) continue;
    const why = fixUnavailable(id, facts);
    if (why) throw HfosError.rule(`web_person_no_${id}`, 409, why);
  }
}
