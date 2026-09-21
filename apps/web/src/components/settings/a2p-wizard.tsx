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
  privacyPolicy,
  sampleSuggestions,
  type A2pDraft,
  type A2pField,
  type A2pIssue,
  type OptInPath,
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
import { useMemo, useState, type ReactNode } from 'react';
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
  /** '' means "use the one we host for you". */
  ownPolicyUrl: string;
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
    policyUrl?: string | null;
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
    ownPolicyUrl: b.policyUrl ?? '',
  };
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
    fields: ['useCase', 'monthlyVolume'],
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
    fields: ['optInPath', 'optInDescription'],
  },
  {
    key: 'policy',
    title: 'Your privacy policy',
    blurb: 'The reviewer opens this looking for one particular sentence.',
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

  /** Rewrites the sentence from the path and whatever is live, unless the business has edited it itself. */
  const describe = (path: OptInPath, s: HostedSurfaces) =>
    set('optIn', optInDescriptionFor(businessName, path, urlsOf(s, origin)));

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
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[13.5px] font-semibold">Put this beside the tick box</p>
              <CopyButton text={optInDescriptionFor(businessName, 'own_site')} />
            </div>
            <p className="rounded-menu bg-card p-3 text-[13px] leading-relaxed text-text-2">
              {optInDescriptionFor(businessName, 'own_site')}
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
        <Callout tone="warning" icon={CircleAlert}>
          This can be approved, but there is no web page for the reviewer to check, so expect
          questions and a longer wait. If you have a website at all, the first option is much
          faster.
        </Callout>
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
  surfaces: initialSurfaces = EMPTY_SURFACES,
  onBack,
  onSubmitted,
}: {
  workspaceId: string;
  businessName: string;
  number: PhoneNumberInfo;
  me: { fullName: string; email: string };
  initial: Record<string, unknown> | null;
  surfaces?: HostedSurfaces;
  onBack?: () => void;
  onSubmitted: () => void;
}) {
  const [form, setForm] = useState<WizardForm>(() => wizardFormFrom(initial, businessName, me));
  const [surfaces, setSurfaces] = useState<HostedSurfaces>(initialSurfaces);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  // The business says these details are true before they go to a carrier. Kept from the old form: it is
  // the record that somebody asserted it, which is what a carrier audit asks for.
  const [agreed, setAgreed] = useState(false);

  const set = <K extends keyof WizardForm>(key: K, value: WizardForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const local = number.numberType === 'local';
  const issues = useMemo(() => checkDraft(draftOf(form), businessName), [form, businessName]);
  const step = STEPS[at]!;

  /** Blockers on the fields this step owns — what stops it advancing. */
  const stepBlockers = step.fields.flatMap((field) =>
    issuesFor(issues, field).filter((i) => i.severity === 'blocker'),
  );
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  async function submit() {
    setBusy(true);
    setServerErrors([]);
    try {
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
              policyUrl: form.ownPolicyUrl.trim() ? withScheme(form.ownPolicyUrl) : null,
              monthlyVolume: form.volume as 'under_1000',
            },
          },
        }),
      );
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
        </div>
      ) : null}

      {step.key === 'samples' ? (
        <div className="space-y-4">
          <Callout tone="info">
            Write them as you would really send them. They are not examples of the style — the
            carrier reads them as the actual messages, and checks that your business name is in them
            and that at least one says how to stop.
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
        />
      ) : null}

      {step.key === 'review' ? (
        <ReviewStep
          form={form}
          issues={issues}
          serverErrors={serverErrors}
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
            disabled={busy || hasBlockers(issues) || !agreed}
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
}: {
  businessName: string;
  form: WizardForm;
  set: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
  origin: string;
  siteSlug: string | null;
}) {
  const own = form.ownPolicyUrl.trim().length > 0;
  const hostedUrl = siteSlug ? `${origin}/legal/${siteSlug}/privacy` : null;
  const policy = privacyPolicy({
    name: businessName,
    legalName: form.legalName,
    website: withScheme(form.website),
    email: form.contactEmail,
    address: {
      line1: form.line1,
      city: form.city,
      state: form.state,
      postalCode: form.postalCode,
    },
  });
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
          <div className="mt-3 max-h-64 space-y-3 overflow-y-auto pr-1">
            {policy.sections.map((section) => (
              <div key={section.heading}>
                <p className="text-[13px] font-semibold">{section.heading}</p>
                {section.paragraphs.map((paragraph, i) => (
                  <p
                    key={i}
                    className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-text-2"
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
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
  agreed,
  onAgreed,
  onJump,
}: {
  form: WizardForm;
  issues: readonly A2pIssue[];
  serverErrors: readonly string[];
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
        <Row label="How people agree" value={pathLabel} onJump={() => onJump('optin')} />
        <Row
          label="Privacy policy"
          value={form.ownPolicyUrl.trim() || 'The one we write for you'}
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
