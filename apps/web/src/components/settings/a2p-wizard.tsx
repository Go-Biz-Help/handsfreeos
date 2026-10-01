'use client';
/**
 * The carrier registration, asked one question at a time (M17).
 *
 * **The old screen was a form; this is an interview.** Everything the carriers want used to sit on one
 * page — EIN, use case, two example texts and a thousand-character box headed "explain how customers agree
 * to get texts" — and a business owner who has never heard of A2P 10DLC filled it in the way anyone fills
 * in a form they do not understand: quickly, and wrong. Then the registration came back turned down three
 * to seven business days later and they did it again.
 *
 * So the questions are split up, written in the words a business would use, and each one says **why the
 * carrier asks**. `@hfos/core`'s `checkDraft` runs as they type, and a step with a blocker on it will not
 * advance — a minute spent here against a fortnight spent waiting.
 *
 * **The step that matters most is "How do customers agree?"** A reviewer does not approve a campaign on
 * the strength of the sentence we send: they open the business's website and look for the box the sentence
 * describes. So the wizard does not ask the business to describe its consent — it asks which way it wants
 * to collect it, turns that way on, and writes the sentence from what is now actually there. The hosted
 * option is recommended and first because it is the one we can make true in a single click.
 */
import {
  checkDraft,
  hasBlockers,
  issuesFor,
  optInDescriptionFor,
  ownSiteBoxText,
  privacyPolicy,
  preflightBlocked,
  sampleSuggestions,
  SENSITIVE_TOPICS,
  sendsOffers,
  TERMS_TEXTING_ITEMS,
  termsOfService,
  type A2pDraft,
  type A2pField,
  type A2pIssue,
  type OptInPath,
  type PreflightCheck,
  type SensitiveTopicId,
} from '@hfos/core';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Copy,
  Globe,
  HelpCircle,
  Loader2,
  MessageCircle,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { PhoneNumberInfo } from '@/lib/api/types';
import { registrationPreflight } from '@/lib/api/worker';
import { cn } from '@/lib/utils';

// ---------- the answers ----------

/** Everything the wizard collects. Flat, because every field is one question on one step. */
export interface WizardForm {
  legalName: string;
  businessType: string;
  ein: string;
  website: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  contactFirst: string;
  contactLast: string;
  contactEmail: string;
  contactPhone: string;
  useCase: string;
  volume: string;
  samples: string[];
  optInPath: OptInPath | '';
  /** Filled in from the path once the surfaces are live; the business may still edit it. */
  optIn: string;
  /** `own_site`: the page on the business's own website that carries the box. */
  optInUrl: string;
  /** `in_person`: a link anyone can open to a photo of the sign-up sheet or the words said on the phone. */
  optInProofUrl: string;
  /** '' means "use the one we host for you". */
  ownPolicyUrl: string;
  /** The same for the terms. */
  ownTermsUrl: string;
  /** Topics the carriers treat differently: the ids picked, [] for "None of these", null before answering. */
  sensitive: string[] | null;
}

const BUSINESS_TYPES = [
  ['llc', 'Limited liability company (LLC)'],
  ['corporation', 'Corporation'],
  ['sole_proprietor', 'Sole proprietor'],
  ['partnership', 'Partnership'],
  ['non_profit', 'Nonprofit'],
] as const;

const VOLUMES = [
  ['under_1000', 'Under 1,000 a month'],
  ['1000_10000', '1,000 to 10,000 a month'],
  ['10000_100000', '10,000 to 100,000 a month'],
  ['over_100000', 'Over 100,000 a month'],
] as const;

/** The use cases, said the way a business would describe its own week. */
const USE_CASES = [
  {
    value: 'customer_care',
    title: 'Appointments and customer care',
    description:
      'Confirming appointments, sending estimates, answering questions, telling someone the van is on its way.',
  },
  {
    value: 'mixed',
    title: 'Customer care, and the odd promotion',
    description:
      'Mostly the above, but sometimes you tell customers about a free slot this week or a service that is due.',
  },
  {
    value: 'marketing',
    title: 'Mostly promotions',
    description:
      'Offers, campaigns and reminders sent to a list. Approval is slower and the carriers look harder.',
  },
] as const;

/** Reads the last submission back into the form, so a turned-down registration is corrected, not retyped. */
export function wizardFormFrom(
  initial: Record<string, unknown> | null,
  businessName: string,
  me: { fullName: string; email: string },
): WizardForm {
  const b = (initial ?? {}) as {
    legalName?: string;
    businessType?: string;
    ein?: string | null;
    website?: string;
    address?: { line1?: string; city?: string; state?: string; postalCode?: string };
    contact?: { firstName?: string; lastName?: string; email?: string; phone?: string };
    optInDescription?: string;
    optInPath?: OptInPath;
    optInUrl?: string | null;
    optInProofUrl?: string | null;
    policyUrl?: string | null;
    termsUrl?: string | null;
    sensitiveTopics?: string[];
    messageSamples?: string[];
    useCase?: string;
    monthlyVolume?: string;
  };
  const [meFirst = '', ...meRest] = me.fullName.trim().split(/\s+/);
  return {
    legalName: b.legalName ?? businessName,
    businessType: b.businessType ?? 'llc',
    ein: b.ein ?? '',
    website: b.website ?? '',
    line1: b.address?.line1 ?? '',
    city: b.address?.city ?? '',
    state: b.address?.state ?? '',
    postalCode: b.address?.postalCode ?? '',
    contactFirst: b.contact?.firstName ?? meFirst,
    contactLast: b.contact?.lastName ?? meRest.join(' '),
    contactEmail: b.contact?.email ?? me.email,
    contactPhone: b.contact?.phone ?? '',
    useCase: b.useCase ?? 'customer_care',
    volume: b.monthlyVolume ?? 'under_1000',
    samples: [b.messageSamples?.[0] ?? '', b.messageSamples?.[1] ?? ''],
    optInPath: b.optInPath ?? '',
    optIn: b.optInDescription ?? '',
    // Our own form's address is worked out again from what is live; only the business's own page is kept.
    optInUrl: b.optInPath === 'own_site' ? (b.optInUrl ?? '') : '',
    optInProofUrl: b.optInProofUrl ?? '',
    ownPolicyUrl: b.policyUrl ?? '',
    ownTermsUrl: b.termsUrl ?? '',
    sensitive: Array.isArray(b.sensitiveTopics) ? b.sensitiveTopics : null,
  };
}

/**
 * The form as it was left, over what it would otherwise start from: each saved answer that still has the
 * right shape. A draft saved by an older wizard, or edited by hand, can only fill in what it has.
 */
export function withDraft(base: WizardForm, draft: Record<string, unknown> | null): WizardForm {
  if (!draft) return base;
  const saved = (draft['form'] ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as (keyof WizardForm)[]) {
    const value = saved[key];
    const was = base[key];
    if (key === 'sensitive') {
      if (value === null || (Array.isArray(value) && value.every((v) => typeof v === 'string')))
        next[key] = value;
    } else if (key === 'samples') {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
        next[key] = [value[0] ?? '', value[1] ?? ''];
    } else if (typeof value === typeof was) next[key] = value;
  }
  return next as unknown as WizardForm;
}

/** The form as the checks read it. */
const draftOf = (f: WizardForm): A2pDraft => ({
  legalName: f.legalName,
  businessType: f.businessType,
  ein: f.ein,
  website: f.website,
  useCase: f.useCase,
  messageSamples: f.samples,
  optInDescription: f.optIn,
  optInPath: f.optInPath || undefined,
  optInUrl: f.optInUrl,
  optInProofUrl: f.optInProofUrl,
  sensitiveTopics: f.sensitive,
  monthlyVolume: f.volume,
});

const withScheme = (raw: string) => {
  const url = raw.trim();
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
};

// ---------- the steps ----------

interface Step {
  readonly key: string;
  readonly title: string;
  /** One line under the title: what this step is for, never what it contains. */
  readonly blurb: string;
  /** The fields this step owns. A blocker on one of these stops the step advancing. */
  readonly fields: readonly A2pField[];
}

const STEPS: readonly Step[] = [
  {
    key: 'business',
    title: 'Who the carriers will look up',
    blurb: 'They check this against IRS records before they let you text anyone.',
    fields: ['legalName', 'businessType', 'ein'],
  },
  {
    key: 'where',
    title: 'Where to find you',
    blurb: 'Someone reviewing this will open your website and read it.',
    fields: ['website'],
  },
  {
    key: 'contact',
    title: 'Who to write to',
    blurb: 'The carriers write here if they need something. Nobody else sees it.',
    fields: ['contact'],
  },
  {
    key: 'about',
    title: 'What you will text about',
    blurb: 'Pick the one that matches your week, not the one that sounds best.',
    fields: ['useCase', 'monthlyVolume', 'sensitiveTopics'],
  },
  {
    key: 'samples',
    title: 'Two texts you would really send',
    blurb: 'These are read as the actual messages you plan to send.',
    fields: ['messageSamples'],
  },
  {
    key: 'optin',
    title: 'How customers agree to get texts',
    blurb: 'The part that is checked hardest — and the part we can do for you.',
    fields: ['optInPath', 'optInUrl', 'optInProofUrl', 'optInDescription'],
  },
  {
    key: 'policy',
    title: 'Your privacy policy and terms',
    blurb: 'The reviewer opens both, and reads the policy for one particular sentence.',
    fields: [],
  },
  {
    key: 'review',
    title: 'Before it goes',
    blurb: 'Everything the carriers will see.',
    fields: [],
  },
];

// ---------- small pieces ----------

/** "Why do they ask this?", folded away until somebody wants it. */
function Why({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-[13px] text-text-2 hover:text-text"
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
        Why do they ask this?
      </button>
      {open ? <p className="mt-1.5 text-[13px] leading-relaxed text-text-2">{children}</p> : null}
    </div>
  );
}

/** The issues on one field, blockers first, each with the reason under it. */
function Issues({ issues }: { issues: readonly A2pIssue[] }) {
  if (!issues.length) return null;
  const ordered = [...issues].sort(
    (a, b) => Number(b.severity === 'blocker') - Number(a.severity === 'blocker'),
  );
  return (
    <ul className="mt-2 space-y-1.5">
      {ordered.map((issue, i) => (
        <li
          key={`${issue.field}-${i}`}
          className={cn(
            'text-[13px] leading-relaxed',
            issue.severity === 'blocker' ? 'text-danger-text' : 'text-warning-text',
          )}
        >
          <span className="font-medium">{issue.message}</span>
          <span className="block text-text-2">{issue.why}</span>
        </li>
      ))}
    </ul>
  );
}

function Progress({ current, total }: { current: number; total: number }) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between text-[13px] text-text-2">
        <span>
          Step {current + 1} of {total}
        </span>
        <span>{Math.round(((current + 1) / total) * 100)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-card-2">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${((current + 1) / total) * 100}%` }}
        />
      </div>
    </div>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          toast.error('Could not copy. Select the text and copy it yourself.');
        }
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? 'Copied' : label}
    </Button>
  );
}

// ---------- what is already public, and what turning the hosted option on would add ----------

/**
 * The public surfaces this business already has. The wizard needs them for two different reasons: to know
 * what the hosted option still has to create, and to write URLs into the sentence the carrier reads.
 */
export interface HostedSurfaces {
  /** The booking site's slug — the `<site>` in `/f/<site>/<form>`. Null before the business has one. */
  readonly siteSlug: string | null;
  /** An existing website chat widget's public key, if one is live. */
  readonly chatPublicKey: string | null;
  /** The slug of a live public form carrying the consent box, if one exists. */
  readonly contactFormSlug: string | null;
  readonly bookingEnabled: boolean;
}

const EMPTY_SURFACES: HostedSurfaces = {
  siteSlug: null,
  chatPublicKey: null,
  contactFormSlug: null,
  bookingEnabled: false,
};

/** The public addresses of whatever is live, built from the surfaces and this deployment's origin. */
function urlsOf(s: HostedSurfaces, origin: string) {
  return {
    formUrl:
      s.siteSlug && s.contactFormSlug ? `${origin}/f/${s.siteSlug}/${s.contactFormSlug}` : null,
    chatUrl: s.chatPublicKey ? `${origin}/chat/${s.chatPublicKey}` : null,
    bookingUrl: s.bookingEnabled && s.siteSlug ? `${origin}/book/${s.siteSlug}` : null,
  };
}

/**
 * The sentence for the carrier, from everything the form says about consent: the path, what is live, the
 * business's own page or its proof, and whether it sends offers too.
 */
function describeFor(
  businessName: string,
  f: WizardForm,
  s: HostedSurfaces,
  origin: string,
): string {
  if (!f.optInPath) return f.optIn;
  return optInDescriptionFor(businessName, f.optInPath, urlsOf(s, origin), {
    pageUrl: f.optInPath === 'own_site' ? withScheme(f.optInUrl) || null : null,
    proofUrl: withScheme(f.optInProofUrl) || null,
    offers: sendsOffers(f.useCase),
  });
}

const OPT_IN_PATHS: readonly {
  value: OptInPath;
  title: string;
  description: string;
  recommended?: boolean;
}[] = [
  {
    value: 'hosted',
    title: 'Let us collect it for you',
    description:
      'We put a contact form and a chat bubble on a page of your own, both with the agreement box already worded the way the carriers want. One click, nothing to install, and you get a web address the reviewer can open.',
    recommended: true,
  },
  {
    value: 'own_site',
    title: 'I will add it to my own website',
    description:
      'We give you the exact wording and the privacy policy paragraph. You, or whoever looks after your site, put them on your contact form before we send this off.',
  },
  {
    value: 'in_person',
    title: 'We ask people in person or on the phone',
    description:
      'No box to tick anywhere. This is allowed, but reviewers ask more questions about it and approval takes longer.',
  },
];

/**
 * Turns the hosted opt-in on: a public contact form carrying the consent box, and the website chat.
 *
 * **Two commands rather than one, and deliberately not a transaction.** Each artefact is useful on its own
 * — a business with a contact form and no chat widget is a business with a contact form — so a half-done
 * run leaves nothing broken and the button can simply be pressed again. What it must not do is claim a
 * surface is live when its command failed, because that claim goes to a carrier; so anything that throws
 * is reported and left out of the returned surfaces.
 */
async function enableHostedOptIn(
  workspaceId: string,
  website: string,
  have: HostedSurfaces,
): Promise<{ surfaces: HostedSurfaces; failed: string[] }> {
  const failed: string[] = [];
  let { chatPublicKey, contactFormSlug } = have;

  if (!contactFormSlug) {
    try {
      const created = unwrap(
        await apiBrowser().POST('/v1/commands/form.create', {
          body: {
            workspaceId,
            name: 'Contact us',
            mode: 'form',
            title: 'Get in touch',
            starter: 'enquiry',
          },
        }),
      ) as { formId: string; revision: number; slug: string };
      unwrap(
        await apiBrowser().POST('/v1/commands/form.publish', {
          body: {
            workspaceId,
            formId: created.formId,
            baseRevision: created.revision,
            source: 'editor',
          },
        }),
      );
      contactFormSlug = created.slug;
    } catch (err) {
      failed.push(`the contact form (${errorMessage(err)})`);
    }
  }

  if (!chatPublicKey) {
    try {
      const created = unwrap(
        await apiBrowser().POST('/v1/commands/chat_widget.create', {
          body: {
            workspaceId,
            // The widget has to name the site it may show on; the business gave us that two steps ago.
            allowedOrigins: [website],
            smsConsent: true,
            askFor: { name: 'when_needed', phone: 'when_needed', email: 'when_needed' },
          },
        }),
      ) as { publicKey: string };
      chatPublicKey = created.publicKey;
    } catch (err) {
      failed.push(`the website chat (${errorMessage(err)})`);
    }
  }

  return { surfaces: { ...have, chatPublicKey, contactFormSlug }, failed };
}

// ---------- the opt-in step, which is the reason the wizard exists ----------

function OptInStep({
  workspaceId,
  businessName,
  form,
  set,
  surfaces,
  onSurfaces,
  origin,
  issues,
}: {
  workspaceId: string;
  businessName: string;
  form: WizardForm;
  set: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
  surfaces: HostedSurfaces;
  onSurfaces: (next: HostedSurfaces) => void;
  origin: string;
  issues: readonly A2pIssue[];
}) {
  const [busy, setBusy] = useState(false);
  const urls = urlsOf(surfaces, origin);
  const hostedLive = Boolean(urls.formUrl || urls.chatUrl);

  /** Rewrites the sentence from the path and whatever is live. */
  const describe = (path: OptInPath, s: HostedSurfaces) =>
    set('optIn', describeFor(businessName, { ...form, optInPath: path }, s, origin));
  const offers = sendsOffers(form.useCase);

  async function turnOn() {
    setBusy(true);
    try {
      const { surfaces: next, failed } = await enableHostedOptIn(
        workspaceId,
        withScheme(form.website),
        surfaces,
      );
      onSurfaces(next);
      describe('hosted', next);
      if (failed.length)
        toast.error(`Could not set up ${failed.join(' or ')}. Try again in a moment.`);
      else toast.success('Your agreement box is live');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const policy = privacyPolicy({
    name: businessName,
    legalName: form.legalName,
    website: withScheme(form.website),
    email: form.contactEmail,
    offers,
    address: {
      line1: form.line1,
      city: form.city,
      state: form.state,
      postalCode: form.postalCode,
    },
  });
  const smsSection = policy.sections.find((s) => /text messages/i.test(s.heading));

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="How customers agree to get texts" className="space-y-2.5">
        {OPT_IN_PATHS.map((option) => (
          <RadioCard
            key={option.value}
            selected={form.optInPath === option.value}
            onSelect={() => {
              set('optInPath', option.value);
              describe(option.value, surfaces);
            }}
            testId={`optin-${option.value}`}
            title={
              <span className="flex items-center gap-2">
                {option.title}
                {option.recommended ? (
                  <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-on-accent">
                    Recommended
                  </span>
                ) : null}
              </span>
            }
            description={option.description}
          />
        ))}
      </div>

      <Issues issues={issuesFor(issues, 'optInPath')} />

      {form.optInPath === 'hosted' ? (
        <div className="rounded-menu border border-border bg-card-2 p-4">
          <p className="text-[13.5px] font-semibold">What this turns on</p>
          <ul className="mt-2 space-y-2 text-[13px] text-text-2">
            <li className="flex items-start gap-2">
              <Globe className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
              <span>
                A <strong>contact form</strong> on a page of your own, with the agreement box under
                it.
                {urls.formUrl ? (
                  <a
                    className="ml-1 underline"
                    href={urls.formUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {urls.formUrl}
                  </a>
                ) : null}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <MessageCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
              <span>
                A <strong>chat bubble</strong> that asks the same thing before it takes a phone
                number.
                {urls.chatUrl ? (
                  <a
                    className="ml-1 underline"
                    href={urls.chatUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {urls.chatUrl}
                  </a>
                ) : null}
              </span>
            </li>
          </ul>
          {offers ? (
            <p className="mt-2 text-[13px] text-text-2">
              You send offers too, so each of these shows a second, separate box for them. Customers
              can agree to texts about their own work without agreeing to offers.
            </p>
          ) : null}
          {hostedLive ? (
            <Callout tone="info" icon={Check} className="mt-3">
              This is live. The reviewer can open it, which is the whole point — a chat bubble on
              its own is often turned down because the wording is not visible until somebody clicks.
            </Callout>
          ) : (
            <Button
              type="button"
              className="mt-3"
              onClick={turnOn}
              disabled={busy || !form.website}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {busy ? 'Setting it up…' : 'Set this up for me'}
            </Button>
          )}
          {!form.website ? (
            <p className="mt-2 text-[13px] text-text-2">
              Go back a step and add your website first — the chat needs to know which site it may
              appear on.
            </p>
          ) : null}
        </div>
      ) : null}

      {form.optInPath === 'own_site' ? (
        <div className="space-y-3 rounded-menu border border-border bg-card-2 p-4">
          <Callout tone="warning" icon={CircleAlert}>
            Do this before you send the registration. A reviewer who opens your site and finds no
            agreement box turns the whole thing down, and you wait out the week again.
          </Callout>
          <Field label="The page with your tick box" htmlFor="a2p-optInUrl">
            <Input
              id="a2p-optInUrl"
              value={form.optInUrl}
              onChange={(e) => set('optInUrl', e.target.value)}
              placeholder="yoursite.com/contact"
              data-testid="a2p-optin-url"
            />
          </Field>
          <Why>
            The reviewer opens this exact page looking for the box, so give the page the form is on
            — your contact page, say — rather than your home page, unless the box is on the home
            page.
          </Why>
          <Issues issues={issuesFor(issues, 'optInUrl')} />
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[13.5px] font-semibold">Put this beside the tick box</p>
              <CopyButton text={ownSiteBoxText(businessName, offers)} />
            </div>
            <p className="whitespace-pre-line rounded-menu bg-card p-3 text-[13px] leading-relaxed text-text-2">
              {ownSiteBoxText(businessName, offers)}
            </p>
            <p className="mt-1.5 text-[13px] text-text-3">
              The box has to start empty and must not be required to send the form. Link
              &ldquo;Privacy policy&rdquo; and &ldquo;Terms&rdquo; to your own pages.
              {offers ? ' Offers get their own box, under the first.' : ''}
            </p>
          </div>
          {smsSection ? (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-[13.5px] font-semibold">
                  Add this to your privacy policy, word for word
                </p>
                <CopyButton text={smsSection.paragraphs.join('\n\n')} />
              </div>
              <p className="rounded-menu bg-card p-3 text-[13px] leading-relaxed text-text-2">
                {smsSection.paragraphs[smsSection.paragraphs.length - 1]}
              </p>
              <p className="mt-1.5 text-[13px] text-text-3">
                That last sentence is the one reviewers look for. Changing its wording is how
                policies get missed.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {form.optInPath === 'in_person' ? (
        <div className="space-y-3 rounded-menu border border-border bg-card-2 p-4">
          <Callout tone="warning" icon={CircleAlert}>
            This can be approved, but there is no web page for the reviewer to check, so expect
            questions and a longer wait. If you have a website at all, the first option is much
            faster.
          </Callout>
          <Field label="A link to what customers see or hear" htmlFor="a2p-optInProofUrl">
            <Input
              id="a2p-optInProofUrl"
              value={form.optInProofUrl}
              onChange={(e) => set('optInProofUrl', e.target.value)}
              placeholder="https://drive.google.com/…"
              data-testid="a2p-optin-proof"
            />
          </Field>
          <Why>
            The reviewer can&rsquo;t watch you ask, so they ask to see it: a photo of your sign-up
            sheet, or a page with the words you say on the phone. Put it in Google Drive or Dropbox
            and share it so anyone with the link can open it. The reviewer never signs in.
          </Why>
          <Issues issues={issuesFor(issues, 'optInProofUrl')} />
        </div>
      ) : null}

      {form.optInPath ? (
        <Field label="What we will tell the carriers" htmlFor="optin-description">
          <Textarea
            id="optin-description"
            value={form.optIn}
            onChange={(e) => set('optIn', e.target.value)}
            rows={6}
          />
          <p className="mt-1.5 text-[13px] text-text-3">
            Written from your answer above. Edit it if it does not describe how you really do it —
            but everything it claims has to be true, because it is checked.
          </p>
          <Issues issues={issuesFor(issues, 'optInDescription')} />
        </Field>
      ) : null}
    </div>
  );
}

// ---------- the wizard ----------

export function A2pWizard({
  workspaceId,
  businessName,
  number,
  me,
  initial,
  draft = null,
  surfaces: initialSurfaces = EMPTY_SURFACES,
  onBack,
  onSubmitted,
}: {
  workspaceId: string;
  businessName: string;
  /**
   * The number this registration is for. Null when it goes ahead of the number (a local registration sent
   * while the business's own number is being moved here, or before it has one): that is always 10DLC, and
   * the number is filled in when we know it.
   */
  number: Pick<PhoneNumberInfo, 'numberType' | 'display'> | null;
  me: { fullName: string; email: string };
  initial: Record<string, unknown> | null;
  /** The answers as they were left last time (`registration.get_draft`), which win over `initial`. */
  draft?: Record<string, unknown> | null;
  surfaces?: HostedSurfaces;
  onBack?: () => void;
  onSubmitted: () => void;
}) {
  const [form, setForm] = useState<WizardForm>(() =>
    withDraft(wizardFormFrom(initial, businessName, me), draft),
  );
  const [surfaces, setSurfaces] = useState<HostedSurfaces>(initialSurfaces);
  const [at, setAt] = useState(() => {
    const step = typeof draft?.['at'] === 'number' ? Math.floor(draft['at']) : 0;
    return Math.min(Math.max(step, 0), STEPS.length - 1);
  });
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  // The business says these details are true before they go to a carrier. Kept from the old form: it is
  // the record that somebody asserted it, which is what a carrier audit asks for.
  const [agreed, setAgreed] = useState(false);
  // What a reviewer would find. Run when the review step opens rather than on every keystroke: each one is
  // four requests to somebody else's website, and the answers only change when an answer above them does.
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
  const [checking, setChecking] = useState(false);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  /**
   * Changes one answer. The sentence for the carrier is written from the answers, so it follows them —
   * the page, the proof, offers or not — until the business edits the sentence itself.
   */
  const set = <K extends keyof WizardForm>(key: K, value: WizardForm[K]) =>
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (
        key !== 'optIn' &&
        f.optInPath &&
        f.optIn === describeFor(businessName, f, surfaces, origin)
      )
        next.optIn = describeFor(businessName, next, surfaces, origin);
      return next;
    });

  // ---- saved as it goes ----
  // Every change is kept a moment after it is made, so a refresh or coming back tomorrow picks up here. The
  // last thing saved is remembered so opening the wizard saves nothing, and a save still on its way is
  // waited for before sending, so it can't bring back a draft the send has just cleared.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>(
    draft ? 'saved' : 'idle',
  );
  const lastSaved = useRef(JSON.stringify({ form, at }));
  const saving = useRef<Promise<unknown> | null>(null);
  const sent = useRef(false);
  useEffect(() => {
    const json = JSON.stringify({ form, at });
    if (json === lastSaved.current || sent.current) return;
    setSaveState('saving');
    const timer = setTimeout(() => {
      const run = (async () => {
        try {
          unwrap(
            await apiBrowser().POST('/v1/commands/registration.save_draft', {
              body: { workspaceId, answers: { form, at } },
            }),
          );
          lastSaved.current = json;
          setSaveState('saved');
        } catch {
          setSaveState('failed');
        }
      })();
      saving.current = run;
    }, 800);
    return () => clearTimeout(timer);
  }, [form, at, workspaceId]);

  const local = !number || number.numberType === 'local';
  const issues = useMemo(() => checkDraft(draftOf(form), businessName), [form, businessName]);
  const step = STEPS[at]!;

  /** Blockers on the fields this step owns — what stops it advancing. */
  const stepBlockers = step.fields.flatMap((field) =>
    issuesFor(issues, field).filter((i) => i.severity === 'blocker'),
  );

  const surfaceUrls = urlsOf(surfaces, origin);
  /** The page we are about to tell the carrier the agreement box is on. */
  const optInUrl =
    form.optInPath === 'hosted'
      ? (surfaceUrls.formUrl ?? surfaceUrls.chatUrl)
      : form.optInPath === 'own_site'
        ? withScheme(form.optInUrl) || null
        : null;
  const proofUrl = withScheme(form.optInProofUrl) || null;
  /** Theirs when they gave us one, ours when we are hosting it, and nothing before a site exists. */
  const policyUrl = form.ownPolicyUrl.trim()
    ? withScheme(form.ownPolicyUrl)
    : surfaces.siteSlug
      ? `${origin}/legal/${surfaces.siteSlug}/privacy`
      : null;
  const termsUrl = form.ownTermsUrl.trim()
    ? withScheme(form.ownTermsUrl)
    : surfaces.siteSlug
      ? `${origin}/legal/${surfaces.siteSlug}/terms`
      : null;

  const runPreflight = useCallback(async () => {
    if (!form.optInPath) return;
    setChecking(true);
    try {
      const { checks: got } = await registrationPreflight({
        workspaceId,
        website: withScheme(form.website),
        policyUrl,
        termsUrl,
        optInPath: form.optInPath,
        optInUrl,
        optInProofUrl: proofUrl,
        names: [businessName, form.legalName].filter((n) => n.trim()),
      });
      setChecks(got);
    } catch (err) {
      toast.error(errorMessage(err));
      setChecks(null);
    } finally {
      setChecking(false);
    }
  }, [
    workspaceId,
    businessName,
    form.website,
    form.legalName,
    form.optInPath,
    policyUrl,
    termsUrl,
    optInUrl,
    proofUrl,
  ]);

  // Opening the review runs them; going back and changing something throws the old answers away, so a
  // business never submits on the strength of a check of a website it has since corrected.
  useEffect(() => {
    if (step.key === 'review') void runPreflight();
    else setChecks(null);
  }, [step.key, runPreflight]);

  async function submit() {
    setBusy(true);
    setServerErrors([]);
    try {
      // A save still on its way lands first, so the send's clearing of the draft is the last word.
      await saving.current;
      unwrap(
        await apiBrowser().POST('/v1/commands/registration.submit', {
          body: {
            workspaceId,
            kind: local ? 'a2p_10dlc' : 'toll_free_verification',
            business: {
              legalName: form.legalName,
              businessType: form.businessType as 'llc',
              ein: form.businessType === 'sole_proprietor' ? null : form.ein || null,
              website: withScheme(form.website),
              address: {
                line1: form.line1,
                city: form.city,
                state: form.state,
                postalCode: form.postalCode,
                country: 'US',
              },
              contact: {
                firstName: form.contactFirst,
                lastName: form.contactLast,
                email: form.contactEmail,
                phone: form.contactPhone,
              },
              useCase: form.useCase as 'customer_care',
              messageSamples: form.samples.map((s) => s.trim()).filter(Boolean),
              optInDescription: form.optIn,
              optInPath: form.optInPath || undefined,
              optInUrl,
              optInProofUrl: proofUrl,
              policyUrl: form.ownPolicyUrl.trim() ? withScheme(form.ownPolicyUrl) : null,
              termsUrl: form.ownTermsUrl.trim() ? withScheme(form.ownTermsUrl) : null,
              privacyPageUrl: policyUrl,
              termsPageUrl: termsUrl,
              displayName: businessName,
              sensitiveTopics: (form.sensitive ?? []) as SensitiveTopicId[],
              monthlyVolume: form.volume as 'under_1000',
            },
          },
        }),
      );
      sent.current = true;
      toast.success('Sent to the carriers');
      onSubmitted();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation' && Array.isArray(err.details)) {
        const details = err.details as { path?: string; message?: string }[];
        setServerErrors(details.map((d) => d.message ?? 'Check this.'));
        toast.error('A few details need a look.');
      } else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (
    key: keyof WizardForm,
    label: string,
    props: Partial<Parameters<typeof Input>[0]> = {},
  ) => (
    <Field label={label} htmlFor={`a2p-${key}`}>
      <Input
        id={`a2p-${key}`}
        value={form[key] as string}
        onChange={(e) => set(key, e.target.value as WizardForm[typeof key])}
        {...props}
      />
    </Field>
  );

  return (
    <div className="mx-auto max-w-[620px]" data-testid="business-step">
      <Progress current={at} total={STEPS.length} />
      <p className="-mt-3 mb-4 text-right text-[12px] text-text-3" aria-live="polite">
        {saveState === 'saving'
          ? 'Saving…'
          : saveState === 'saved'
            ? 'Saved. You can come back to this later.'
            : saveState === 'failed'
              ? 'Couldn’t save just now. We’ll try again when you change something.'
              : null}
      </p>
      <h2 className="text-[19px] font-semibold">{step.title}</h2>
      <p className="mb-5 mt-1 text-[13.5px] text-text-2">{step.blurb}</p>

      {step.key === 'business' ? (
        <div className="space-y-3.5">
          {field('legalName', 'The name on your IRS letter', {
            placeholder: 'Lone Star HVAC LLC',
          })}
          <Why>
            The carriers look your business up by this name and your EIN, and compare both against
            IRS records. &ldquo;Lone Star Heating&rdquo; fails where &ldquo;Lone Star Heating
            LLC&rdquo; passes, so copy it exactly, including LLC or Inc.
          </Why>
          <Issues issues={issuesFor(issues, 'legalName')} />
          <Field label="What kind of business it is" htmlFor="a2p-businessType">
            <Select
              id="a2p-businessType"
              value={form.businessType}
              onChange={(e) => set('businessType', e.target.value)}
            >
              {BUSINESS_TYPES.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>
          {form.businessType === 'sole_proprietor' ? (
            <Callout tone="info">
              Sole proprietors do not need an EIN, but the carriers allow them far less texting. If
              you have an EIN, pick the kind of company it belongs to instead.
            </Callout>
          ) : (
            <>
              {field('ein', 'Your EIN', { placeholder: '12-3456789', inputMode: 'numeric' })}
              <Why>
                This is the nine-digit number on the letter the IRS sent when your business was set
                up (form CP 575 or 147C). It is how the carrier proves you are a real business.
              </Why>
              <Issues issues={issuesFor(issues, 'ein')} />
            </>
          )}
        </div>
      ) : null}

      {step.key === 'where' ? (
        <div className="space-y-3.5">
          {field('website', 'Your website', { placeholder: 'lonestarhvac.com' })}
          <Why>
            Somebody at the carrier opens this page. They are checking that your business is real,
            that it does what you say it does, and — later on — that customers can agree to be
            texted somewhere on it. A registration with no website is turned down.
          </Why>
          <Issues issues={issuesFor(issues, 'website')} />
          <div className="grid gap-3.5 sm:grid-cols-2">
            {field('line1', 'Street address')}
            {field('city', 'City')}
            {field('state', 'State', { maxLength: 2, placeholder: 'TX' })}
            {field('postalCode', 'ZIP code', { placeholder: '78701', inputMode: 'numeric' })}
          </div>
          <Why>
            This has to match the address the IRS has for your EIN, not necessarily where you work
            from today.
          </Why>
        </div>
      ) : null}

      {step.key === 'contact' ? (
        <div className="space-y-3.5">
          <div className="grid gap-3.5 sm:grid-cols-2">
            {field('contactFirst', 'First name')}
            {field('contactLast', 'Last name')}
          </div>
          {field('contactEmail', 'Email', { type: 'email' })}
          {field('contactPhone', 'Phone', { placeholder: '(512) 555-0123' })}
          <Why>
            If the carrier needs something else before they approve you, this is who they write to.
            It is not shown to customers and it is not the number you text from.
          </Why>
        </div>
      ) : null}

      {step.key === 'about' ? (
        <div className="space-y-4">
          <div role="radiogroup" aria-label="What you will text about" className="space-y-2.5">
            {USE_CASES.map((option) => (
              <RadioCard
                key={option.value}
                selected={form.useCase === option.value}
                onSelect={() => set('useCase', option.value)}
                testId={`usecase-${option.value}`}
                title={option.title}
                description={option.description}
              />
            ))}
          </div>
          <Why>
            The carrier checks this against your example texts. Picking &ldquo;promotions&rdquo;
            when you only confirm appointments makes approval slower and more expensive; picking
            &ldquo;customer care&rdquo; and then sending offers gets the campaign suspended later.
          </Why>
          <Issues issues={issuesFor(issues, 'useCase')} />
          <Field label="Roughly how many texts you will send" htmlFor="a2p-volume">
            <Select
              id="a2p-volume"
              value={form.volume}
              onChange={(e) => set('volume', e.target.value)}
            >
              {VOLUMES.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="space-y-2" data-testid="a2p-sensitive">
            <legend className="mb-1.5 text-[13.5px] font-semibold">
              Will any of your texts be about these?
            </legend>
            {SENSITIVE_TOPICS.map((topic) => (
              <Checkbox
                key={topic.id}
                className="text-[13px]"
                label={topic.label}
                checked={form.sensitive?.includes(topic.id) ?? false}
                onChange={(e) =>
                  set(
                    'sensitive',
                    e.target.checked
                      ? [...(form.sensitive ?? []).filter((t) => t !== topic.id), topic.id]
                      : (form.sensitive ?? []).filter((t) => t !== topic.id),
                  )
                }
              />
            ))}
            <Checkbox
              className="text-[13px] font-medium"
              label="None of these"
              checked={form.sensitive !== null && form.sensitive.length === 0}
              onChange={(e) => set('sensitive', e.target.checked ? [] : null)}
              data-testid="a2p-sensitive-none"
            />
          </fieldset>
          <Why>
            The carriers handle some kinds of business differently: some they don&rsquo;t approve at
            all, some only with an age check, and lenders they look at harder. Saying so now is
            better than finding out from a rejection a week from now.
          </Why>
          <Issues issues={issuesFor(issues, 'sensitiveTopics')} />
        </div>
      ) : null}

      {step.key === 'samples' ? (
        <div className="space-y-4">
          <Callout tone="info">
            Write them as you would really send them. They are not examples of the style — the
            carrier reads them as the actual messages, and checks that your business name is in them
            and that at least one says how to stop. Put the parts that change in brackets, like
            [First Name] or [Date].
          </Callout>
          {form.samples.map((sample, i) => (
            <Field key={i} label={`Example ${i + 1}`} htmlFor={`a2p-sample-${i}`}>
              <Textarea
                id={`a2p-sample-${i}`}
                value={sample}
                rows={3}
                onChange={(e) =>
                  set(
                    'samples',
                    form.samples.map((s, j) => (j === i ? e.target.value : s)),
                  )
                }
              />
            </Field>
          ))}
          <div className="rounded-menu border border-border bg-card-2 p-3.5">
            <p className="text-[13.5px] font-semibold">Stuck? Start from one of these</p>
            <div className="mt-2 space-y-2">
              {sampleSuggestions(businessName, form.useCase).map((suggestion, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    const next = [...form.samples];
                    const slot = next.findIndex((s) => !s.trim());
                    next[slot === -1 ? 0 : slot] = suggestion;
                    set('samples', next);
                  }}
                  data-testid={`a2p-suggestion-${i}`}
                  className="block w-full rounded-menu bg-card p-2.5 text-left text-[13px] text-text-2 hover:bg-card-3"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
          <Issues issues={issuesFor(issues, 'messageSamples')} />
        </div>
      ) : null}

      {step.key === 'optin' ? (
        <OptInStep
          workspaceId={workspaceId}
          businessName={businessName}
          form={form}
          set={set}
          surfaces={surfaces}
          onSurfaces={setSurfaces}
          origin={origin}
          issues={issues}
        />
      ) : null}

      {step.key === 'policy' ? (
        <PolicyStep
          businessName={businessName}
          form={form}
          set={set}
          origin={origin}
          siteSlug={surfaces.siteSlug}
          phone={number?.display}
        />
      ) : null}

      {step.key === 'review' ? (
        <ReviewStep
          form={form}
          issues={issues}
          serverErrors={serverErrors}
          checks={checks}
          checking={checking}
          onRecheck={() => void runPreflight()}
          agreed={agreed}
          onAgreed={setAgreed}
          onJump={(key) => setAt(STEPS.findIndex((s) => s.key === key))}
        />
      ) : null}

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => (at === 0 ? onBack?.() : setAt(at - 1))}
          disabled={busy || (at === 0 && !onBack)}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        {at === STEPS.length - 1 ? (
          <Button
            type="button"
            onClick={submit}
            disabled={
              busy ||
              checking ||
              hasBlockers(issues) ||
              !agreed ||
              !checks ||
              preflightBlocked(checks)
            }
            data-testid="submit-registration"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy ? 'Sending…' : 'Send to the carriers'}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => setAt(at + 1)}
            disabled={stepBlockers.length > 0}
            data-testid="a2p-next"
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
      {at < STEPS.length - 1 && stepBlockers.length > 0 ? (
        <p className="mt-2 text-right text-[13px] text-text-3">
          Fix the above to carry on. It saves a week of waiting.
        </p>
      ) : null}
    </div>
  );
}

// ---------- the policy step ----------

function PolicyStep({
  businessName,
  form,
  set,
  origin,
  siteSlug,
  phone,
}: {
  businessName: string;
  form: WizardForm;
  set: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
  origin: string;
  siteSlug: string | null;
  /** The business number, which the terms give as the way to get help. Not known yet when it is on its way. */
  phone: string | undefined;
}) {
  const own = form.ownPolicyUrl.trim().length > 0;
  const ownTerms = form.ownTermsUrl.trim().length > 0;
  const hostedUrl = siteSlug ? `${origin}/legal/${siteSlug}/privacy` : null;
  const hostedTermsUrl = siteSlug ? `${origin}/legal/${siteSlug}/terms` : null;
  const business = {
    name: businessName,
    legalName: form.legalName,
    website: withScheme(form.website),
    email: form.contactEmail,
    ...(phone ? { phone } : {}),
    offers: sendsOffers(form.useCase),
    address: {
      line1: form.line1,
      city: form.city,
      state: form.state,
      postalCode: form.postalCode,
    },
  };
  const policy = privacyPolicy(business);
  const terms = termsOfService(business);
  const termsTexting = terms.sections.find((s) => /text messages/i.test(s.heading));
  const clause = policy.sections.find((s) => /text messages/i.test(s.heading))?.paragraphs.at(-1);

  return (
    <div className="space-y-4">
      <Callout tone="info">
        Most small business websites have no privacy policy at all, and a campaign with nothing for
        the reviewer to read is turned down. We write one from what you have already told us.
      </Callout>

      <div role="radiogroup" aria-label="Privacy policy" className="space-y-2.5">
        <RadioCard
          selected={!own}
          onSelect={() => set('ownPolicyUrl', '')}
          testId="policy-hosted"
          title={
            <span className="flex items-center gap-2">
              Use the one we write for you
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-on-accent">
                Recommended
              </span>
            </span>
          }
          description="Built from your business details, kept up to date, and carrying the exact sentence about text messages that reviewers look for."
        />
        <RadioCard
          selected={own}
          onSelect={() => set('ownPolicyUrl', form.ownPolicyUrl || withScheme(form.website))}
          testId="policy-own"
          title="I already have my own"
          description="Point us at it. It has to mention text messages and say that phone numbers are not shared — otherwise the registration is turned down."
        />
      </div>

      {own ? (
        <>
          <Field label="Where your privacy policy is" htmlFor="a2p-policy-url">
            <Input
              id="a2p-policy-url"
              value={form.ownPolicyUrl}
              onChange={(e) => set('ownPolicyUrl', e.target.value)}
              placeholder="https://example.com/privacy"
            />
          </Field>
          {clause ? (
            <div className="rounded-menu border border-border bg-card-2 p-4">
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-[13.5px] font-semibold">Make sure it says this</p>
                <CopyButton text={clause} />
              </div>
              <p className="rounded-menu bg-card p-3 text-[13px] leading-relaxed text-text-2">
                {clause}
              </p>
              <p className="mt-1.5 text-[13px] text-text-3">
                Word for word. Reviewers scan for this sentence, and a policy that says the same
                thing differently is one they have to read carefully — which some of them do not.
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <div className="rounded-menu border border-border bg-card-2 p-4">
          <p className="text-[13.5px] font-semibold">{policy.title}</p>
          {hostedUrl ? (
            <a
              className="mt-1 block text-[13px] underline"
              href={hostedUrl}
              target="_blank"
              rel="noreferrer"
            >
              {hostedUrl}
            </a>
          ) : null}
          <PolicyPreview sections={policy.sections} />
        </div>
      )}

      <div className="border-t border-border pt-4">
        <p className="mb-2 text-[13.5px] font-semibold">Your terms</p>
        <div role="radiogroup" aria-label="Terms" className="space-y-2.5">
          <RadioCard
            selected={!ownTerms}
            onSelect={() => set('ownTermsUrl', '')}
            testId="terms-hosted"
            title="Use the terms we write for you"
            description="Short terms that cover your texts the way the carriers expect: what you text about, how often, rates, STOP and HELP, and how to reach you."
          />
          <RadioCard
            selected={ownTerms}
            onSelect={() =>
              set('ownTermsUrl', form.ownTermsUrl || `${withScheme(form.website)}/terms`)
            }
            testId="terms-own"
            title="I already have my own"
            description="Point us at them. They should have a section on text messages, and your tick box should link to them."
          />
        </div>
        {ownTerms ? (
          <>
            <Field label="Where your terms are" htmlFor="a2p-terms-url">
              <Input
                id="a2p-terms-url"
                value={form.ownTermsUrl}
                onChange={(e) => set('ownTermsUrl', e.target.value)}
                placeholder="https://example.com/terms"
              />
            </Field>
            <div className="mt-3 rounded-menu border border-border bg-card-2 p-4">
              <p className="text-[13.5px] font-semibold">What they have to say about texts</p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] text-text-2">
                {TERMS_TEXTING_ITEMS.map((item) => (
                  <li key={item.label}>{item.label[0]!.toUpperCase() + item.label.slice(1)}</li>
                ))}
              </ul>
              {termsTexting ? (
                <>
                  <div className="mb-1.5 mt-3 flex items-center justify-between">
                    <p className="text-[13.5px] font-semibold">Or add this section, as it is</p>
                    <CopyButton text={termsTexting.paragraphs.join('\n\n')} />
                  </div>
                  <div className="space-y-2 rounded-menu bg-card p-3 text-[13px] leading-relaxed text-text-2">
                    {termsTexting.paragraphs.map((paragraph, i) => (
                      <p key={i}>{paragraph}</p>
                    ))}
                  </div>
                </>
              ) : null}
              <p className="mt-1.5 text-[13px] text-text-3">
                The reviewer opens your terms from the registration. We check them for each of these
                before you send it.
              </p>
            </div>
          </>
        ) : (
          <div className="mt-3 rounded-menu border border-border bg-card-2 p-4">
            <p className="text-[13.5px] font-semibold">{terms.title}</p>
            {hostedTermsUrl ? (
              <a
                className="mt-1 block text-[13px] underline"
                href={hostedTermsUrl}
                target="_blank"
                rel="noreferrer"
              >
                {hostedTermsUrl}
              </a>
            ) : null}
            <PolicyPreview sections={terms.sections} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A generated policy's sections, in a box that scrolls. */
function PolicyPreview({
  sections,
}: {
  sections: readonly { heading: string; paragraphs: readonly string[] }[];
}) {
  return (
    <div className="mt-3 max-h-64 space-y-3 overflow-y-auto pr-1">
      {sections.map((section) => (
        <div key={section.heading}>
          <p className="text-[13px] font-semibold">{section.heading}</p>
          {section.paragraphs.map((paragraph, i) => (
            <p key={i} className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-text-2">
              {paragraph}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------- the review step ----------

/** One answer as the review lists it, with a way back to the step that set it. */
function Row({ label, value, onJump }: { label: string; value: ReactNode; onJump: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-2.5 last:border-0">
      <div className="min-w-0">
        <p className="text-[13px] text-text-2">{label}</p>
        <div className="text-[13.5px]">{value || <span className="text-text-3">—</span>}</div>
      </div>
      <button
        type="button"
        onClick={onJump}
        className="flex-none text-[13px] text-accent-text underline"
      >
        Change
      </button>
    </div>
  );
}

function ReviewStep({
  form,
  issues,
  serverErrors,
  checks,
  checking,
  onRecheck,
  agreed,
  onAgreed,
  onJump,
}: {
  form: WizardForm;
  issues: readonly A2pIssue[];
  serverErrors: readonly string[];
  /** What a reviewer would find, or null while it has not been looked at. */
  checks: readonly PreflightCheck[] | null;
  checking: boolean;
  onRecheck: () => void;
  agreed: boolean;
  onAgreed: (next: boolean) => void;
  onJump: (key: string) => void;
}) {
  const blockers = issues.filter((i) => i.severity === 'blocker');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const pathLabel = OPT_IN_PATHS.find((p) => p.value === form.optInPath)?.title ?? '—';
  const useCaseLabel = USE_CASES.find((u) => u.value === form.useCase)?.title ?? form.useCase;

  return (
    <div className="space-y-4">
      {blockers.length ? (
        <Callout tone="danger" icon={CircleAlert}>
          <div>
            <p className="font-semibold">
              {blockers.length === 1
                ? 'One thing would get this turned down'
                : `${blockers.length} things would get this turned down`}
            </p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              {blockers.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
            </ul>
          </div>
        </Callout>
      ) : (
        <Callout tone="info" icon={Check}>
          Nothing here looks like it would be refused. The carriers usually answer within three to
          seven working days.
        </Callout>
      )}

      <div className="rounded-menu border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-[13.5px] font-semibold">What a reviewer will find</p>
          {checking ? (
            <span className="inline-flex items-center gap-1.5 text-[13px] text-text-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Looking…
            </span>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={onRecheck}>
              Check again
            </Button>
          )}
        </div>
        {checking && !checks ? (
          <p className="text-[13px] text-text-2">
            Opening your website, your privacy policy, your terms and the page where customers agree
            — the same four a carrier opens.
          </p>
        ) : null}
        {checks?.map((check) => (
          <div
            key={check.id}
            className="flex items-start gap-2.5 border-b border-border py-2.5 last:border-0"
          >
            {check.ok ? (
              <Check className="mt-0.5 h-4 w-4 flex-none text-success-text" aria-hidden />
            ) : (
              <CircleAlert
                className={cn(
                  'mt-0.5 h-4 w-4 flex-none',
                  check.severity === 'blocker' ? 'text-danger-text' : 'text-warning-text',
                )}
                aria-hidden
              />
            )}
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium">{check.label}</p>
              <p className="text-[13px] leading-relaxed text-text-2">{check.detail}</p>
              {check.url ? (
                <a
                  className="text-[13px] underline text-text-3"
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {check.url}
                </a>
              ) : null}
            </div>
          </div>
        ))}
        {!checking && !checks ? (
          <p className="text-[13px] text-text-2">
            We could not look just now. Press &ldquo;Check again&rdquo; — the registration will not
            go until these have been looked at.
          </p>
        ) : null}
      </div>

      {warnings.length ? (
        <Callout tone="warning" icon={CircleAlert}>
          <div>
            <p className="font-semibold">Worth a second look</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              {warnings.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
            </ul>
          </div>
        </Callout>
      ) : null}

      {serverErrors.length ? (
        <Callout tone="danger" icon={CircleAlert}>
          <div>
            <p className="font-semibold">The carriers would not take it</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              {serverErrors.map((message, i) => (
                <li key={i}>{message}</li>
              ))}
            </ul>
          </div>
        </Callout>
      ) : null}

      <div className="rounded-menu border border-border bg-card px-4">
        <Row label="Business" value={form.legalName} onJump={() => onJump('business')} />
        <Row
          label="EIN"
          value={form.businessType === 'sole_proprietor' ? 'Sole proprietor' : form.ein}
          onJump={() => onJump('business')}
        />
        <Row label="Website" value={form.website} onJump={() => onJump('where')} />
        <Row
          label="Contact"
          value={`${form.contactFirst} ${form.contactLast}`.trim()}
          onJump={() => onJump('contact')}
        />
        <Row label="Texting about" value={useCaseLabel} onJump={() => onJump('about')} />
        <Row
          label="Examples"
          value={
            <ul className="mt-0.5 space-y-1 text-text-2">
              {form.samples
                .filter((s) => s.trim())
                .map((sample, i) => (
                  <li key={i}>&ldquo;{sample}&rdquo;</li>
                ))}
            </ul>
          }
          onJump={() => onJump('samples')}
        />
        <Row
          label="Anything the carriers treat differently"
          value={
            form.sensitive === null
              ? ''
              : form.sensitive.length === 0
                ? 'None of these'
                : SENSITIVE_TOPICS.filter((t) => form.sensitive!.includes(t.id))
                    .map((t) => t.label)
                    .join('; ')
          }
          onJump={() => onJump('about')}
        />
        <Row label="How people agree" value={pathLabel} onJump={() => onJump('optin')} />
        {form.optInPath === 'own_site' ? (
          <Row
            label="The page with the tick box"
            value={form.optInUrl}
            onJump={() => onJump('optin')}
          />
        ) : null}
        {form.optInPath === 'in_person' ? (
          <Row
            label="What customers see or hear"
            value={form.optInProofUrl}
            onJump={() => onJump('optin')}
          />
        ) : null}
        <Row
          label="Privacy policy"
          value={form.ownPolicyUrl.trim() || 'The one we write for you'}
          onJump={() => onJump('policy')}
        />
        <Row
          label="Terms"
          value={form.ownTermsUrl.trim() || 'The ones we write for you'}
          onJump={() => onJump('policy')}
        />
      </div>

      <Checkbox
        className="text-[13px]"
        label="These details are accurate, and we only text customers who agreed to it."
        checked={agreed}
        onChange={(e) => onAgreed(e.target.checked)}
        data-testid="business-agree"
      />
    </div>
  );
}
