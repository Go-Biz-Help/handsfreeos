import { can, canActOnStep, isWizardStep, WIZARD_WORDS, type WizardStepKey } from '@hfos/core';
import type { ApiClient } from '@hfos/api-client';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { TeammatePresetPicker } from '@/components/ai-team/preset-picker';
import { WebsiteScan } from '@/components/knowledge/website-scan';
import { CalendarSetup } from '@/components/onboarding/calendar-setup';
import { CustomersSetup } from '@/components/onboarding/customers-setup';
import { NumberSetup } from '@/components/onboarding/number-setup';
import { PaymentsSetup } from '@/components/onboarding/payments-setup';
import { StepLive } from '@/components/onboarding/step-live';
import { WizardFrame } from '@/components/onboarding/wizard-frame';
import { teammateGetOf } from '@/lib/ai-team/types';
import { STATUS_WORDS, loadMigrations } from '@/lib/agency/migrations';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, getMe, unwrapPage } from '@/lib/api/server';
import type { OnboardingStatus } from '@/lib/api/types';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';
import { loadWebsiteScan } from '@/lib/knowledge';
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

/** Migrations still counting, as the Getting started card reads them. */
const MOVE_RUNNING = new Set(['connected', 'scanning', 'importing', 'verifying']);
/** Migrations finished or stopped: nothing left to open from here. */
const MOVE_OVER = new Set(['draft', 'imported', 'completed', 'cancelling', 'cancelled']);

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
      if (!got.teammate)
        return (
          <TeammatePresetPicker
            workspaceId={workspaceId}
            workspaceName={c.businessName}
            catalogs={got.catalogs}
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
      const { migrations, connections } = canMigrate
        ? await loadMigrations(api, c.organizationId, workspaceId)
        : { migrations: [], connections: [] };
      const live = connections.find((x) => x.status === 'active') ?? null;
      const move = migrations.find((m) => !MOVE_OVER.has(m.status)) ?? null;
      return (
        <CustomersSetup
          workspaceId={workspaceId}
          organizationId={c.organizationId}
          customersIn={c.status.answers?.customersIn ?? null}
          connection={live ? { id: live.id, sourceLabel: live.sourceLabel } : null}
          move={
            move
              ? {
                  id: move.id,
                  running: MOVE_RUNNING.has(move.status),
                  words: STATUS_WORDS[move.status] ?? move.status,
                }
              : null
          }
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
