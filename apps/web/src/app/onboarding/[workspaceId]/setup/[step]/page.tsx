import { can, canActOnStep, isWizardStep, WIZARD_WORDS, type WizardStepKey } from '@hfos/core';
import type { ApiClient } from '@hfos/api-client';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AiQuickSetup } from '@/components/ai-setup/quick-setup';
import { TeammatePresetPicker } from '@/components/ai-team/preset-picker';
import { QuickSetupInstead } from '@/components/ai-team/teammate-tab';
import { WebsiteScan } from '@/components/knowledge/website-scan';
import { CalendarSetup } from '@/components/onboarding/calendar-setup';
import { CustomersSetup } from '@/components/onboarding/customers-setup';
import { NumberSetup } from '@/components/onboarding/number-setup';
import { PaymentsSetup } from '@/components/onboarding/payments-setup';
import { StepLive } from '@/components/onboarding/step-live';
import { WizardFrame, wizardNextHref } from '@/components/onboarding/wizard-frame';
import { loadAiSetup } from '@/lib/ai-setup/load';
import { teammateGetOf } from '@/lib/ai-team/types';
import { loadMigrations, setupMoveOf } from '@/lib/agency/migrations';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, getMe, unwrapPage } from '@/lib/api/server';
import type { OnboardingStatus } from '@/lib/api/types';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';
import { loadWebsiteScan } from '@/lib/knowledge';
import { setupHref } from '@/lib/setup';
import { loadTexting } from '@/lib/texting';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ step: string }>;
}): Promise<Metadata> {
  const { step } = await params;
  return { title: isWizardStep(step) ? WIZARD_WORDS.titles[step] : WIZARD_WORDS.railTitle };
}

/** What each step counts, so its place on the side and its footer move on when it changes. */
const LIVE: Record<WizardStepKey, readonly string[]> = {
  number: ['phone_number', 'registration', 'number_port', 'number_import'],
  payments: ['payment_connection'],
  customers: ['person', 'company', 'import', 'migration', 'workspace'],
  calendar: ['calendar', 'service', 'booking_site'],
  ai: [
    'ai_teammate',
    'knowledge_item',
    'knowledge_profile',
    'knowledge_scan',
    'knowledge_suggestion',
  ],
};

/**
 * One step of the setup wizard (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, boards 2 to 5b). Only someone
 * who sets the business up comes here; anyone else goes to Home.
 */
export default async function SetupStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; step: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId, step } = await params;
  if (!isWizardStep(step)) notFound();
  const home = `/app/w/${workspaceId}`;
  const { api } = await apiServer();
  const me = await getMe();
  const ws = me.workspaces.find((w) => w.id === workspaceId);
  if (!ws || !can(ws.permissions, 'workspace.update')) redirect(home);
  const status = unwrapPage(
    await api.POST('/v1/queries/onboarding.status', { body: { workspaceId } }),
  );
  // Only someone who sets the business up, and only while Getting started is on for it.
  if (status.audience !== 'business' || !status.enabled) redirect(home);

  const query = await searchParams;
  const body = canActOnStep(step, ws.permissions) ? (
    await stepBody(step, {
      api,
      workspaceId,
      organizationId: ws.organizationId,
      businessName: ws.name,
      permissions: ws.permissions,
      status,
      payments: typeof query['payments'] === 'string' ? query['payments'] : null,
      myself: query['myself'] === '1',
      at: query['at'] === 'try' ? 'try' : null,
    })
  ) : (
    <p className="text-text-2">{WIZARD_WORDS.cantDo}</p>
  );

  return (
    <WizardFrame workspaceId={workspaceId} businessName={ws.name} status={status} step={step}>
      <StepLive kinds={LIVE[step]} />
      {body}
    </WizardFrame>
  );
}

interface StepContext {
  readonly api: ApiClient;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly businessName: string;
  readonly permissions: readonly string[];
  readonly status: OnboardingStatus;
  /** `?payments=` from Stripe's or Square's sign-in. */
  readonly payments: string | null;
  /** `?myself=1`: "Set it up myself" on quick setup, for the AI teammate's presets. */
  readonly myself: boolean;
  /** `?at=try`: quick setup's test chat, after Save. */
  readonly at: 'try' | null;
}

async function stepBody(step: WizardStepKey, c: StepContext): Promise<ReactNode> {
  const { api, workspaceId } = c;
  switch (step) {
    case 'number': {
      const texting = await loadTexting(api, workspaceId);
      return texting ? <NumberSetup texting={texting} /> : null;
    }

    case 'ai': {
      const got = teammateGetOf(
        unwrapPage(await api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })),
      );
      // Quick setup until there's a teammate, and its test chat after Save; "Set it up myself" shows the presets.
      if (!got.teammate && c.myself)
        return (
          <>
            <QuickSetupInstead href={setupHref(workspaceId, 'ai')} />
            <TeammatePresetPicker
              workspaceId={workspaceId}
              workspaceName={c.businessName}
              catalogs={got.catalogs}
            />
          </>
        );
      if (!got.teammate || c.at === 'try')
        return (
          <AiQuickSetup
            data={await loadAiSetup(api, workspaceId)}
            myselfHref={`${setupHref(workspaceId, 'ai')}?myself=1`}
            settingsHref={`/app/w/${workspaceId}/ai-team`}
            doneHref={wizardNextHref(workspaceId, c.status, 'ai')}
            startAt={c.at}
          />
        );
      const scan = await loadWebsiteScan(api, workspaceId);
      return (
        <>
          <WebsiteScan {...scan} suggestedUrl={c.status.website} />
          <MoreLine
            text={WIZARD_WORDS.aiManual}
            link={WIZARD_WORDS.aiManualLink}
            href={`/app/w/${workspaceId}/knowledge`}
          />
          {got.teammate.status !== 'off' ? null : (
            <MoreLine
              text={WIZARD_WORDS.aiTurnOn}
              link={WIZARD_WORDS.aiTurnOnLink}
              href={`/app/w/${workspaceId}/ai-team`}
            />
          )}
        </>
      );
    }

    case 'customers': {
      const canMigrate = can(c.permissions, 'migrations.manage');
      const { connection, move } = canMigrate
        ? setupMoveOf(await loadMigrations(api, c.organizationId, workspaceId))
        : { connection: null, move: null };
      return (
        <CustomersSetup
          workspaceId={workspaceId}
          organizationId={c.organizationId}
          customersIn={c.status.answers?.customersIn ?? null}
          connection={connection}
          move={move}
          canImport={can(c.permissions, 'records.import')}
          canMigrate={canMigrate}
        />
      );
    }

    case 'calendar': {
      const [services, resources, members, calendars, site, brandedOrigin] = await Promise.all([
        api.POST('/v1/queries/service.list', { body: { workspaceId } }).then(unwrapPage),
        api.POST('/v1/queries/resource.list', { body: { workspaceId } }).then(unwrapPage),
        api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
        api.POST('/v1/queries/calendar.list', { body: { workspaceId } }).then(unwrapPage),
        api.POST('/v1/queries/booking_site.get', { body: { workspaceId } }).then(unwrapPage),
        brandedOriginFor(api, workspaceId),
      ]);
      const bookable = calendars.items.find((x) => x.status === 'active' && x.public);
      const first = bookable ?? calendars.items[0];
      return (
        <CalendarSetup
          workspaceId={workspaceId}
          calendar={first ? { id: first.id, name: first.name, bookable: !!bookable } : null}
          services={{
            workspaceId,
            services: services.items,
            resources: resources.items,
            people: assigneeOptions(members),
          }}
          site={{
            workspaceId,
            site: site.site,
            workspaceName: c.businessName,
            brandedOrigin,
          }}
        />
      );
    }

    case 'payments': {
      const step = c.status.steps.find((s) => s.key === 'payments');
      return (
        <PaymentsSetup
          workspaceId={workspaceId}
          said={c.status.answers?.goal === 'paid'}
          waiting={step?.state === 'waiting' ? (step.note.provider ?? 'stripe') : null}
          result={c.payments}
        />
      );
    }
  }
}

function MoreLine({ text, link, href }: { text: string; link: string; href: string }) {
  return (
    <p className="text-[13px] text-text-2">
      {text}{' '}
      <Link href={href} className="font-medium text-accent-text hover:underline">
        {link}
      </Link>
    </p>
  );
}
