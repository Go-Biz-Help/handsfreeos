'use client';
/**
 * Starting each onboarding on Admin → Try onboarding (20261027027500). Two start from the practice sign-up (a new
 * business, and the website's affiliate link); "From an offer link" builds the link it starts from; the rest make a
 * practice business here and open it where that onboarding begins:
 *
 * - an add-on's setup: ready (its plan on), on its Add-ons page with that add-on in view;
 * - the Main offer builder: ready, with Content Creator turned on (which uses the main offer), in the builder;
 * - an agency setting up a client: the agency is yours and the client's business isn't, in its setup, as Add a
 *   business opens it for an agency;
 * - joining from a team invite: ready, with nobody in it, and you invited; the invitation comes to your email.
 */
import {
  ADDON_CATALOG,
  coreFeatureRunning,
  INDUSTRIES,
  INDUSTRY_GROUP_NAMES,
  PRACTICE_WORDS as W,
  type IndustryId,
  type PracticeFlow,
} from '@hfos/core';
import { Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/** The add-ons an add-on's setup can be practised with: every one that's built, still being built or not. */
const PRACTICE_ADDONS = ADDON_CATALOG.filter((m) => m.catalog.status !== 'planned');
/** The add-on the Main offer builder is practised with: Content Creator uses the main offer, and needs nothing else. */
const MAIN_OFFER_ADDON = 'socialcontent';
/** Where the onboardings that start from the practice sign-up begin. */
const LINKS: Partial<Record<PracticeFlow, string>> = {
  new_business: '/try/sign-up',
  affiliate: '/try/sign-up?then=affiliate',
};
/** The business name each one starts with. */
const NAMES: Partial<Record<PracticeFlow, string>> = {
  addon: 'Practice Add-ons Co',
  main_offer: 'Practice Offer Co',
  agency: 'Practice Client Co',
  invite: 'Practice Team Co',
};

const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The start for one onboarding: a link, or a form that opens under the card. */
export function PracticeStart({
  flow,
  full,
  email,
}: {
  flow: PracticeFlow;
  /** Five going already: nothing new starts. */
  full: boolean;
  email: string;
}) {
  const [open, setOpen] = useState(false);
  const link = LINKS[flow];
  if (full)
    return (
      <Button size="sm" disabled>
        <Play className="h-3.5 w-3.5" />
        {W.start}
      </Button>
    );
  if (link)
    return (
      <ButtonLink href={link} variant="primary" size="sm" data-testid={`try-start-${flow}`}>
        <Play className="h-3.5 w-3.5" />
        {W.start}
      </ButtonLink>
    );
  return (
    <>
      <Button
        size="sm"
        variant={open ? 'secondary' : 'primary'}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid={`try-start-${flow}`}
      >
        <Play className="h-3.5 w-3.5" />
        {W.start}
      </Button>
      {open ? (
        <div className="basis-full">
          {flow === 'offer_link' ? (
            <OfferLinkForm />
          ) : (
            <MakeBusinessForm flow={flow} email={email} />
          )}
        </div>
      ) : null}
    </>
  );
}

function KindSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} data-testid={id}>
      {INDUSTRY_GROUP_NAMES.map((group) => (
        <optgroup key={group} label={group}>
          {INDUSTRIES.filter((i) => i.group === group).map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

function FormFrame({
  onSubmit,
  children,
  error,
  testId,
}: {
  onSubmit?: (e: FormEvent) => void;
  children: ReactNode;
  error?: string | null;
  testId: string;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="mt-1 grid gap-3 rounded-menu border border-border bg-card-2 p-3.5 sm:grid-cols-2"
      data-testid={testId}
      noValidate
    >
      {children}
      {error ? (
        <p role="alert" className="text-[13px] text-danger-text sm:col-span-2">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** "From an offer link": what the website's or an affiliate's link carries, built into the practice sign-up's link. */
function OfferLinkForm() {
  const [plan, setPlan] = useState<'none' | 'yearly' | 'monthly'>('none');
  const [code, setCode] = useState('');
  const [ref, setRef] = useState('');
  const [business, setBusiness] = useState('');
  const [industry, setIndustry] = useState('home_services');
  const query = new URLSearchParams({
    ...(plan !== 'none' ? { plan } : {}),
    ...(code.trim() ? { code: code.trim() } : {}),
    ...(ref.trim() ? { ref: ref.trim() } : {}),
    ...(business.trim() ? { business: business.trim(), industry } : {}),
  }).toString();
  return (
    <FormFrame testId="try-form-offer_link">
      <Field label={W.linkPlan} htmlFor="try-link-plan">
        <Select
          id="try-link-plan"
          value={plan}
          onChange={(e) => setPlan(e.target.value as typeof plan)}
          data-testid="try-link-plan"
        >
          {(['none', 'yearly', 'monthly'] as const).map((p) => (
            <option key={p} value={p}>
              {W.linkPlans[p]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={W.linkCode} htmlFor="try-link-code">
        <Input
          id="try-link-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={24}
          data-testid="try-link-code"
        />
      </Field>
      <Field label={W.linkRef} htmlFor="try-link-ref">
        <Input
          id="try-link-ref"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={24}
          data-testid="try-link-ref"
        />
      </Field>
      <Field label={W.linkBusiness} htmlFor="try-link-business">
        <Input
          id="try-link-business"
          value={business}
          onChange={(e) => setBusiness(e.target.value)}
          maxLength={120}
          data-testid="try-link-business"
        />
      </Field>
      {business.trim() ? (
        <Field label={W.kind} htmlFor="try-link-industry">
          <KindSelect id="try-link-industry" value={industry} onChange={setIndustry} />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
        <p className="text-[12.5px] text-text-3">{W.linkHint}</p>
        <ButtonLink
          href={`/try/sign-up${query ? `?${query}` : ''}`}
          variant="primary"
          size="sm"
          data-testid="try-go-offer_link"
        >
          {W.start}
        </ButtonLink>
      </div>
    </FormFrame>
  );
}

/** The onboardings that start in a practice business made here. */
function MakeBusinessForm({ flow, email }: { flow: PracticeFlow; email: string }) {
  const router = useRouter();
  const [name, setName] = useState(NAMES[flow] ?? 'Practice Co');
  const [industry, setIndustry] = useState('home_services');
  const [addonId, setAddonId] = useState(PRACTICE_ADDONS[0]?.id ?? '');
  const [agencyName, setAgencyName] = useState('Practice Agency');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function start(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Give the business a name.');
    if (flow === 'agency' && !agencyName.trim()) return setError('Give the agency a name.');
    setError(null);
    setBusy(W.starting);
    try {
      const api = apiBrowser();
      const made = unwrap(
        await api.POST('/v1/commands/practice.start', {
          body: {
            businessName: name.trim(),
            timezone: browserTimeZone(),
            industry: industry as IndustryId,
            as: flow === 'agency' ? 'agency' : flow === 'invite' ? 'invited' : 'owner',
            ...(flow === 'agency' ? { agencyName: agencyName.trim() } : {}),
            ...(flow === 'invite' ? { role } : {}),
            ready: flow === 'addon' || flow === 'main_offer',
          },
        }),
      );
      const ws = made.workspaceId;
      if (flow === 'invite') {
        setSent(true);
        setBusy(null);
        router.refresh();
        return;
      }
      if (flow === 'addon') return router.push(`/app/w/${ws}/add-ons?addon=${addonId}`);
      if (flow === 'agency') return router.push(`/onboarding/${ws}`);
      // The Main offer builder: Content Creator turned on first, which the worker finishes in a moment.
      const addonName =
        ADDON_CATALOG.find((m) => m.id === MAIN_OFFER_ADDON)?.name ?? 'Content Creator';
      setBusy(W.startingAddon(addonName));
      unwrap(
        await api.POST('/v1/commands/addon.install', {
          body: { workspaceId: ws, addonId: MAIN_OFFER_ADDON, include: [] },
        }),
      );
      for (let i = 0; i < 40; i++) {
        const got = unwrap(
          await api.POST('/v1/queries/workspace.get', { body: { workspaceId: ws } }),
        );
        if (coreFeatureRunning(ADDON_CATALOG, got.workspace.addons, 'main_offer'))
          return router.push(`/app/w/${ws}/main-offer/build`);
        await wait(1500);
      }
      setError(W.addonSlow(addonName));
      router.push(`/app/w/${ws}/add-ons?addon=${MAIN_OFFER_ADDON}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  if (sent)
    return (
      <p
        className="mt-1 rounded-control bg-success-soft px-3 py-2 text-[13px] text-success-text"
        data-testid="try-invited"
      >
        {W.invitedSent(email)}
      </p>
    );

  return (
    <FormFrame onSubmit={start} error={error} testId={`try-form-${flow}`}>
      {flow === 'addon' ? (
        <Field label={W.addon} htmlFor="try-addon" className="sm:col-span-2">
          <Select
            id="try-addon"
            value={addonId}
            onChange={(e) => setAddonId(e.target.value)}
            data-testid="try-addon"
          >
            {PRACTICE_ADDONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {flow === 'agency' ? (
        <Field label={W.agencyName} htmlFor="try-agency-name" className="sm:col-span-2">
          <Input
            id="try-agency-name"
            value={agencyName}
            onChange={(e) => setAgencyName(e.target.value)}
            maxLength={120}
            data-testid="try-agency-name"
          />
        </Field>
      ) : null}
      <Field label={flow === 'agency' ? W.clientName : W.businessName} htmlFor={`try-name-${flow}`}>
        <Input
          id={`try-name-${flow}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          data-testid={`try-name-${flow}`}
        />
      </Field>
      <Field label={W.kind} htmlFor={`try-kind-${flow}`}>
        <KindSelect id={`try-kind-${flow}`} value={industry} onChange={setIndustry} />
      </Field>
      {flow === 'invite' ? (
        <Field label={W.role} htmlFor="try-role">
          <Select
            id="try-role"
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
            data-testid="try-role"
          >
            {(['member', 'admin'] as const).map((r) => (
              <option key={r} value={r}>
                {W.roles[r]}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="flex items-center justify-end gap-3 sm:col-span-2">
        {busy ? <span className="text-[12.5px] text-text-3">{busy}</span> : null}
        <Button type="submit" size="sm" loading={busy !== null} data-testid={`try-go-${flow}`}>
          {W.start}
        </Button>
      </div>
    </FormFrame>
  );
}
