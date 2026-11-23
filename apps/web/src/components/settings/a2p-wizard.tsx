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
 * option is recommended and first because it is the one we can make true in a single click: the website chat, whose
 * code goes in the footer of the business's own site, asks for a visitor's details after their first message, with
 * the box to agree to texts and links to the privacy policy and terms.
 */
import {
  checkDraft,
  confirmationsFor,
  formEmbedSnippet,
  formatPhone,
  hasBlockers,
  issuesFor,
  money,
  optInDescriptionFor,
  otherSiteForms,
  policyAsText,
  policyPagesSummary,
  privacyPolicy,
  industryLabel,
  sameDescription,
  samePolicyPage,
  SAMPLE_KINDS,
  sampleChoices,
  sampleHasOptOut,
  sampleNamesBusiness,
  samplesFitIndustry,
  senderForCarriers,
  SENSITIVE_TOPICS,
  sendsOffers,
  shortAddress,
  siteFormsSummary,
  smsConsentWords,
  TERMS_TEXTING_ITEMS,
  termsOfService,
  TEXTING_CAMPAIGN_MONTH_CENTS,
  textingFeeLines,
  textingFeeTotal,
  tradingName,
  updatedPolicyHtml,
  updatedPolicyText,
  normalizeChatOrigin,
  notGreen as notGreenList,
  fixesMissing,
  type A2pDraft,
  type A2pField,
  type A2pIssue,
  type BusinessAddress,
  type ChatAskFor,
  type Confirmation,
  type ConfirmationId,
  type OptInPath,
  type PolicyKind,
  type PolicyPages,
  type PolicyUpdateInput,
  type PolicyUpdateOutput,
  type UpdatedPolicy,
  type PreflightCheck,
  type SampleKind,
  type SensitiveTopicId,
  type TextingFeesPaidFor,
  type WebsiteFixId,
} from '@hfos/core';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  ClipboardList,
  Copy,
  Globe,
  HelpCircle,
  Loader2,
  MessageCircle,
  Sparkles,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { GuidedCard, type GuidedStep, type SavedState } from '@/components/guided-setup/frame';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { ChatWidget, PhoneNumberInfo } from '@/lib/api/types';
import {
  policyUpdate,
  registrationPreflight,
  siteFormsOn,
  type SiteFormsFound,
} from '@/lib/api/worker';
import { cn } from '@/lib/utils';
import {
  hostOf,
  InstallCheck,
  PlatformSteps,
  SnippetCode,
  snippetOf,
  snippetSrc,
} from './chat-install';
import { SiteCheckHelp } from './site-check-help';
import {
  HideChatSwitch,
  WebPersonButton,
  type WebPersonChat,
  type WebPersonForm,
} from './web-person';

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
  /** How customers reach the business, as our privacy policy and terms say under "Contact us". */
  policyEmail: string;
  policyPhone: string;
  /**
   * The question on the privacy policy and terms has been settled once: the business's website was looked at for
   * its own (and they were picked when found), or the person picked. After that the answers are left alone.
   */
  policyLooked: boolean;
  /** Topics the carriers treat differently: the ids picked, [] for "None of these", null before answering. */
  sensitive: string[] | null;
  /**
   * Every other way customers agree, each with its page or proof (Twilio 30896: "list every method along with
   * proofs"). The description names each one, and the last step opens each link.
   */
  otherWays: OtherWayAnswer[];
  /** The ticks on the last step only the business can give (core's confirmationsFor). */
  confirmed: string[];
}

/** Another way customers agree, as typed. */
export interface OtherWayAnswer {
  path: OptInPath;
  url: string;
}

/** The business's latest ask for HandsFreeOS to check its registration (`registration.review.get`). */
interface ReviewInfo {
  readonly reviewId: string;
  readonly status: 'waiting' | 'approved' | 'sent_back' | 'withdrawn';
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly ticketNumber: number | null;
  readonly sentAt: string | null;
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

/**
 * Reads the last submission back into the form, so a turned-down registration is corrected, not retyped. A first
 * one starts from the website and the address the business already gave (Settings → Workspace, or setup).
 */
export function wizardFormFrom(
  initial: Record<string, unknown> | null,
  businessName: string,
  me: { fullName: string; email: string },
  businessWebsite: string | null = null,
  businessAddress: BusinessAddress | null = null,
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
    policyContact?: { email?: string; phone?: string };
    sensitiveTopics?: string[];
    messageSamples?: string[];
    useCase?: string;
    monthlyVolume?: string;
    otherWays?: { path?: OptInPath; url?: string }[];
  };
  const [meFirst = '', ...meRest] = me.fullName.trim().split(/\s+/);
  return {
    legalName: b.legalName ?? businessName,
    businessType: b.businessType ?? 'llc',
    ein: b.ein ?? '',
    website: b.website ?? businessWebsite ?? '',
    line1:
      b.address?.line1 ??
      (businessAddress
        ? [businessAddress.line1, businessAddress.line2].filter(Boolean).join(', ')
        : ''),
    city: b.address?.city ?? businessAddress?.city ?? '',
    state: b.address?.state ?? businessAddress?.state ?? '',
    postalCode: b.address?.postalCode ?? businessAddress?.postalCode ?? '',
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
    // Filled in from the contact and the business number when the policy step opens, unless already given.
    policyEmail: b.policyContact?.email ?? '',
    policyPhone: b.policyContact?.phone ? formatPhone(b.policyContact.phone) : '',
    // A registration that has gone already answered it.
    policyLooked: !!initial,
    sensitive: Array.isArray(b.sensitiveTopics) ? b.sensitiveTopics : null,
    otherWays: Array.isArray(b.otherWays)
      ? b.otherWays.flatMap((w) => (w.path && w.url ? [{ path: w.path, url: w.url }] : []))
      : [],
    // Ticked again each time: they say something is true now.
    confirmed: [],
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
    } else if (key === 'confirmed') {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) next[key] = value;
    } else if (key === 'otherWays') {
      if (Array.isArray(value))
        next[key] = value.flatMap((w: unknown) => {
          const o = (w ?? {}) as { path?: unknown; url?: unknown };
          return OPT_IN_PATH_IDS.includes(o.path as OptInPath) && typeof o.url === 'string'
            ? [{ path: o.path as OptInPath, url: o.url }]
            : [];
        });
    } else if (typeof value === typeof was) next[key] = value;
  }
  return next as unknown as WizardForm;
}

const OPT_IN_PATH_IDS: readonly OptInPath[] = ['hosted', 'own_site', 'in_person'];

/**
 * The privacy policy and terms a reviewer is given: the business's own when it gave them, ours when we host them, and
 * nothing before a site exists. The description has to name both (Twilio 30924 and 30896).
 */
function legalPagesOf(f: WizardForm, s: HostedSurfaces, origin: string) {
  return {
    policyUrl: f.ownPolicyUrl.trim()
      ? withScheme(f.ownPolicyUrl)
      : s.siteSlug
        ? `${origin}/legal/${s.siteSlug}/privacy`
        : null,
    termsUrl: f.ownTermsUrl.trim()
      ? withScheme(f.ownTermsUrl)
      : s.siteSlug
        ? `${origin}/legal/${s.siteSlug}/terms`
        : null,
  };
}

/** The other ways customers agree that say something: a path and a link. */
const otherWaysOf = (f: WizardForm) =>
  f.otherWays.filter((w) => w.url.trim()).map((w) => ({ path: w.path, url: withScheme(w.url) }));

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
  policyUrl: f.ownPolicyUrl,
  termsUrl: f.ownTermsUrl,
  policyContact: { email: f.policyEmail, phone: f.policyPhone },
});

const withScheme = (raw: string) => {
  const url = raw.trim();
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
};

/** What our privacy policy and terms are written from: the preview, and the review's check of how they'll read. */
const policyDetailsOf = (f: WizardForm) => ({
  legalName: f.legalName,
  website: withScheme(f.website),
  ...(f.policyEmail.trim() ? { email: f.policyEmail.trim() } : {}),
  ...(f.policyPhone.trim() ? { phone: f.policyPhone.trim() } : {}),
  offers: sendsOffers(f.useCase),
  address: { line1: f.line1, city: f.city, state: f.state, postalCode: f.postalCode },
});

// ---------- the steps ----------

interface Step {
  readonly key: string;
  readonly title: string;
  /** One line under the title: what this step is for, never what it contains. */
  readonly blurb: string;
  /** The fields this step owns. A blocker on one of these stops the step advancing. */
  readonly fields: readonly A2pField[];
  /** Which of the four parts it belongs to (`PARTS`), and what the list beside the question calls it. */
  readonly part: number;
  readonly label: string;
}

/** The eight questions in four parts (the owner's design, 22 Nov 2026): what the start screen and the side list name. */
const PARTS: readonly { readonly title: string; readonly about: string }[] = [
  {
    title: 'Your business',
    about: 'Your legal name and EIN, your website and who to write to. The carriers look you up.',
  },
  { title: 'Your texts', about: 'What you’ll text about, and two texts you’d really send.' },
  {
    title: 'Your website',
    about:
      'Customers need a place to say yes to texts, and a privacy policy and terms that mention them. We hand you both. You or your web person put them on your site.',
  },
  {
    title: 'We check it, then you send it',
    about:
      'We open your site the way a carrier’s reviewer does and show you anything they’d turn down. Then the carriers take 1 to 3 weeks.',
  },
];

const STEPS: readonly Step[] = [
  {
    key: 'business',
    title: 'Who the carriers will look up',
    blurb: 'They check this against IRS records before they let you text anyone.',
    fields: ['legalName', 'businessType', 'ein'],
    part: 0,
    label: 'Who the carriers look up',
  },
  {
    key: 'where',
    title: 'Where to find you',
    blurb: 'Someone reviewing this will open your website and read it.',
    fields: ['website'],
    part: 0,
    label: 'Where to find you',
  },
  {
    key: 'contact',
    title: 'Who to write to',
    blurb: 'The carriers write here if they need something. Nobody else sees it.',
    fields: ['contact'],
    part: 0,
    label: 'Who to write to',
  },
  {
    key: 'about',
    title: 'What you will text about',
    blurb: 'Pick the one that matches your week, not the one that sounds best.',
    fields: ['useCase', 'monthlyVolume', 'sensitiveTopics'],
    part: 1,
    label: 'What you’ll text about',
  },
  {
    key: 'samples',
    title: 'Two texts you would really send',
    blurb: 'These are read as the actual messages you plan to send.',
    fields: ['messageSamples'],
    part: 1,
    label: 'Two texts you’d really send',
  },
  {
    key: 'optin',
    title: 'How will customers agree to get texts?',
    blurb:
      'The carriers open your website and look for the place a customer says yes. Pick one and we set it up.',
    fields: ['optInPath', 'optInUrl', 'optInProofUrl', 'otherWays', 'optInDescription'],
    part: 2,
    label: 'How customers agree',
  },
  {
    key: 'policy',
    title: 'Your privacy policy and terms',
    blurb: 'The reviewer opens both, and reads the policy for one particular sentence.',
    fields: ['policyContact'],
    part: 2,
    label: 'Privacy policy and terms',
  },
  {
    key: 'review',
    title: 'Before it goes',
    blurb: 'Everything the carriers will see.',
    fields: [],
    part: 3,
    label: 'Checks before it goes',
  },
];

// ---------- small pieces ----------

/** "Why do they ask this?", folded away until somebody wants it. `label` asks a different question. */
function Why({
  children,
  label = 'Why do they ask this?',
}: {
  children: ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-[13px] text-text-2 hover:text-text"
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
        {label}
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5 text-[13px] leading-relaxed text-text-2">{children}</div>
      ) : null}
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

/**
 * A business customers know by another name (a DBA): what the carriers are told, and the three things that get
 * it approved first time. HandsFreeOS itself is one, a DBA of Go Biz Help LLC.
 */
function DbaCallout({ legalName, dba }: { legalName: string; dba: string }) {
  return (
    <Callout tone="info" icon={HelpCircle} data-testid="dba-callout">
      <div className="space-y-1.5">
        <p>
          <span className="font-semibold">Customers know you as {dba}.</span> That&rsquo;s a DBA
          (&ldquo;doing business as&rdquo;), and it&rsquo;s fine. We&rsquo;ll tell the carriers
          &ldquo;{legalName} (doing business as {dba})&rdquo;.
        </p>
        <p>To get approved the first time:</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>Use {legalName}&rsquo;s EIN, and the address on its IRS letter.</li>
          <li>
            Show both names on your website, for example at the bottom of every page: &ldquo;{dba}{' '}
            is owned and run by {legalName}.&rdquo; We check for it before you send.
          </li>
          <li>Sign your example texts as {dba}, the name customers will see.</li>
        </ul>
        <p>
          Already registered {legalName} in another workspace? Use the same legal name, EIN and
          address here. Each workspace texts from its own numbers, so each needs its own approval,
          but the carriers have already checked these details once.
        </p>
      </div>
    </Callout>
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

/**
 * Copies `text`, and `html` beside it when given: a website editor pasting it keeps the headings and lists, and a
 * plain box gets the text.
 */
export function CopyButton({
  text,
  html,
  label = 'Copy',
}: {
  text: string;
  html?: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={async () => {
        try {
          if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write)
            await navigator.clipboard.write([
              new ClipboardItem({
                'text/plain': new Blob([text], { type: 'text/plain' }),
                'text/html': new Blob([html], { type: 'text/html' }),
              }),
            ]);
          else await navigator.clipboard.writeText(text);
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
  /** That widget: what it asks for and when, its texts box, its sites and its install check. */
  readonly chat?: HostedChat | null;
  /** The slug of a live public form carrying the consent box, if one exists. */
  readonly contactFormSlug: string | null;
  /** The business's contact form, once the wizard has asked for it (`registration.ensure_contact_form`). */
  readonly contactForm?: HostedContactForm | null;
  readonly bookingEnabled: boolean;
  /** Where the chat's code loads from: the business's own domain once one is serving, otherwise this app. */
  readonly snippetOrigin?: string | null;
  /** Published forms a website could show, for "Email your web person". */
  readonly liveForms?: readonly WebPersonForm[];
  /** Every website chat, hidden ones too, for "Hide the website chat until texting is approved". */
  readonly chats?: readonly WebPersonChat[];
}

/** The contact form customers agree to texts on: the one every business is given, or one it already had. */
export interface HostedContactForm {
  readonly formId: string;
  readonly name: string;
  readonly slug: string;
  /** The sites it may show on. */
  readonly embedOrigins: readonly string[];
  /** Made just now, rather than already in the account. */
  readonly created: boolean;
}

/** The live website chat, as much of it as setting it up for agreeing to texts needs. */
export interface HostedChat {
  readonly id: string;
  readonly smsConsent: boolean;
  readonly askFor: ChatAskFor;
  readonly allowedOrigins: readonly string[];
  readonly install: ChatWidget['install'];
}

const EMPTY_SURFACES: HostedSurfaces = {
  siteSlug: null,
  chatPublicKey: null,
  contactFormSlug: null,
  bookingEnabled: false,
};

/** The exact origin a website is, as the chat's list of sites keeps it; null when it isn't one. */
function originOfSite(website: string): string | null {
  const got = website.trim() ? normalizeChatOrigin(website) : null;
  return got?.ok ? got.origin : null;
}

/** May the chat show on this website: it, or its www twin, is one of the chat's sites. */
function chatAllows(chat: HostedChat, website: string): boolean {
  const got = website.trim() ? normalizeChatOrigin(website) : null;
  return !!got?.ok && [got.origin, got.twin].some((o) => !!o && chat.allowedOrigins.includes(o));
}

/**
 * The chat is ready to collect agreement to texts on this website: it offers the box, asks for the mobile number
 * right after the visitor's first message, and may show on the site.
 */
function chatReady(s: HostedSurfaces, website: string): s is HostedSurfaces & { chat: HostedChat } {
  return (
    !!s.chat &&
    s.chat.smsConsent &&
    s.chat.askFor.phone === 'after_first_message' &&
    chatAllows(s.chat, website)
  );
}

/**
 * The public addresses of whatever is live, built from the surfaces and this deployment's origin. The chat's page
 * (what it asks, for the reviewer) counts only once the chat is ready: before that it shows no box to point at.
 */
function urlsOf(s: HostedSurfaces, origin: string, website: string) {
  return {
    formUrl:
      s.siteSlug && s.contactFormSlug ? `${origin}/f/${s.siteSlug}/${s.contactFormSlug}` : null,
    chatUrl: s.chatPublicKey && chatReady(s, website) ? `${origin}/chat/${s.chatPublicKey}` : null,
    siteUrl: website || null,
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
  return optInDescriptionFor(businessName, f.optInPath, urlsOf(s, origin, withScheme(f.website)), {
    pageUrl: f.optInPath === 'own_site' ? withScheme(f.optInUrl) || null : null,
    proofUrl: withScheme(f.optInProofUrl) || null,
    offers: sendsOffers(f.useCase),
    ...legalPagesOf(f, s, origin),
    otherWays: otherWaysOf(f),
  });
}

/** The paths a saved answer may hold. New registrations are offered the first two (the owner's pick 8b, 22 Nov 2026). */
const IN_PERSON_CHOICE = {
  title: 'We ask people in person or on the phone',
  description:
    'No box to tick anywhere. This is allowed, but reviewers ask more questions about it and approval takes longer.',
};

/**
 * Which of the ways on offer the answers say: the chat, the contact form we made, or both. "Both" is the chat with
 * the form's page as another way (how this screen saves it), or the form with the chat as another way (an older
 * answer). In person is no longer offered, and shows only for a registration that already says it.
 */
type AgreeWay = 'chat' | 'form' | 'both' | 'in_person' | '';
function agreeWayOf(f: Pick<WizardForm, 'optInPath' | 'otherWays'>): AgreeWay {
  if (f.optInPath === 'in_person') return 'in_person';
  if (f.optInPath === 'hosted')
    return f.otherWays.some((w) => w.path === 'own_site') ? 'both' : 'chat';
  if (f.optInPath === 'own_site')
    return f.otherWays.some((w) => w.path === 'hosted') ? 'both' : 'form';
  return '';
}

/** Each way, as the last screen's list of answers names it. */
const AGREE_WAY_LABELS: Record<AgreeWay, string> = {
  chat: 'The chat on your website',
  form: 'Your contact form',
  both: 'The chat and your contact form',
  in_person: IN_PERSON_CHOICE.title,
  '': '—',
};

/** Ask for each detail right after the first message, keeping a detail the business never asks for, or asks first. */
const AFTER_FIRST: ChatAskFor = {
  name: 'after_first_message',
  phone: 'after_first_message',
  email: 'after_first_message',
};
function askAfterFirst(now: ChatAskFor): ChatAskFor {
  const keep = (m: ChatAskFor['name']) =>
    m === 'never' || m === 'before_chat' ? m : 'after_first_message';
  return { name: keep(now.name), phone: 'after_first_message', email: keep(now.email) };
}

/**
 * Turns the hosted opt-in on: the website chat, asking for a visitor's details right after their first message, with
 * the box to agree to texts. A business with a chat already gets that one changed (its texts box on, the mobile number
 * asked after the first message, its website added to its sites) rather than a second one.
 *
 * The chat's texts box names the business's public pages when it has no name yet (`chat_widget.create`), and the
 * privacy policy and terms we host live under that name, so it's read back here. What fails is reported and left out
 * of the returned surfaces, because whatever they claim goes to a carrier.
 */
async function enableHostedOptIn(
  workspaceId: string,
  website: string,
  have: HostedSurfaces,
): Promise<{ surfaces: HostedSurfaces; failed: string[] }> {
  const failed: string[] = [];
  let { chat, chatPublicKey } = have;

  try {
    if (!chat || !chatPublicKey) {
      const created = unwrap(
        await apiBrowser().POST('/v1/commands/chat_widget.create', {
          body: { workspaceId, allowedOrigins: [website], smsConsent: true, askFor: AFTER_FIRST },
        }),
      ) as { widgetId: string; publicKey: string; allowedOrigins: string[] };
      chat = {
        id: created.widgetId,
        smsConsent: true,
        askFor: AFTER_FIRST,
        allowedOrigins: created.allowedOrigins,
        install: { seen: false, lastSeenOrigin: null, lastSeenAt: null },
      };
      chatPublicKey = created.publicKey;
    } else if (!chatReady(have, website)) {
      const askFor = askAfterFirst(chat.askFor);
      const updated = unwrap(
        await apiBrowser().POST('/v1/commands/chat_widget.update', {
          body: {
            workspaceId,
            widgetId: chat.id,
            smsConsent: true,
            askFor,
            ...(chatAllows(chat, website)
              ? {}
              : { allowedOrigins: [...chat.allowedOrigins, website] }),
          },
        }),
      ) as { allowedOrigins: string[] };
      chat = { ...chat, smsConsent: true, askFor, allowedOrigins: updated.allowedOrigins };
    }
  } catch (err) {
    failed.push(`the website chat (${errorMessage(err)})`);
  }

  let { siteSlug, bookingEnabled } = have;
  if (!siteSlug && chat?.smsConsent) {
    try {
      const got = unwrap(
        await apiBrowser().POST('/v1/queries/booking_site.get', { body: { workspaceId } }),
      );
      siteSlug = got.site?.slug ?? null;
      bookingEnabled = got.site?.enabled ?? false;
    } catch (err) {
      failed.push(`your privacy policy’s address (${errorMessage(err)})`);
    }
  }

  return {
    surfaces: { ...have, chat, chatPublicKey, siteSlug, bookingEnabled },
    failed,
  };
}

/**
 * The business's contact form, made if it has none (`registration.ensure_contact_form`): the published form with our
 * box to agree to texts that every new business is given, and that texting approval makes when it's missing (the
 * owner, 2026-11-22). Given the website, the form is allowed to show there, so its code works the moment it's pasted.
 */
async function ensureContactForm(
  workspaceId: string,
  website: string,
): Promise<EnsuredContactForm> {
  return unwrap(
    await apiBrowser().POST('/v1/commands/registration.ensure_contact_form', {
      body: { workspaceId, ...(website ? { website } : {}) },
    }),
  );
}
type EnsuredContactForm = HostedContactForm & { siteSlug: string };

/** What's public once the contact form is there: its link, and its place among the forms a website could show. */
function withContactForm(have: HostedSurfaces, got: EnsuredContactForm): HostedSurfaces {
  const listed = have.liveForms ?? [];
  const row = { formId: got.formId, name: got.name, embedOrigins: got.embedOrigins };
  return {
    ...have,
    siteSlug: got.siteSlug,
    contactFormSlug: got.slug,
    contactForm: {
      formId: got.formId,
      name: got.name,
      slug: got.slug,
      embedOrigins: got.embedOrigins,
      // Made on this visit stays "made just now" however often it's asked for again.
      created: got.created || (have.contactForm?.formId === got.formId && have.contactForm.created),
    },
    liveForms: listed.some((f) => f.formId === got.formId)
      ? listed.map((f) => (f.formId === got.formId ? row : f))
      : [...listed, row],
  };
}

/** What a web person is sent when the business uses the chat and the form together: both, and the policy. */
const BOTH_WAYS_FIXES: readonly WebsiteFixId[] = ['form', 'policy', 'chat'];

/** A look at the business's site for forms, kept a few minutes so going back and forth doesn't walk the site again. */
const siteLooks = new Map<string, { found: SiteFormsFound; at: number }>();
const SITE_LOOK_KEPT_MS = 5 * 60_000;
/** Looks still on their way, so two questions asking about the same site share one walk of it. */
const siteLooksComing = new Map<string, Promise<SiteFormsFound>>();

/** The look kept for this site, while it's fresh. */
function keptSiteLook(workspaceId: string, website: string): SiteFormsFound | null {
  const kept = siteLooks.get(`${workspaceId} ${website}`);
  return kept && Date.now() - kept.at < SITE_LOOK_KEPT_MS ? kept.found : null;
}

/** A look at the site: the one kept, the one on its way, or a new walk (`again` always walks). */
function siteLook(workspaceId: string, website: string, again = false): Promise<SiteFormsFound> {
  const key = `${workspaceId} ${website}`;
  const kept = again ? null : keptSiteLook(workspaceId, website);
  if (kept) return Promise.resolve(kept);
  const coming = again ? undefined : siteLooksComing.get(key);
  if (coming) return coming;
  const walk = siteFormsOn({ workspaceId, website })
    .then((found) => {
      siteLooks.set(key, { found, at: Date.now() });
      return found;
    })
    .finally(() => {
      if (siteLooksComing.get(key) === walk) siteLooksComing.delete(key);
    });
  siteLooksComing.set(key, walk);
  return walk;
}

type SiteLook =
  | { readonly state: 'looking' }
  | { readonly state: 'found'; readonly found: SiteFormsFound }
  | { readonly state: 'failed' };

/** One numbered thing to do, in a panel's "What to do". */
function Todo({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-card text-[12px] font-semibold text-text-2 ring-1 ring-border"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold">{title}</p>
        {children}
      </div>
    </li>
  );
}

// ---------- the opt-in step, which is the reason the wizard exists ----------

function OptInStep({
  workspaceId,
  businessName,
  form,
  set,
  onPick,
  surfaces,
  onSurfaces,
  origin,
  issues,
}: {
  workspaceId: string;
  businessName: string;
  form: WizardForm;
  set: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
  /** Picking how customers agree changes its way, its page and the other ways together, and writes the sentence. */
  onPick: (changes: Partial<WizardForm>) => void;
  surfaces: HostedSurfaces;
  onSurfaces: (change: (had: HostedSurfaces) => HostedSurfaces) => void;
  origin: string;
  issues: readonly A2pIssue[];
}) {
  const [busy, setBusy] = useState(false);
  const website = withScheme(form.website);
  const urls = urlsOf(surfaces, origin, website);
  const ready = chatReady(surfaces, website);
  // A website that's our own simple page already shows the chat, and has no contact page to paste a form into.
  const siteOrigin = originOfSite(website);
  const ownPage =
    !!siteOrigin && (siteOrigin === origin || siteOrigin === (surfaces.snippetOrigin ?? null));
  const src = surfaces.chatPublicKey
    ? snippetSrc(surfaces.snippetOrigin ?? origin, surfaces.chatPublicKey)
    : null;
  const offers = sendsOffers(form.useCase);
  const way = agreeWayOf(form);
  const usesChat = way === 'chat' || way === 'both';
  const usesForm = way === 'form' || way === 'both';

  // ---- the contact form: made when the business signed up, and here when it's missing ----
  const contact = surfaces.contactForm ?? null;
  const [formFailed, setFormFailed] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const getForm = useCallback(async () => {
    setFormBusy(true);
    setFormFailed(null);
    try {
      // Our own page isn't a site to allow the form on: it has its own page there already.
      const got = await ensureContactForm(workspaceId, ownPage ? '' : website);
      onSurfaces((had) => withContactForm(had, got));
    } catch (err) {
      setFormFailed(errorMessage(err));
    } finally {
      setFormBusy(false);
    }
  }, [workspaceId, website, ownPage, onSurfaces]);
  const allowedHere =
    !!contact && (ownPage || !siteOrigin || contact.embedOrigins.includes(siteOrigin));
  const asked = useRef(false);
  useEffect(() => {
    // Once when the question opens: the form made if it's missing, and allowed on the website typed two steps back.
    if (asked.current || allowedHere) return;
    asked.current = true;
    void getForm();
  }, [allowedHere, getForm]);
  // Its public link, on the business's own domain when one is serving, and the code that shows it on a website.
  const formUrl =
    contact && surfaces.siteSlug
      ? `${surfaces.snippetOrigin ?? origin}/f/${surfaces.siteSlug}/${contact.slug}`
      : null;
  const formCode =
    contact && formUrl
      ? formEmbedSnippet({ publicUrl: formUrl, appOrigin: origin, name: contact.name })
      : null;
  // For the web person's email: the contact form first, so it's the one the dialog offers.
  const liveForms = surfaces.liveForms ?? [];
  const contactFirst = contact
    ? [
        ...liveForms.filter((f) => f.formId === contact.formId),
        ...liveForms.filter((f) => f.formId !== contact.formId),
      ]
    : liveForms;

  // The page the form is on: the main page with the box, or the form's when both ways are used.
  const formPage =
    form.optInPath === 'own_site'
      ? form.optInUrl
      : (form.otherWays.find((w) => w.path === 'own_site')?.url ?? '');
  const setFormPage = (url: string) =>
    form.optInPath === 'own_site'
      ? set('optInUrl', url)
      : set(
          'otherWays',
          form.otherWays.map((w) => (w.path === 'own_site' ? { ...w, url } : w)),
        );
  // A business whose website is our own page shares the form's own page: nothing to paste, nothing to type.
  const fill = ownPage && usesForm && !formPage.trim() ? formUrl : null;
  useEffect(() => {
    if (fill) setFormPage(fill);
    // Only when there's a page to fill in: the setter is new on every render.
  }, [fill]);

  // ---- what's on their site now ----
  const [site, setSite] = useState<SiteLook | null>(null);
  const lookAt = !ownPage && siteOrigin ? website : null;
  const latestPage = useRef({ formPage, usesForm });
  useEffect(() => {
    latestPage.current = { formPage, usesForm };
  });
  const look = useCallback(
    async (again = false) => {
      if (!lookAt) return;
      const kept = again ? null : keptSiteLook(workspaceId, lookAt);
      if (kept) {
        setSite({ state: 'found', found: kept });
        return;
      }
      setSite({ state: 'looking' });
      try {
        setSite({ state: 'found', found: await siteLook(workspaceId, lookAt, again) });
      } catch {
        // The checks before it goes look again; this list is a help, not a gate.
        setSite({ state: 'failed' });
      }
    },
    [workspaceId, lookAt],
  );
  useEffect(() => {
    void look();
  }, [look]);
  const found = site?.state === 'found' && site.found.opened > 0 ? site.found : null;
  const others = found ? otherSiteForms(found.forms) : [];
  const mine = found?.forms.find((f) => f.ours) ?? null;
  // The business's form found on its site fills in the page it's on, when none was typed.
  const minePage = mine?.page ?? null;
  useEffect(() => {
    const now = latestPage.current;
    if (minePage && now.usesForm && !now.formPage.trim()) setFormPage(minePage);
  }, [minePage, usesForm]);
  const siteName = hostOf(siteOrigin);
  const formsWord = others.length === 1 ? 'form' : 'forms';

  async function turnOn() {
    setBusy(true);
    try {
      const { surfaces: next, failed } = await enableHostedOptIn(workspaceId, website, surfaces);
      onSurfaces((had) => ({
        ...had,
        chat: next.chat,
        chatPublicKey: next.chatPublicKey,
        siteSlug: next.siteSlug,
        bookingEnabled: next.bookingEnabled,
      }));
      if (failed.length)
        toast.error(`Could not set up ${failed.join(' or ')}. Try again in a moment.`);
      else
        toast.success(
          ownPage ? 'Your chat is ready' : 'Your chat is ready. Paste its code in your footer.',
        );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // In person is kept wherever an older answer says it; a pick changes the rest.
  const inPersonToo = form.otherWays.filter((w) => w.path === 'in_person');
  const pageForForm = () => formPage.trim() || (ownPage && formUrl ? formUrl : '');
  // A business with no chat yet gets one the moment it picks the chat. One it already has is changed only when asked.
  const startChat = () => {
    if (!surfaces.chat && website && !busy) void turnOn();
  };
  const pickChat = () => {
    onPick({ optInPath: 'hosted', otherWays: inPersonToo });
    startChat();
  };
  const pickForm = () =>
    onPick({ optInPath: 'own_site', optInUrl: pageForForm(), otherWays: inPersonToo });
  const pickBoth = () => {
    onPick({
      optInPath: 'hosted',
      otherWays: [{ path: 'own_site', url: pageForForm() }, ...inPersonToo],
    });
    startChat();
  };

  // The sentence as we'd write it now, which "Use our wording" puts back.
  const ourWording = describeFor(businessName, form, surfaces, origin);
  const boxWords = smsConsentWords(businessName, 'form');
  const best = (
    <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-on-accent">
      Best
    </span>
  );

  return (
    <div className="space-y-4">
      {lookAt && site ? (
        <div
          className="rounded-menu border border-border bg-card p-4"
          data-testid="optin-site-now"
          data-state={site.state}
        >
          <p className="text-[13.5px] font-semibold">What’s on your site now</p>
          {site.state === 'looking' ? (
            <p className="mt-1.5 flex items-center gap-2 text-[13px] text-text-2" role="status">
              <Loader2 className="h-4 w-4 flex-none animate-spin" aria-hidden />
              Looking through {siteName} for forms. This takes up to 20 seconds.
            </p>
          ) : found ? (
            <>
              <p className="mt-1.5 text-[13px] text-text-2">
                {siteFormsSummary(found, siteName)}
                {mine ? ` Your contact form is on ${shortAddress(mine.page)}.` : ''}
              </p>
              {others.length ? (
                <>
                  <ul className="mt-3 divide-y divide-border rounded-menu border border-border">
                    {others.map((f, i) => (
                      <li
                        key={`${f.page} ${f.framedUrl ?? ''}`}
                        className="flex items-center gap-3 px-3 py-2"
                        data-testid={`optin-site-form-${i}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium">
                            {shortAddress(f.page)}
                            {f.alsoOn
                              ? ` and ${f.alsoOn} more ${f.alsoOn === 1 ? 'page' : 'pages'}`
                              : ''}
                          </p>
                          <p className="truncate text-[12.5px] text-text-3">
                            {f.framedUrl
                              ? `A form from ${hostOf(f.framedUrl)}`
                              : f.asksPhone
                                ? 'Asks for a phone number'
                                : 'Asks to send texts'}
                          </p>
                        </div>
                        {way === 'chat' || usesForm ? (
                          <span className="flex-none rounded-full bg-warning-soft px-2 py-0.5 text-[11.5px] font-semibold text-warning-text">
                            {way === 'chat' ? 'Take off' : 'Swap for ours'}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2.5 text-[13px] text-text-3">
                    The carriers turn down a business when its site has a form that asks for a phone
                    number and the registration doesn’t name it. Your pick below says what happens
                    to {others.length === 1 ? 'this one' : 'these'}.
                  </p>
                </>
              ) : null}
            </>
          ) : (
            <p className="mt-1.5 text-[13px] text-text-2">
              We couldn’t open {siteName} just now, so we can’t show its forms here. We look again
              before this goes to the carriers.
            </p>
          )}
        </div>
      ) : null}

      <div role="radiogroup" aria-label="How customers agree to get texts" className="space-y-2.5">
        <RadioCard
          selected={usesChat}
          onSelect={pickChat}
          testId="optin-hosted"
          title={
            <span className="flex items-center gap-2">
              {others.length ? 'Use the chat, and take the forms off my site' : 'Use the chat'}
              {best}
            </span>
          }
          description={
            'One line of code in your footer adds a chat to every page. After a visitor’s first message it asks for their name, mobile and email, with the box to agree to texts.' +
            (others.length ? ' Your old forms come off.' : '')
          }
        />
        <RadioCard
          selected={usesForm}
          onSelect={pickForm}
          testId="optin-own_site"
          title="Use the contact form we made for you"
          description={
            'It’s already in your account, with the box to agree to texts worded the way the carriers want. ' +
            (ownPage
              ? 'Customers fill it in on its own page.'
              : others.length
                ? 'It goes on your contact page in place of the forms you have.'
                : 'It goes on your contact page.')
          }
        />
        {way === 'in_person' ? (
          <RadioCard
            selected
            onSelect={() => undefined}
            testId="optin-in_person"
            title={IN_PERSON_CHOICE.title}
            description={IN_PERSON_CHOICE.description}
          />
        ) : null}
      </div>
      <p className="text-[13px] text-text-2">
        {way === 'both' ? (
          'You’re using both: the chat and your contact form. Pick one above to use just that one.'
        ) : (
          <>
            Something else?{' '}
            <button
              type="button"
              className="font-semibold underline underline-offset-2"
              onClick={pickBoth}
              data-testid="optin-both"
            >
              Use both
            </button>
          </>
        )}
      </p>

      <Issues issues={issuesFor(issues, 'optInPath')} />

      {usesChat ? (
        <div
          className="rounded-menu border border-border bg-card-2 p-4"
          data-testid="optin-hosted-setup"
        >
          <p className="flex items-center gap-2 text-[13.5px] font-semibold">
            <MessageCircle className="h-4 w-4 flex-none" aria-hidden />
            Your website chat
            {ready ? (
              <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11.5px] font-semibold text-success-text">
                Ready
              </span>
            ) : null}
          </p>
          {offers ? (
            <p className="mt-2 text-[13px] text-text-2">
              You send offers too, so the chat shows a second, separate box for them. Customers can
              agree to texts about their own work without agreeing to offers.
            </p>
          ) : null}
          {ready && ownPage ? (
            <Callout tone="info" icon={Check} className="mt-3">
              Your page at {hostOf(siteOrigin)} shows the chat already, so there&rsquo;s nothing to
              paste.
            </Callout>
          ) : ready && src ? (
            <ol className="mt-3 space-y-4" data-testid="optin-chat-code">
              <Todo n={1} title="Paste this in your website’s footer">
                <div className="mt-1.5 flex justify-end">
                  <CopyButton text={snippetOf(src)} label="Copy the code" />
                </div>
                <SnippetCode src={src} className="mt-1.5" />
                <p className="mt-1.5 text-[13px] text-text-3">
                  Once, just before &lt;/body&gt;, so it&rsquo;s on every page. Most site builders
                  have a footer code box for it.
                </p>
                <PlatformSteps className="mt-3" />
              </Todo>
              {others.length ? (
                <Todo n={2} title={`Take the ${others.length} ${formsWord} off your site`}>
                  <p className="mt-1 text-[13px] text-text-3">
                    The chat is how people reach you now.
                  </p>
                </Todo>
              ) : null}
              <Todo n={others.length ? 3 : 2} title="Press the chat button once">
                <p className="mt-1 text-[13px] text-text-3">
                  Open your site and press it. That tells us it&rsquo;s on.
                </p>
                <InstallCheck workspaceId={workspaceId} widget={surfaces.chat} className="mt-2" />
                <p className="mt-2 text-[13px] text-text-3">
                  We check it&rsquo;s on {hostOf(siteOrigin)} before this goes to the carriers. A
                  reviewer who opens your site and finds no chat turns the registration down.
                </p>
              </Todo>
            </ol>
          ) : (
            <>
              <p className="mt-2 text-[13px] text-text-2">
                {surfaces.chat
                  ? `Your website chat is already on. This turns on its box to agree to texts, has it ask for details after the first message${
                      chatAllows(surfaces.chat, website)
                        ? ''
                        : `, and adds ${hostOf(siteOrigin)} to its sites`
                    }.`
                  : 'A chat for your website. After a visitor’s first message, it asks for their name, mobile and email, with the box to agree to texts and links to your privacy policy and terms.'}
              </p>
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
            </>
          )}
          {!form.website ? (
            <p className="mt-2 text-[13px] text-text-2">
              Go back to &ldquo;Where to find you&rdquo; and add your website first. The chat goes
              on it.
            </p>
          ) : null}
          {ready ? (
            <p className="mt-3 text-[13px] text-text-3">
              <Globe className="mr-1 inline h-4 w-4 align-[-3px]" aria-hidden />
              The box starts empty and isn&rsquo;t required. The carriers&rsquo; reviewer, who
              rarely starts a chat to find the box, gets a page that shows what the chat asks.
              {urls.chatUrl ? (
                <a
                  className="ml-1 underline"
                  href={urls.chatUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="optin-chat-page"
                >
                  {urls.chatUrl}
                </a>
              ) : null}
            </p>
          ) : null}
          {ready && !ownPage && !usesForm ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <WebPersonButton
                workspaceId={workspaceId}
                website={website || null}
                forms={surfaces.liveForms ?? []}
                chats={surfaces.chats ?? []}
                path="hosted"
                label="Send this to my web person"
              />
              <p className="min-w-0 flex-1 text-[13px] text-text-3">
                Someone else looks after your site? Send them the code and the steps.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {usesForm ? (
        <div
          className="rounded-menu border border-border bg-card-2 p-4"
          data-testid="optin-form-panel"
        >
          <p className="flex items-center gap-2 text-[13.5px] font-semibold">
            <ClipboardList className="h-4 w-4 flex-none" aria-hidden />
            Your contact form
            {contact ? (
              <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11.5px] font-semibold text-success-text">
                Ready
              </span>
            ) : null}
          </p>
          {!contact ? (
            formFailed ? (
              <Callout
                tone="warning"
                icon={CircleAlert}
                className="mt-3"
                action={
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void getForm()}
                    loading={formBusy}
                    data-testid="optin-form-retry"
                  >
                    Try again
                  </Button>
                }
              >
                {formFailed}
              </Callout>
            ) : (
              <p className="mt-2 flex items-center gap-2 text-[13px] text-text-2" role="status">
                <Loader2 className="h-4 w-4 flex-none animate-spin" aria-hidden />
                Getting your contact form ready.
              </p>
            )
          ) : (
            <>
              <div className="mt-3 rounded-menu border border-border bg-card p-3">
                <p className="text-[13.5px] font-semibold">{contact.name}</p>
                <p className="mt-2 flex items-start gap-2 text-[13px] text-text-2">
                  <span
                    aria-hidden
                    className="mt-0.5 h-4 w-4 flex-none rounded-[4px] border border-border bg-card"
                  />
                  <span>
                    <strong className="font-semibold text-text">{boxWords.title}.</strong>{' '}
                    {boxWords.detail}
                  </span>
                </p>
              </div>
              <p className="mt-2 text-[13px] text-text-3">
                {contact.created ? 'We just made it for you.' : 'It’s already in your account.'} The
                box starts empty and isn&rsquo;t required.{' '}
                {formUrl ? (
                  <>
                    <a
                      className="underline"
                      href={formUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="optin-form-link"
                    >
                      See it
                    </a>
                    {' · '}
                  </>
                ) : null}
                <a
                  className="underline"
                  href={`/app/w/${workspaceId}/forms/${contact.formId}`}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="optin-form-edit"
                >
                  Change the questions
                </a>
              </p>
              {offers ? (
                <p className="mt-2 text-[13px] text-text-2">
                  You send offers too, so the form shows a second, separate box for them, under the
                  first.
                </p>
              ) : null}
              {ownPage ? (
                <Callout tone="info" icon={Check} className="mt-3">
                  Customers fill it in on its own page, so there&rsquo;s nothing to paste. That page
                  is the one we give the carriers.
                </Callout>
              ) : (
                <>
                  <p className="mt-4 border-t border-border pt-4 text-[13.5px] font-semibold">
                    What to do
                  </p>
                  <ol className="mt-3 space-y-4">
                    <Todo n={1} title="Put it on your contact page">
                      {formCode ? (
                        <>
                          <div className="mt-1.5 flex justify-end">
                            <CopyButton text={formCode} label="Copy the code" />
                          </div>
                          <pre
                            className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-menu bg-card p-3 font-mono text-[12px] leading-relaxed text-text-2"
                            data-testid="optin-form-code"
                          >
                            {formCode}
                          </pre>
                        </>
                      ) : null}
                      <p className="mt-1.5 text-[13px] text-text-3">
                        Paste it where the form should show. Most site builders have a block for
                        code, called Embed or HTML.
                      </p>
                    </Todo>
                    {others.length ? (
                      <Todo n={2} title={`Take the ${others.length} old ${formsWord} off`}>
                        <p className="mt-1 text-[13px] text-text-3">
                          Yours takes {others.length === 1 ? 'its' : 'their'} place, so every form
                          on your site asks the way the carriers want.
                        </p>
                      </Todo>
                    ) : null}
                    <Todo n={others.length ? 3 : 2} title="Tell us the page it’s on">
                      <Field label="The page with the form" htmlFor="a2p-optInUrl" className="mt-2">
                        <Input
                          id="a2p-optInUrl"
                          value={formPage}
                          onChange={(e) => setFormPage(e.target.value)}
                          placeholder="yoursite.com/contact"
                          data-testid="a2p-optin-url"
                        />
                      </Field>
                      <p className="mt-1.5 text-[13px] text-text-3">
                        The reviewer opens this exact page to find the box.
                      </p>
                      <Issues
                        issues={issuesFor(
                          issues,
                          form.optInPath === 'own_site' ? 'optInUrl' : 'otherWays',
                        )}
                      />
                    </Todo>
                  </ol>
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                    <WebPersonButton
                      workspaceId={workspaceId}
                      website={website || null}
                      forms={contactFirst}
                      chats={surfaces.chats ?? []}
                      path={way === 'both' ? null : 'own_site'}
                      suggested={way === 'both' ? BOTH_WAYS_FIXES : undefined}
                      label="Send this to my web person"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void look(true)}
                      loading={site?.state === 'looking'}
                      data-testid="optin-form-check"
                    >
                      Check my site
                    </Button>
                  </div>
                  <p className="mt-2 text-[13px] text-text-2" data-testid="optin-form-status">
                    {site?.state === 'looking'
                      ? `Looking through ${siteName}.`
                      : mine
                        ? `Your contact form is on ${shortAddress(mine.page)}${
                            mine.alsoOn
                              ? ` and ${mine.alsoOn} more ${mine.alsoOn === 1 ? 'page' : 'pages'}`
                              : ''
                          }.`
                        : found
                          ? `Not on ${formPage.trim() ? shortAddress(formPage) : siteName} yet. We check again before it goes.`
                          : `We couldn’t open ${siteName} just now. We check again before it goes.`}
                  </p>
                </>
              )}
            </>
          )}
          {way === 'form' ? (
            <HideChatSwitch
              workspaceId={workspaceId}
              chats={surfaces.chats ?? []}
              className="mt-4 border-t border-border pt-3"
            />
          ) : null}
        </div>
      ) : null}

      {way === 'in_person' ? (
        <div className="space-y-3 rounded-menu border border-border bg-card-2 p-4">
          <Callout tone="warning" icon={CircleAlert}>
            This can be approved, but there is no web page for the reviewer to check, so expect
            questions and a longer wait. The chat or your contact form, above, is much faster.
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
          <HideChatSwitch
            workspaceId={workspaceId}
            chats={surfaces.chats ?? []}
            className="border-t border-border pt-3"
          />
        </div>
      ) : null}

      {way === 'in_person' ? (
        <OtherWays
          main="in_person"
          ways={form.otherWays}
          chatUrl={urls.chatUrl}
          onChange={(next) => set('otherWays', next)}
          issues={issuesFor(issues, 'otherWays')}
        />
      ) : inPersonToo.length ? (
        // An older answer that customers agree in person too: kept and shown, with its proof, until it's taken out.
        <OtherWays
          main={form.optInPath || 'hosted'}
          ways={inPersonToo}
          chatUrl={urls.chatUrl}
          onChange={(next) =>
            set('otherWays', [...form.otherWays.filter((w) => w.path !== 'in_person'), ...next])
          }
          issues={usesForm && form.optInPath !== 'own_site' ? [] : issuesFor(issues, 'otherWays')}
          fixed
        />
      ) : null}

      {form.optInPath ? (
        <Field label="What we will tell the carriers" htmlFor="optin-description">
          <Textarea
            id="optin-description"
            value={form.optIn}
            onChange={(e) => set('optIn', e.target.value)}
            rows={14}
          />
          <div className="mt-1.5 flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-[13px] text-text-3">
              Written from your answers above. Edit it if it does not describe how you really do it
              — but everything it claims has to be true, because it is checked.
            </p>
            {!sameDescription(form.optIn, ourWording) ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => set('optIn', ourWording)}
                data-testid="optin-use-our-wording"
              >
                Use our wording
              </Button>
            ) : null}
          </div>
          <Issues issues={issuesFor(issues, 'optInDescription')} />
        </Field>
      ) : null}
    </div>
  );
}

/** What each way customers agree is called here, and what its link is. */
const WAY_CHOICES: readonly {
  value: OptInPath;
  title: string;
  link: string;
  placeholder: string;
}[] = [
  {
    value: 'hosted',
    title: 'The chat on your website',
    link: 'Its sign-up page',
    placeholder: 'https://app.handsfreeos.com/chat/…',
  },
  {
    value: 'own_site',
    title: 'A form on your own website',
    link: 'The page with the tick box',
    placeholder: 'yoursite.com/contact',
  },
  {
    value: 'in_person',
    title: 'In person or on the phone',
    link: 'A link to what customers see or hear',
    placeholder: 'https://drive.google.com/…',
  },
];

/**
 * "Any other ways customers agree?" A reviewer who finds a way the registration didn't mention turns it down (Twilio
 * 30896: "if you support more than one opt-in path, list every method along with proofs"), so each other way is named
 * with its proof, said in the description, and opened by the last step's checks.
 */
function OtherWays({
  main,
  ways,
  chatUrl,
  onChange,
  issues,
  fixed = false,
}: {
  main: OptInPath;
  ways: readonly OtherWayAnswer[];
  /** The chat's sign-up page, once the chat is ready: filled in for "The chat on your website". */
  chatUrl: string | null;
  onChange: (next: OtherWayAnswer[]) => void;
  issues: readonly A2pIssue[];
  /** Ways an older answer already has, shown so they can be fixed or taken out: none is added, none changes kind. */
  fixed?: boolean;
}) {
  const free = WAY_CHOICES.filter((c) => c.value !== main && !ways.some((w) => w.path === c.value));
  const update = (i: number, patch: Partial<OtherWayAnswer>) =>
    onChange(ways.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <div className="rounded-menu border border-border bg-card p-4" data-testid="optin-other-ways">
      <p className="text-[13.5px] font-semibold">Any other ways customers agree?</p>
      <p className="mt-1 text-[13px] text-text-2">
        Add each other way customers say yes to your texts, with where a reviewer can see it. The
        carriers turn a registration down when they find a way it didn&rsquo;t list.
      </p>
      {ways.map((way, i) => {
        const choice = WAY_CHOICES.find((c) => c.value === way.path)!;
        return (
          <div key={i} className="mt-3 space-y-2 border-t border-border pt-3">
            <div className="flex items-end gap-2">
              <Field label="How" htmlFor={`a2p-other-${i}-path`} className="min-w-0 flex-1">
                <Select
                  id={`a2p-other-${i}-path`}
                  value={way.path}
                  disabled={fixed}
                  onChange={(e) =>
                    update(i, {
                      path: e.target.value as OptInPath,
                      url: e.target.value === 'hosted' && chatUrl ? chatUrl : way.url,
                    })
                  }
                >
                  {WAY_CHOICES.filter(
                    (c) =>
                      c.value === way.path ||
                      (c.value !== main && !ways.some((w) => w.path === c.value)),
                  ).map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onChange(ways.filter((_, j) => j !== i))}
                data-testid={`optin-other-${i}-remove`}
              >
                Remove
              </Button>
            </div>
            <Field label={choice.link} htmlFor={`a2p-other-${i}-url`}>
              <Input
                id={`a2p-other-${i}-url`}
                value={way.url}
                onChange={(e) => update(i, { url: e.target.value })}
                placeholder={choice.placeholder}
                data-testid={`optin-other-${i}-url`}
              />
            </Field>
          </div>
        );
      })}
      <Issues issues={issues} />
      {!fixed && free.length && ways.length < 3 ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() =>
            onChange([
              ...ways,
              { path: free[0]!.value, url: free[0]!.value === 'hosted' && chatUrl ? chatUrl : '' },
            ])
          }
          data-testid="optin-other-add"
        >
          Add another way
        </Button>
      ) : null}
    </div>
  );
}

// ---------- the wizard ----------

/** What the page around the wizard can ask of it. */
export interface A2pWizardHandle {
  /** Saves any answer the wizard hasn't saved yet, and comes back when it's kept. */
  flush: () => Promise<void>;
}

export function A2pWizard({
  workspaceId,
  businessName,
  businessWebsite = null,
  businessAddress = null,
  number,
  me,
  initial,
  draft = null,
  surfaces: initialSurfaces = EMPTY_SURFACES,
  feesPaidFor = null,
  industry = null,
  guided = null,
  handle,
  onBack,
  onSubmitted,
}: {
  workspaceId: string;
  /** For the page around it: `flush` saves what hasn't been saved yet, before the page goes somewhere else. */
  handle?: Ref<A2pWizardHandle>;
  businessName: string;
  /** The kind of business, which the example texts are worded for. */
  industry?: string | null;
  /**
   * On its own guided page (`/onboarding/<business>/texting`): the question sits in the guided setup's card, with the
   * four parts listed beside it and a start screen before the first question. `onSaved` tells the page's Saved mark.
   * Left out, it's the plain wizard inside another page (sign-up's number step).
   */
  guided?: { readonly onSaved: (state: SavedState) => void; readonly onLater: () => void } | null;
  /** The website the business already gave, which a first registration starts from. */
  businessWebsite?: string | null;
  /** The address setup asked for, which a first registration starts from too. */
  businessAddress?: BusinessAddress | null;
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
  /**
   * What the business already sent or paid for (`textingFees.paidFor`), so the last step shows what sending a
   * local registration costs before anything is sent (0105). Left out, no price is shown.
   */
  feesPaidFor?: TextingFeesPaidFor | null;
  onBack?: () => void;
  /** Sent. `fee` is what it costs when anything: it goes to the carriers once that is paid. */
  onSubmitted: (fee: { id: string; amountCents: number } | null) => void;
}) {
  const [form, setForm] = useState<WizardForm>(() =>
    withDraft(wizardFormFrom(initial, businessName, me, businessWebsite, businessAddress), draft),
  );
  const [surfaces, setSurfaces] = useState<HostedSurfaces>(initialSurfaces);
  const [at, setAt] = useState(() => {
    const step = typeof draft?.['at'] === 'number' ? Math.floor(draft['at']) : 0;
    return Math.min(Math.max(step, 0), STEPS.length - 1);
  });
  // The guided page opens on what's about to happen, the first time; with answers already, on the question left.
  const [started, setStarted] = useState(!guided || !!draft || !!initial);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  // The business says these details are true before they go to a carrier. Kept from the old form: it is
  // the record that somebody asserted it, which is what a carrier audit asks for.
  const [agreed, setAgreed] = useState(false);
  // What a reviewer would find. Run when the review step opens rather than on every keystroke: each one is
  // four requests to somebody else's website, and the answers only change when an answer above them does.
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  /**
   * What the worker found standing between these exact details and all green (the form's own check and every look
   * above), or null before it has looked. Send works only when it's empty and every tick is ticked: the owner's rule
   * (2026-11-05), held by `registration.submit` too.
   */
  const [found, setFound] = useState<string[] | null>(null);
  /** The fixed addresses our reads come from, for letting HandsFreeOS in at the host (empty until set up). */
  const [readerIps, setReaderIps] = useState<string[]>([]);
  // The business's latest ask for HandsFreeOS to check it, and the note it's writing for the next one.
  const [review, setReview] = useState<ReviewInfo | null>(null);
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const loadReview = useCallback(async () => {
    try {
      const got = unwrap(
        await apiBrowser().POST('/v1/queries/registration.review.get', { body: { workspaceId } }),
      );
      setReview(got.review);
    } catch {
      // The wizard works without it; the ticket's emails still reach the business.
    }
  }, [workspaceId]);
  useEffect(() => {
    void loadReview();
  }, [loadReview]);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  /**
   * Changes what's public (the chat set up, the contact form made). The sentence for the carrier names those pages,
   * so it follows them too, until the business edits the sentence itself.
   */
  const surfacesNow = useRef(surfaces);
  const changeSurfaces = useCallback(
    (change: (had: HostedSurfaces) => HostedSurfaces) => {
      const had = surfacesNow.current;
      const next = change(had);
      surfacesNow.current = next;
      setSurfaces(next);
      setForm((f) =>
        f.optInPath && sameDescription(f.optIn, describeFor(businessName, f, had, origin))
          ? { ...f, optIn: describeFor(businessName, f, next, origin) }
          : f,
      );
    },
    [businessName, origin],
  );

  /** Picking how customers agree: its way, its page and the other ways change together, and the sentence is written. */
  const pick = (changes: Partial<WizardForm>) =>
    setForm((f) => {
      const next = { ...f, ...changes };
      if (next.optInPath) next.optIn = describeFor(businessName, next, surfacesNow.current, origin);
      return next;
    });

  // Every business has a contact form customers can agree to texts on. It's made when the business signs up, and here
  // when it's missing (the owner, 2026-11-22: "if it's not there it should be created when they start the a2p
  // process"). The question that offers it asks again, and says so if it couldn't be made.
  const formAsked = useRef(false);
  useEffect(() => {
    if (!started || formAsked.current) return;
    formAsked.current = true;
    ensureContactForm(workspaceId, '').then(
      (got) => changeSurfaces((had) => withContactForm(had, got)),
      () => undefined,
    );
  }, [started, workspaceId, changeSurfaces]);

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
        sameDescription(f.optIn, describeFor(businessName, f, surfaces, origin))
      )
        next.optIn = describeFor(businessName, next, surfaces, origin);
      return next;
    });

  /** Several answers at once (the policy question picking the pages found on the business's site). */
  const patch = (changes: Partial<WizardForm>) =>
    setForm((f) => {
      const next = { ...f, ...changes };
      if (f.optInPath && sameDescription(f.optIn, describeFor(businessName, f, surfaces, origin)))
        next.optIn = describeFor(businessName, next, surfaces, origin);
      return next;
    });

  // A sentence saved before it had paragraphs is still ours: put the paragraphs in, without counting it as an edit.
  useEffect(() => {
    setForm((f) => {
      if (!f.optInPath) return f;
      const ours = describeFor(businessName, f, surfaces, origin);
      return f.optIn !== ours && sameDescription(f.optIn, ours) ? { ...f, optIn: ours } : f;
    });
  }, [businessName, surfaces, origin]);

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
  // Leaving inside that moment (Finish later straight after typing) still keeps the last answer: the page around the
  // wizard asks for what hasn't been saved yet to be saved before it goes, and so does the wizard going away.
  const latest = useRef({ form, at });
  useEffect(() => {
    latest.current = { form, at };
  }, [form, at]);
  const flush = useCallback(async () => {
    await saving.current;
    const answers = latest.current;
    const json = JSON.stringify(answers);
    if (sent.current || json === lastSaved.current) return;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/registration.save_draft', {
          body: { workspaceId, answers },
        }),
      );
      lastSaved.current = json;
      setSaveState('saved');
    } catch {
      setSaveState('failed');
    }
  }, [workspaceId]);
  useImperativeHandle(handle, () => ({ flush }), [flush]);
  useEffect(
    () => () => {
      if (sent.current || JSON.stringify(latest.current) === lastSaved.current) return;
      void apiBrowser()
        .POST('/v1/commands/registration.save_draft', {
          body: { workspaceId, answers: latest.current },
        })
        .catch(() => undefined);
    },
    [workspaceId],
  );

  const onSaved = guided?.onSaved;
  useEffect(() => {
    onSaved?.(saveState === 'failed' ? 'error' : saveState);
  }, [onSaved, saveState]);

  const local = !number || number.numberType === 'local';
  // What sending it costs: the carriers' fees, from what is already sent or paid for and the volume picked.
  const feeLines =
    local && feesPaidFor
      ? textingFeeLines({ ...feesPaidFor, monthlyVolume: form.volume || 'under_1000' })
      : [];
  const feeTotal = textingFeeTotal(feeLines);
  const surfaceUrls = urlsOf(surfaces, origin, withScheme(form.website));
  /**
   * The page we are about to tell the carrier the agreement box is on: for the chat, the page showing what it asks
   * (the review also checks the chat is on the website itself).
   */
  const optInUrl =
    form.optInPath === 'hosted'
      ? surfaceUrls.chatUrl
      : form.optInPath === 'own_site'
        ? withScheme(form.optInUrl) || null
        : null;
  const proofUrl = withScheme(form.optInProofUrl) || null;
  /** Theirs when they gave us one, ours when we are hosting it, and nothing before a site exists. */
  const { policyUrl, termsUrl } = legalPagesOf(form, surfaces, origin);
  const otherWays = otherWaysOf(form);

  // What the checks read: the answers, and the addresses the reviewer is given, which the description has to name.
  const issues = useMemo(
    () =>
      checkDraft(
        {
          ...draftOf(form),
          privacyPageUrl: policyUrl,
          termsPageUrl: termsUrl,
          optInPageUrl: form.optInPath === 'in_person' ? proofUrl : optInUrl,
          otherWays: otherWaysOf(form),
          displayName: businessName,
        },
        businessName,
      ),
    [form, businessName, policyUrl, termsUrl, optInUrl, proofUrl],
  );
  const step = STEPS[at]!;

  /** Blockers on the fields this step owns — what stops it advancing. */
  const stepBlockers = step.fields.flatMap((field) =>
    issuesFor(issues, field).filter((i) => i.severity === 'blocker'),
  );

  /** The ticks only the business can give: from the ways customers agree, and from the questions above. */
  const confirmations = confirmationsFor({
    optInPath: form.optInPath,
    optInUrl,
    otherWays,
    issues,
    legalName: form.legalName,
  });

  const kind = local ? ('a2p_10dlc' as const) : ('toll_free_verification' as const);
  /** The registration exactly as Send sends it: what the checks write down, and what a check by HandsFreeOS sees. */
  const business = {
    legalName: form.legalName,
    businessType: form.businessType as 'llc',
    ein: form.businessType === 'sole_proprietor' ? null : form.ein || null,
    website: withScheme(form.website),
    address: {
      line1: form.line1,
      city: form.city,
      state: form.state,
      postalCode: form.postalCode,
      country: 'US' as const,
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
    policyContact: {
      ...(form.policyEmail.trim() ? { email: form.policyEmail.trim() } : {}),
      ...(form.policyPhone.trim() ? { phone: form.policyPhone.trim() } : {}),
    },
    privacyPageUrl: policyUrl,
    termsPageUrl: termsUrl,
    displayName: businessName,
    sensitiveTopics: (form.sensitive ?? []) as SensitiveTopicId[],
    monthlyVolume: form.volume as 'under_1000',
    ...(otherWays.length ? { otherWays } : {}),
    confirmed: form.confirmed as ConfirmationId[],
  };
  // The details the checks look at, without the ticks: ticking one doesn't open four websites again.
  const { confirmed: _ticks, ...checked } = business;
  const checkedKey = JSON.stringify({ kind, checked });

  // What our policy and terms are written from, so the review checks them as they'll read once sent. Kept while
  // none of it changes, so the check runs again only when it does.
  const hostedKey = JSON.stringify(policyDetailsOf(form));
  const hostedFrom = useMemo(
    () => JSON.parse(hostedKey) as ReturnType<typeof policyDetailsOf>,
    [hostedKey],
  );

  const runPreflight = useCallback(async () => {
    if (!form.optInPath) return;
    setChecking(true);
    try {
      const sending = JSON.parse(checkedKey) as {
        kind: typeof kind;
        checked: Record<string, unknown>;
      };
      const got = await registrationPreflight({
        workspaceId,
        website: withScheme(form.website),
        policyUrl,
        termsUrl,
        optInPath: form.optInPath,
        optInUrl,
        optInProofUrl: proofUrl,
        names: [businessName, form.legalName].filter((n) => n.trim()),
        legalName: form.legalName.trim() || undefined,
        policyBusiness: hostedFrom,
        otherWays: (sending.checked['otherWays'] as OtherWayAnswer[] | undefined) ?? [],
        useCase: sending.checked['useCase'] as 'customer_care' | 'mixed' | 'marketing',
        submission: { kind: sending.kind, business: sending.checked },
      });
      setChecks(got.checks);
      setFound(got.notGreen);
      setReaderIps(got.readerIps ?? []);
    } catch (err) {
      toast.error(errorMessage(err));
      setChecks(null);
      setFound(null);
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
    hostedFrom,
    checkedKey,
  ]);

  // Opening the review runs them; going back and changing something throws the old answers away, so a
  // business never submits on the strength of a check of a website it has since corrected.
  useEffect(() => {
    if (step.key === 'review') void runPreflight();
    else {
      setChecks(null);
      setFound(null);
    }
  }, [step.key, runPreflight]);

  async function submit() {
    setBusy(true);
    setServerErrors([]);
    try {
      // A save still on its way lands first, so the send's clearing of the draft is the last word.
      await saving.current;
      const done = unwrap(
        await apiBrowser().POST('/v1/commands/registration.submit', {
          body: { workspaceId, kind, business },
        }),
      );
      sent.current = true;
      toast.success(
        done.fee ? 'Saved. Pay the carriers’ fees to send it.' : 'Sent to the carriers',
      );
      onSubmitted(done.fee);
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

  /** Everything that isn't green, as the business sees it and as the ticket lists it. */
  const left =
    found === null
      ? null
      : [
          ...found,
          ...notGreenList({ issues: [], checks: [], confirmations, confirmed: form.confirmed }),
        ];
  const allGreen = left !== null && left.length === 0;

  /** "Ask HandsFreeOS to check it": a ticket to our support desk with what isn't green; staff approve or send back. */
  async function askReview() {
    setAsking(true);
    setServerErrors([]);
    try {
      await saving.current;
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/registration.request_review', {
          body: {
            workspaceId,
            kind,
            business,
            notGreen: (
              left ?? ['The checks of your website, policy, terms and sign-up page haven’t run.']
            ).slice(0, 60),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      );
      setNote('');
      toast.success(
        `Sent to HandsFreeOS as ticket #${out.ticketNumber}. We’ll email you once we’ve checked it.`,
      );
      await loadReview();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation' && Array.isArray(err.details)) {
        const details = err.details as { path?: string; message?: string }[];
        setServerErrors(details.map((d) => d.message ?? 'Check this.'));
        toast.error('A few details need a look.');
      } else toast.error(errorMessage(err));
    } finally {
      setAsking(false);
    }
  }

  // The name customers know, when it isn't the legal one: the carriers are told both.
  const dba = tradingName(form.legalName, businessName);

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

  const body = (
    <>
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
          {dba ? (
            <DbaCallout legalName={form.legalName.trim()} dba={dba} />
          ) : (
            <Why label="Do customers know you by another name?">
              <p>
                That&rsquo;s a DBA (&ldquo;doing business as&rdquo;), and it&rsquo;s fine. Put the
                legal name from your IRS letter here anyway, with LLC or Inc.
              </p>
              <p>
                The name customers know is this workspace&rsquo;s name, &ldquo;{businessName}
                &rdquo;, which you can change in Settings &rarr; Workspace. When the two are
                different, we tell the carriers both and show you what else they check.
              </p>
            </Why>
          )}
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
              <SampleMarks sample={sample} businessName={businessName} />
            </Field>
          ))}
          <SamplePicker
            businessName={businessName}
            useCase={form.useCase}
            industry={industry}
            samples={form.samples}
            onUse={(next) => set('samples', next)}
          />
          <Issues issues={issuesFor(issues, 'messageSamples')} />
        </div>
      ) : null}

      {step.key === 'optin' ? (
        <OptInStep
          workspaceId={workspaceId}
          businessName={businessName}
          form={form}
          set={set}
          onPick={pick}
          surfaces={surfaces}
          onSurfaces={changeSurfaces}
          origin={origin}
          issues={issues}
        />
      ) : null}

      {step.key === 'policy' ? (
        <PolicyStep
          workspaceId={workspaceId}
          businessName={businessName}
          form={form}
          set={set}
          patch={patch}
          origin={origin}
          pagesOrigin={surfaces.snippetOrigin ?? null}
          siteSlug={surfaces.siteSlug}
          phone={number?.display}
          issues={issues}
        />
      ) : null}

      {step.key === 'review' ? (
        <ReviewStep
          form={form}
          businessName={businessName}
          issues={issues}
          serverErrors={serverErrors}
          checks={checks}
          checking={checking}
          onRecheck={() => void runPreflight()}
          readerIps={readerIps}
          siteCheck={{
            // Our chat or form code reads the site: the page with our form on it, or the website the chat is on.
            start: form.optInPath === 'own_site' ? optInUrl : null,
            urls: [
              withScheme(form.website),
              policyUrl,
              termsUrl,
              form.optInPath === 'in_person' ? proofUrl : optInUrl,
              ...otherWays.map((w) => w.url),
            ].filter((u): u is string => !!u),
          }}
          left={left}
          confirmations={confirmations}
          confirmed={form.confirmed}
          onConfirm={(id, on) =>
            set(
              'confirmed',
              on
                ? [...form.confirmed.filter((c) => c !== id), id]
                : form.confirmed.filter((c) => c !== id),
            )
          }
          agreed={agreed}
          onAgreed={setAgreed}
          onJump={(key) => setAt(STEPS.findIndex((s) => s.key === key))}
          workspaceId={workspaceId}
          surfaces={surfaces}
        />
      ) : null}

      {step.key === 'review' && local && feesPaidFor?.ours ? (
        <p className="mt-5 text-[13px] text-text-2" data-testid="registration-fees-ours">
          HandsFreeOS’s own business isn’t charged the carriers’ fees, so this goes to them as soon
          as you send it.
        </p>
      ) : null}

      {step.key === 'review' && feeTotal > 0 ? (
        <div className="mt-5 flex flex-col gap-1.5" data-testid="registration-fees">
          <span className="text-[13px] font-medium">What the carriers charge</span>
          <div className="overflow-hidden rounded-[10px] border border-border">
            <ul className="divide-y divide-border">
              {feeLines.map((l) => (
                <li key={l.key} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{l.name}</span>
                    <span className="block text-xs text-text-3">{l.detail}</span>
                  </span>
                  <span className="whitespace-nowrap text-[13px] font-medium">
                    {money(l.cents)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex justify-between gap-3 bg-card-2 px-3 py-2.5 text-[13px] font-semibold">
              <span>Now</span>
              <span data-testid="registration-fees-total">{money(feeTotal)}</span>
            </div>
          </div>
          <p className="text-xs text-text-3">
            Passed on at cost from The Campaign Registry and the carriers, with nothing added. Once
            they approve it, the campaign is {money(TEXTING_CAMPAIGN_MONTH_CENTS)} a month, charged
            to the same card.
          </p>
        </div>
      ) : null}

      {step.key === 'review' && left !== null && !allGreen ? (
        <div
          className="mt-5 rounded-menu border border-border bg-card-2 p-4"
          data-testid="registration-ask-review"
        >
          <p className="text-[13.5px] font-semibold">Not all green? HandsFreeOS can check it</p>
          <p className="mt-1 text-[13px] leading-relaxed text-text-2">
            Registrations go to the carriers only when every row above is green, because the
            carriers turn down anything less and the wait starts again. If you think a row is wrong,
            or you can&rsquo;t fix it yet, ask us. We&rsquo;ll look at it by hand, then send it
            exactly as it is or tell you what to change.
          </p>
          <Field
            label="Anything we should know (optional)"
            htmlFor="a2p-review-note"
            className="mt-3"
          >
            <Textarea
              id="a2p-review-note"
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 2000))}
              rows={3}
              placeholder="Our sign-up form does work: the error shows only when the phone field is empty."
              data-testid="registration-review-note"
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            className="mt-3"
            onClick={askReview}
            disabled={asking || busy || checking || !agreed}
            data-testid="registration-ask-review-button"
          >
            {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {review?.status === 'waiting' ? 'Ask HandsFreeOS again' : 'Ask HandsFreeOS to check it'}
          </Button>
          {!agreed ? (
            <p className="mt-1.5 text-[13px] text-text-3">
              Tick &ldquo;These details are accurate&rdquo; above first.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
  const footer = (
    <div>
      <div className="mt-6 flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => (at > 0 ? setAt(at - 1) : guided ? setStarted(false) : onBack?.())}
          disabled={busy || (at === 0 && !onBack && !guided)}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        {at === STEPS.length - 1 ? (
          <Button
            type="button"
            onClick={submit}
            disabled={
              busy || checking || asking || hasBlockers(issues) || !agreed || !checks || !allGreen
            }
            data-testid="submit-registration"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy
              ? 'Sending…'
              : feeTotal > 0
                ? `Pay ${money(feeTotal)} and send`
                : 'Send to the carriers'}
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

  if (guided) {
    // What each question was answered with, for the list beside it.
    const said: Record<string, string | null> = {
      business: form.legalName.trim() || null,
      where: form.website.trim() ? hostOf(withScheme(form.website)) : null,
      contact: `${form.contactFirst} ${form.contactLast}`.trim() || null,
      about: USE_CASES.find((u) => u.value === form.useCase)?.title ?? null,
      samples: `${form.samples.filter((x) => x.trim()).length} written`,
      optin: WAY_CHOICES.find((w) => w.value === form.optInPath)?.title ?? null,
      policy:
        form.ownPolicyUrl.trim() && form.ownTermsUrl.trim()
          ? 'Your own'
          : form.ownPolicyUrl.trim() || form.ownTermsUrl.trim()
            ? 'One of yours, one of ours'
            : 'The ones we write for you',
      review: null,
    };
    const steps: GuidedStep[] = STEPS.map((x, i) => ({
      key: x.key,
      label: x.label,
      value: started && i < at ? (said[x.key] ?? null) : null,
      state: !started || i > at ? 'todo' : i === at ? 'now' : 'done',
      group: PARTS[x.part]!.title.replace('We check it, then you send it', 'Send it'),
    }));
    if (!started)
      return (
        <GuidedCard
          screen="start"
          testId="texting-approval"
          kicker="Texting approval"
          title="Let’s get you approved to text"
          hint="The phone carriers check every business before it can text. Here’s what happens, in four parts."
          banner={<ReviewBanner review={review} />}
          steps={steps}
          stepsTitle="Texting approval so far"
          footer={
            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={guided.onLater}
                data-testid="texting-approval-later"
              >
                Do it later
              </Button>
              <Button
                type="button"
                size="lg"
                onClick={() => setStarted(true)}
                data-testid="texting-approval-start"
              >
                Start
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          }
        >
          <ol className="flex flex-col gap-3.5">
            {PARTS.map((part, i) => (
              <li key={part.title} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-px inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent-text"
                >
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-[14.5px] font-semibold">{part.title}</span>
                  <span className="block text-[13.5px] leading-normal text-text-2">
                    {part.about}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <div className="rounded-card bg-card-2 p-4">
            <p className="text-[13.5px] font-semibold">Have these handy</p>
            <ul className="mt-2 flex flex-col gap-1.5 text-[13.5px] text-text-2">
              {[
                'Your EIN, and your business name the way your IRS letter writes it.',
                'A way to change your website, or the email of the person who looks after it.',
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 flex-none text-success-text" aria-hidden />
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </GuidedCard>
      );
    return (
      <GuidedCard
        screen={step.key}
        testId="texting-approval"
        kicker={`Texting approval · ${steps[at]!.group} · Question ${at + 1} of ${STEPS.length}`}
        title={step.title}
        hint={step.blurb}
        banner={<ReviewBanner review={review} />}
        steps={steps}
        stepsTitle="Texting approval so far"
        footer={footer}
      >
        <div data-testid="business-step">{body}</div>
      </GuidedCard>
    );
  }

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
      <ReviewBanner review={review} />
      <h2 className="text-[19px] font-semibold">{step.title}</h2>
      <p className="mb-5 mt-1 text-[13.5px] text-text-2">{step.blurb}</p>
      {body}
      {footer}
    </div>
  );
}

// ---------- the example texts ----------

/** Under an example as it's typed: what a reviewer looks for that it already says, and how long it is. */
function SampleMarks({ sample, businessName }: { sample: string; businessName: string }) {
  const text = sample.trim();
  const marks = [
    ...(text && sampleNamesBusiness(text, businessName) ? [`Says ${businessName}`] : []),
    ...(text && sampleHasOptOut(text) ? ['Says how to stop'] : []),
  ];
  return (
    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12.5px]">
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        {marks.map((mark) => (
          <span key={mark} className="inline-flex items-center gap-1 text-success-text">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {mark}
          </span>
        ))}
      </span>
      <span className={cn('text-text-3', text.length > 320 && 'font-medium text-danger-text')}>
        {text.length} of 320
      </span>
    </div>
  );
}

/**
 * "Pick from these": example texts sorted by kind, worded for the business's kind when we know it (the owner, 22 Nov
 * 2026: three written for a repair business "didn't always fit or maybe only one did"). Use this fills the first
 * empty example, then takes turns between the two.
 */
function SamplePicker({
  businessName,
  useCase,
  industry,
  samples,
  onUse,
}: {
  businessName: string;
  useCase: string;
  industry: string | null;
  samples: readonly string[];
  onUse: (next: string[]) => void;
}) {
  const fits = samplesFitIndustry(industry);
  const [general, setGeneral] = useState(false);
  const [kind, setKind] = useState<SampleKind | 'all'>('all');
  const turn = useRef(0);
  const choices = sampleChoices(businessName, useCase, general ? null : industry);
  const kinds = SAMPLE_KINDS.filter((k) => choices.some((c) => c.kind === k.id));
  const use = (text: string) => {
    const next = [...samples];
    const empty = next.findIndex((x) => !x.trim());
    const slot = empty === -1 ? turn.current % Math.max(next.length, 1) : empty;
    turn.current = slot + 1;
    next[slot] = text;
    onUse(next);
  };
  const chip = (id: SampleKind | 'all', label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setKind(id)}
      aria-pressed={kind === id}
      data-testid={`a2p-sample-kind-${id}`}
      className={cn(
        'inline-flex h-[30px] items-center rounded-full border px-3 text-[13px] font-medium',
        kind === id
          ? 'border-text bg-text text-card'
          : 'border-border-strong bg-card text-text hover:bg-card-2',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="rounded-card border border-border bg-card-2 p-3.5" data-testid="a2p-samples">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[13.5px] font-semibold">Pick from these</p>
        {fits ? (
          <p className="text-[13px] text-text-2">
            {general
              ? 'General wording.'
              : `Worded for your kind of business (${industryLabel(industry)}).`}{' '}
            <button
              type="button"
              className="font-medium text-accent-text underline"
              onClick={() => setGeneral(!general)}
              data-testid="a2p-samples-general"
            >
              {general ? 'Show the ones for my kind' : 'Show general ones'}
            </button>
          </p>
        ) : null}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {chip('all', `All ${choices.length}`)}
        {kinds.map((k) => chip(k.id, k.label))}
      </div>
      <ul className="mt-2.5 flex flex-col gap-2">
        {choices.map((choice, i) => {
          if (kind !== 'all' && choice.kind !== kind) return null;
          const used = samples.findIndex((x) => x.trim() === choice.text);
          return (
            <li
              key={choice.id}
              className={cn(
                'flex items-center gap-3 rounded-menu border bg-card px-3 py-2.5',
                used === -1 ? 'border-border' : 'border-accent bg-accent-soft',
              )}
            >
              <span className="min-w-0 flex-1 text-[13.5px] leading-snug">
                <span className="mb-0.5 block text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                  {choice.label}
                </span>
                {choice.text}
              </span>
              {used === -1 ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => use(choice.text)}
                  data-testid={`a2p-suggestion-${i}`}
                >
                  Use this
                </Button>
              ) : (
                <span className="flex-none text-[12.5px] font-semibold text-accent-text">
                  Example {used + 1}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- the policy step ----------

/** A policy or terms as it was last handed back whole (`registration.get_policies`), and the page it was made for. */
interface KeptPolicy extends UpdatedPolicy {
  readonly sourceUrl: string | null;
}
interface KeptPolicies {
  readonly privacy: KeptPolicy | null;
  readonly terms: KeptPolicy | null;
}
const NONE_KEPT: KeptPolicies = { privacy: null, terms: null };

function PolicyStep({
  workspaceId,
  businessName,
  form,
  set,
  patch,
  origin,
  pagesOrigin,
  siteSlug,
  phone,
  issues,
}: {
  workspaceId: string;
  businessName: string;
  form: WizardForm;
  set: <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void;
  /** Several answers at once: a pick, and that the question has been settled. */
  patch: (changes: Partial<WizardForm>) => void;
  origin: string;
  /** The address the business's simple page here is on, when it isn't ours: a website there has no policy of its own. */
  pagesOrigin: string | null;
  siteSlug: string | null;
  /** The business number, which the terms give as the way to get help. Not known yet when it is on its way. */
  phone: string | undefined;
  issues: readonly A2pIssue[];
}) {
  const own = form.ownPolicyUrl.trim().length > 0;
  const ownTerms = form.ownTermsUrl.trim().length > 0;
  const hostedUrl = siteSlug ? `${origin}/legal/${siteSlug}/privacy` : null;
  const hostedTermsUrl = siteSlug ? `${origin}/legal/${siteSlug}/terms` : null;
  // How customers reach the business, asked here and filled in from what is known: the contact's email and the
  // business number. Only when both are empty, so a box cleared on purpose stays clear.
  useEffect(() => {
    if (form.policyEmail.trim() || form.policyPhone.trim()) return;
    if (form.contactEmail.trim()) set('policyEmail', form.contactEmail.trim());
    if (phone) set('policyPhone', phone);
  }, []);
  const business = { name: businessName, ...policyDetailsOf(form) };
  const policy = privacyPolicy(business);
  const terms = termsOfService(business);
  // What the section added to the business's own policy or terms is written from: the same details, and for
  // the terms, where the privacy policy the reviewer will open is.
  const updating: PolicyUpdateInput['business'] = {
    name: businessName,
    legalName: form.legalName,
    ...(business.email ? { email: business.email } : {}),
    ...(business.phone ? { phone: business.phone } : {}),
    offers: sendsOffers(form.useCase),
    address: business.address,
  };
  const privacyUrl = own ? withScheme(form.ownPolicyUrl) : hostedUrl;
  const termsTexting = terms.sections.find((s) => /text messages/i.test(s.heading));
  const clause = policy.sections.find((s) => /text messages/i.test(s.heading))?.paragraphs.at(-1);

  // ---- what was handed back before ----
  // Kept by the worker each time it makes one, so coming back shows it without reading the page or asking again.
  // Undefined while it's being read; an API from before it kept any simply has none.
  const [kept, setKept] = useState<KeptPolicies | undefined>(undefined);
  useEffect(() => {
    let gone = false;
    const settle = (got: KeptPolicies) => {
      if (!gone) setKept(got);
    };
    apiBrowser()
      .POST('/v1/queries/registration.get_policies', { body: { workspaceId } })
      .then(
        (r) => settle(r.data ? { privacy: r.data.privacy, terms: r.data.terms } : NONE_KEPT),
        () => settle(NONE_KEPT),
      );
    return () => {
      gone = true;
    };
  }, [workspaceId]);

  // ---- their own, when their website has them (the owner's pick 10a, 2026-11-22) ----
  // The first time this question opens, the look at their site says where its privacy policy and terms are, and those
  // are picked for them; each is then read and handed back whole by itself, below. After that the answers are theirs:
  // nothing here changes a pick the person made.
  const website = withScheme(form.website);
  const siteOrigin = originOfSite(website);
  const ownSite = !!siteOrigin && siteOrigin !== origin && siteOrigin !== pagesOrigin;
  const [looking, setLooking] = useState(false);
  const [foundOn, setFoundOn] = useState<PolicyPages | null>(null);
  // The pages read by themselves: the ones already given when this question opened, and the ones the look finds.
  // An address typed here waits for its button, so half an address is never read.
  const [auto, setAuto] = useState(() => ({
    privacy: form.ownPolicyUrl.trim() ? withScheme(form.ownPolicyUrl) : '',
    terms: form.ownTermsUrl.trim() ? withScheme(form.ownTermsUrl) : '',
  }));
  const latest = useRef(form);
  useEffect(() => {
    latest.current = form;
  });
  useEffect(() => {
    if (form.policyLooked || !ownSite) return;
    let gone = false;
    setLooking(true);
    siteLook(workspaceId, website)
      .then((found) => {
        const now = latest.current;
        // A site that didn't open says nothing about what's on it: it's asked again next time.
        if (gone || now.policyLooked || found.opened < 1) return;
        const pages = found.policyPages ?? { privacy: null, terms: null };
        const privacy = now.ownPolicyUrl.trim() ? null : pages.privacy;
        const termsPage = now.ownTermsUrl.trim() ? null : pages.terms;
        patch({
          policyLooked: true,
          ...(privacy ? { ownPolicyUrl: privacy } : {}),
          ...(termsPage ? { ownTermsUrl: termsPage } : {}),
        });
        setAuto((had) => ({ privacy: privacy ?? had.privacy, terms: termsPage ?? had.terms }));
        // Said only when the look decided something: with both given already, there's nothing to say.
        if (!now.ownPolicyUrl.trim() || !now.ownTermsUrl.trim())
          setFoundOn({ privacy, terms: termsPage });
      })
      // The question works without the look: ours are picked, and theirs can still be given.
      .catch(() => undefined)
      .finally(() => {
        if (!gone) setLooking(false);
      });
    return () => {
      gone = true;
    };
    // Once, when the question opens.
  }, []);

  return (
    <div className="space-y-4">
      <Callout tone="info">
        A carrier&rsquo;s reviewer reads your privacy policy and terms for what they say about
        texts. If your website has them, we hand each one back whole with that part added. If it
        doesn&rsquo;t, we write them for you.
      </Callout>

      {looking ? (
        <p className="flex items-center gap-2 text-[13px] text-text-3" data-testid="policy-looking">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Looking on {hostOf(website)} for a privacy policy and terms…
        </p>
      ) : null}
      {foundOn ? (
        <Callout tone="neutral" data-testid="policy-found">
          {policyPagesSummary(foundOn, hostOf(website))}
        </Callout>
      ) : null}

      {/* Only ours print it: with both their own, there's nowhere for it to go. */}
      {!own || !ownTerms ? (
        <div data-testid="policy-contact">
          <p className="text-[13.5px] font-semibold">How customers reach you</p>
          <p className="mt-0.5 text-[13px] text-text-2">
            Your privacy policy and terms say this under “Contact us”. Give at least one.
          </p>
          <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
            <Field label="Email" htmlFor="a2p-policyEmail">
              <Input
                id="a2p-policyEmail"
                type="email"
                value={form.policyEmail}
                onChange={(e) => set('policyEmail', e.target.value)}
                placeholder="hello@example.com"
              />
            </Field>
            <Field label="Phone" htmlFor="a2p-policyPhone">
              <Input
                id="a2p-policyPhone"
                type="tel"
                value={form.policyPhone}
                onChange={(e) => set('policyPhone', e.target.value)}
                placeholder="(713) 555-0100"
              />
            </Field>
          </div>
          <Issues issues={issuesFor(issues, 'policyContact')} />
        </div>
      ) : null}

      <div role="radiogroup" aria-label="Privacy policy" className="space-y-2.5">
        <RadioCard
          selected={!own}
          onSelect={() => patch({ ownPolicyUrl: '', policyLooked: true })}
          testId="policy-hosted"
          title="Use the one we write for you"
          description="Written from your business details and kept on a page we host for you, with the exact sentence about text messages that reviewers look for."
        />
        <RadioCard
          selected={own}
          onSelect={() =>
            patch({
              ownPolicyUrl: form.ownPolicyUrl || withScheme(form.website),
              policyLooked: true,
            })
          }
          testId="policy-own"
          title="I already have my own"
          description="Give us its page. We read it and hand it back whole, with the part about texts added, ready to paste over the old one."
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
          <PolicyUpdater
            workspaceId={workspaceId}
            kind="privacy"
            url={withScheme(form.ownPolicyUrl)}
            business={updating}
            kept={kept === undefined ? undefined : kept.privacy}
            auto={samePolicyPage(auto.privacy, form.ownPolicyUrl)}
          />
          {clause ? (
            <div className="rounded-menu border border-border bg-card-2 p-4">
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-[13.5px] font-semibold">
                  Adding it by hand? Make sure it says this
                </p>
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
        <div className="rounded-menu border border-border bg-card-2 p-4" data-testid="policy-ours">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13.5px] font-semibold">{policy.title}</p>
            <CopyButton text={policyAsText(policy)} label="Copy all of it" />
          </div>
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
          <p className="mt-1 text-[13px] text-text-3">
            It&rsquo;s on that page already, so there&rsquo;s nothing to paste. Copy it only if you
            want it on a page of your own website too.
          </p>
          <PolicyPreview sections={policy.sections} />
        </div>
      )}

      <div className="border-t border-border pt-4">
        <p className="mb-2 text-[13.5px] font-semibold">Your terms</p>
        <div role="radiogroup" aria-label="Terms" className="space-y-2.5">
          <RadioCard
            selected={!ownTerms}
            onSelect={() => patch({ ownTermsUrl: '', policyLooked: true })}
            testId="terms-hosted"
            title="Use the terms we write for you"
            description="Short terms that cover your texts the way the carriers expect: what you text about, how often, rates, STOP and HELP, and how to reach you."
          />
          <RadioCard
            selected={ownTerms}
            onSelect={() =>
              patch({
                ownTermsUrl: form.ownTermsUrl || `${withScheme(form.website)}/terms`,
                policyLooked: true,
              })
            }
            testId="terms-own"
            title="I already have my own"
            description="Give us their page. We read them and hand them back whole, with the part about texts added, ready to paste over the old ones."
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
            <PolicyUpdater
              workspaceId={workspaceId}
              kind="terms"
              url={withScheme(form.ownTermsUrl)}
              business={{ ...updating, ...(privacyUrl ? { privacyUrl } : {}) }}
              kept={kept === undefined ? undefined : kept.terms}
              auto={samePolicyPage(auto.terms, form.ownTermsUrl)}
            />
            <div className="mt-3 rounded-menu border border-border bg-card-2 p-4">
              <p className="text-[13.5px] font-semibold">
                Adding it by hand? What they have to say about texts
              </p>
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
          <div
            className="mt-3 rounded-menu border border-border bg-card-2 p-4"
            data-testid="terms-ours"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13.5px] font-semibold">{terms.title}</p>
              <CopyButton text={policyAsText(terms)} label="Copy all of it" />
            </div>
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

const DOC_NAMES: Readonly<Record<PolicyKind, string>> = {
  privacy: 'privacy policy',
  terms: 'terms',
};

/**
 * The business's own policy or terms, read from its page (or pasted, when the page's words can't be read) and given
 * back whole with the texting section in place, to paste over the old one. Most businesses handed the section alone
 * don't know where in their policy it goes.
 *
 * **By itself, for a page already known** (`auto`: the owner's pick 10a, 2026-11-22): one the look at their site
 * found, or one given on an earlier visit. And only once: what it made is kept (`kept`), so coming back shows that
 * again instead of reading the page and asking the AI a second time. A page it can't read opens the box to paste.
 */
function PolicyUpdater({
  workspaceId,
  kind,
  url,
  business,
  kept,
  auto,
}: {
  workspaceId: string;
  kind: PolicyKind;
  url: string;
  business: PolicyUpdateInput['business'];
  /** What was last handed back for this document; undefined while that's still being read. */
  kept: KeptPolicy | null | undefined;
  /** This page is read without being asked. */
  auto: boolean;
}) {
  const name = DOC_NAMES[kind];
  const [working, setWorking] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<PolicyUpdateOutput | null>(null);
  // Only one made for this page: a business that moved its policy starts again.
  const keptHere = kept && samePolicyPage(kept.sourceUrl, url) ? kept : null;

  // A new address is a different policy: what was made from the old one no longer applies.
  useEffect(() => {
    setResult(null);
    setProblem(null);
  }, [url]);

  const run = async (fromPaste: boolean) => {
    setWorking(true);
    setProblem(null);
    try {
      const got = await policyUpdate({
        workspaceId,
        kind,
        // The page it's for goes with pasted words too, so what's made is kept under it.
        ...(url ? { url } : {}),
        ...(fromPaste ? { text: pasted } : {}),
        business,
      });
      setResult(got);
      setPasting(false);
    } catch (err) {
      setResult(null);
      setProblem(errorMessage(err));
      // A page we couldn't read can still be pasted.
      if (
        err instanceof ApiError &&
        ['policy_unreachable', 'policy_unreadable', 'policy_not_a_policy'].includes(err.rule ?? '')
      )
        setPasting(true);
    } finally {
      setWorking(false);
    }
  };

  // Read by itself, once for a page, when nothing was kept for it.
  const ran = useRef<string | null>(null);
  useEffect(() => {
    if (!auto || !url || kept === undefined || keptHere || ran.current === url) return;
    ran.current = url;
    void run(false);
    // When the page, or what's known about it, changes: `run` is new on every render.
  }, [auto, url, kept]);

  const shown: UpdatedPolicy | null = result ?? keptHere;
  const added = shown ? shown.blocks.filter((b) => b.mark === 'added') : [];
  const doc = shown ? { text: updatedPolicyText(shown), html: updatedPolicyHtml(shown) } : null;
  const section = shown
    ? {
        text: updatedPolicyText({ blocks: added, changes: [] }),
        html: updatedPolicyHtml({ blocks: added, changes: [] }),
      }
    : null;

  return (
    <div
      className="mt-3 rounded-menu border border-border bg-card-2 p-4"
      data-testid={`policy-update-${kind}`}
    >
      <p className="text-[13.5px] font-semibold">Your {name}, handed back whole</p>
      <p className="mt-0.5 text-[13px] text-text-3">
        We read your {name} and give it back whole, with the section about texts in the right place,
        ready to paste over the old one. Your own words stay as they are.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant={shown ? 'secondary' : 'primary'}
          size="sm"
          disabled={working || !url}
          onClick={() => void run(false)}
          data-testid={`policy-update-${kind}-run`}
        >
          {working && !pasting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {working && !pasting
            ? `Reading your ${name}…`
            : shown
              ? 'Read it again'
              : `Add it to my ${name} for me`}
        </Button>
        {!pasting ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setPasting(true)}>
            Paste it instead
          </Button>
        ) : null}
      </div>

      {problem ? (
        <Callout tone="warning" icon={CircleAlert} className="mt-3">
          {problem}
        </Callout>
      ) : null}

      {pasting ? (
        <div className="mt-3 space-y-2">
          <Field label={`Your whole ${name}`} htmlFor={`policy-paste-${kind}`}>
            <Textarea
              id={`policy-paste-${kind}`}
              rows={8}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={`Open your ${name}, select all of it, copy it and paste it here.`}
            />
          </Field>
          <Button
            type="button"
            size="sm"
            disabled={working || !pasted.trim()}
            onClick={() => void run(true)}
          >
            {working ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {working ? 'Adding the section…' : 'Add it to what I pasted'}
          </Button>
        </div>
      ) : null}

      {shown && doc && section ? (
        <div className="mt-4 space-y-3" data-testid={`policy-update-${kind}-result`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13.5px] font-semibold">Your {name}, updated</p>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={section.text} html={section.html} label="Copy the new section" />
              <CopyButton text={doc.text} html={doc.html} label="Copy all of it" />
            </div>
          </div>
          <p className="text-[13px] text-text-3">
            Paste it over the whole of your old {name}, then publish the page. Pasting replaces your
            page&rsquo;s links and formatting; if it has links you want to keep, copy just the new
            section instead and paste it where it&rsquo;s highlighted below.
          </p>
          {shown.changes.length > 0 ? (
            <div className="rounded-menu bg-card p-3">
              <p className="text-[13px] font-semibold">
                We also changed {shown.changes.length === 1 ? 'one' : shown.changes.length} of your
                own lines
              </p>
              <ul className="mt-1.5 space-y-2 text-[13px] leading-relaxed">
                {shown.changes.map((c, i) => (
                  <li key={i}>
                    <p className="text-text-3 line-through">{c.before}</p>
                    {c.after ? <p className="text-text-2">{c.after}</p> : null}
                    <p className="text-[12.5px] text-text-3">{c.why}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="max-h-96 space-y-1.5 overflow-y-auto rounded-menu bg-card p-3 pr-2 text-[13px] leading-relaxed">
            {shown.blocks.map((b, i) => (
              <p
                key={i}
                className={cn(
                  b.kind === 'heading' ? 'pt-2 font-semibold text-text' : 'text-text-2',
                  b.kind === 'item' && 'pl-3',
                  b.mark === 'added' && 'border-l-2 border-accent bg-accent-soft pl-2',
                  b.mark === 'changed' && 'border-l-2 border-warning bg-warning-soft pl-2',
                )}
              >
                {b.kind === 'item' ? '• ' : ''}
                {b.text}
              </p>
            ))}
          </div>
        </div>
      ) : null}
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
        <div className="text-[13.5px] [overflow-wrap:anywhere]">
          {value || <span className="text-text-3">—</span>}
        </div>
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

/**
 * Where the business's ask for HandsFreeOS to check it stands: waiting, approved and on its way, or sent back with
 * what to change. Shown on every step, so coming back to the registration says it first.
 */
function ReviewBanner({ review }: { review: ReviewInfo | null }) {
  if (!review) return null;
  const ticket = review.ticketNumber ? ` (ticket #${review.ticketNumber})` : '';
  if (review.status === 'waiting')
    return (
      <Callout
        tone="info"
        icon={Loader2}
        className="mb-4"
        data-testid="registration-review-waiting"
      >
        HandsFreeOS is checking this{ticket}. We&rsquo;ll email you once it&rsquo;s approved and
        sent, or if anything needs changing. Sending it yourself once it&rsquo;s all green, or
        asking again, replaces this check.
      </Callout>
    );
  if (review.status === 'approved')
    return (
      <Callout tone="info" icon={Check} className="mb-4" data-testid="registration-review-approved">
        HandsFreeOS checked this and approved it{ticket}. It&rsquo;s on its way to the carriers.
      </Callout>
    );
  if (review.status === 'sent_back')
    return (
      <Callout
        tone="warning"
        icon={CircleAlert}
        className="mb-4"
        data-testid="registration-review-sent-back"
      >
        <div>
          <p className="font-semibold">HandsFreeOS sent this back{ticket}</p>
          {review.decisionNote ? (
            <p className="mt-1 whitespace-pre-line">{review.decisionNote}</p>
          ) : null}
          <p className="mt-1">
            Change it, then send it once every row is green, or ask us to check it again.
          </p>
        </div>
      </Callout>
    );
  return null;
}

function ReviewStep({
  form,
  businessName,
  issues,
  serverErrors,
  checks,
  checking,
  onRecheck,
  readerIps,
  siteCheck,
  left,
  confirmations,
  confirmed,
  onConfirm,
  agreed,
  onAgreed,
  onJump,
  workspaceId,
  surfaces,
}: {
  form: WizardForm;
  /** The name customers know: with a DBA, the carriers are told it beside the legal name. */
  businessName: string;
  issues: readonly A2pIssue[];
  serverErrors: readonly string[];
  /** What a reviewer would find, or null while it has not been looked at. */
  checks: readonly PreflightCheck[] | null;
  checking: boolean;
  onRecheck: () => void;
  /** The fixed addresses our reads come from (empty until set up), for letting HandsFreeOS in at the host. */
  readerIps: readonly string[];
  /** For "Finish the check on my site": the page to open (with our code on it), and the pages to read first. */
  siteCheck: { readonly start: string | null; readonly urls: readonly string[] };
  /** Everything that isn't green yet (the worker's list and the unticked ticks), or null before it has looked. */
  left: readonly string[] | null;
  /** The ticks only the business can give, and which are ticked. */
  confirmations: readonly Confirmation[];
  confirmed: readonly string[];
  onConfirm: (id: ConfirmationId, on: boolean) => void;
  agreed: boolean;
  onAgreed: (next: boolean) => void;
  onJump: (key: string) => void;
  workspaceId: string;
  surfaces: HostedSurfaces;
}) {
  const blockers = issues.filter((i) => i.severity === 'blocker');
  // What the website itself still needs, for whoever looks after it: the rows above that a web person fixes.
  const websiteFixes = checks ? fixesMissing(checks, form.optInPath || null) : [];
  // A question only the business can answer is a tick below, not a warning.
  const warnings = issues.filter((i) => i.severity === 'warning' && !i.confirm);
  const pathLabel = AGREE_WAY_LABELS[agreeWayOf(form)];
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
      ) : left !== null && left.length === 0 ? (
        <Callout tone="info" icon={Check} data-testid="registration-all-green">
          Everything is green. The carriers usually answer within three to seven working days.
        </Callout>
      ) : left !== null ? (
        <Callout tone="warning" icon={CircleAlert} data-testid="registration-not-green">
          <div>
            <p className="font-semibold">
              {left.length === 1
                ? 'One thing isn’t green yet'
                : `${left.length} things aren’t green yet`}
            </p>
            <p className="mt-1">
              It goes to the carriers only when everything is green. Fix what you can, or ask
              HandsFreeOS to check it below.
            </p>
          </div>
        </Callout>
      ) : null}

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
            Opening your website and every page on it, your privacy policy, your terms and the page
            where customers agree, the way a carrier&rsquo;s reviewer does. A big site takes up to
            half a minute.
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
              {check.via ? (
                <p className="text-[12.5px] text-text-3" data-testid="registration-check-via">
                  {check.via === 'browser'
                    ? 'Read in your own browser, on your site.'
                    : 'Read from your screenshot.'}
                </p>
              ) : null}
              {check.url ? (
                <a
                  className="text-[13px] underline text-text-3 [overflow-wrap:anywhere]"
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
        {checks ? (
          <div className="mt-2">
            <SiteCheckHelp
              workspaceId={workspaceId}
              website={withScheme(form.website)}
              start={siteCheck.start}
              urls={siteCheck.urls}
              checks={checks}
              readerIps={readerIps}
              onRecheck={onRecheck}
            />
          </div>
        ) : null}
        {!checking && !checks ? (
          <p className="text-[13px] text-text-2">
            We could not look just now. Press &ldquo;Check again&rdquo; — the registration will not
            go until these have been looked at.
          </p>
        ) : null}
        {checks ? (
          <div
            className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-3"
            data-testid="registration-web-person"
          >
            <WebPersonButton
              workspaceId={workspaceId}
              website={withScheme(form.website) || null}
              forms={surfaces.liveForms ?? []}
              chats={surfaces.chats ?? []}
              suggested={websiteFixes}
              path={form.optInPath || null}
            />
            <p className="min-w-0 flex-1 text-[13px] text-text-3">
              {websiteFixes.length
                ? 'Someone else looks after your site? Send them what’s missing, each change in its own file.'
                : 'Someone else looks after your site? Send them any of the changes, each in its own file.'}
            </p>
          </div>
        ) : null}
      </div>

      {confirmations.length ? (
        <div
          className="space-y-2.5 rounded-menu border border-border bg-card p-4"
          data-testid="registration-confirmations"
        >
          <p className="text-[13.5px] font-semibold">Only you can say these are true</p>
          <p className="text-[13px] text-text-2">
            No check can test them, and a reviewer will. Tick each one once you&rsquo;ve made sure.
          </p>
          {confirmations.map((c) => (
            <Checkbox
              key={c.id}
              className="text-[13px]"
              label={c.label}
              checked={confirmed.includes(c.id)}
              onChange={(e) => onConfirm(c.id, e.target.checked)}
              data-testid={`registration-confirm-${c.id}`}
            />
          ))}
        </div>
      ) : null}

      {warnings.length ? (
        <Callout tone="warning" icon={CircleAlert}>
          <div>
            <p className="font-semibold">Not green: worth fixing first</p>
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
        <Row
          label="Business"
          value={senderForCarriers(form.legalName, businessName)}
          onJump={() => onJump('business')}
        />
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
        <Row
          label="How customers reach you"
          value={[form.policyEmail.trim(), form.policyPhone.trim()].filter(Boolean).join(' · ')}
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
