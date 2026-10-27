import {
  DESK_BUSINESS_WORDS,
  DESK_QUICK_LOOK_WORDS,
  deskBusinessFlags,
  deskLastActive,
  deskMoreLines,
  deskPlanLabel,
  deskPlanLines,
  deskQuickLookCounts,
  deskSetupRows,
  deskSetupScore,
} from '@hfos/core';
import Link from 'next/link';
import { AddonTestingBlock } from '@/components/admin/addon-testing-block';
import {
  ActivitySection,
  FLAG_ACTION_CLASS,
  FlagList,
  GlanceCounts,
  GlanceLines,
  GlanceSection,
  MoreAboutThem,
  ProblemReportsSection,
  SetupRows,
  TheirMoneySection,
} from '@/components/admin/business-glance';
import { FoundingSeatBlock } from '@/components/admin/founding-seat-block';
import { SupportAccessAsk } from '@/components/admin/support-access-ask';
import { ViewAsButton } from '@/components/admin/view-as';
import { OwnBusinessBlock } from '@/components/admin/own-business-block';
import { PartnerPayoutsBlock } from '@/components/admin/partner-payouts-block';
import { PhoneModelBlock } from '@/components/admin/phone-model-block';
import { VideoCallsBlock } from '@/components/admin/video-calls-block';
import { WalletBlock } from '@/components/admin/wallet-block';
import { STATUS_WORD, whenWords } from '@/components/admin/ticket-bits';
import { Badge } from '@/components/ui/badge';
import { apiServer, unwrap, unwrapPage } from '@/lib/api/server';

/**
 * One business, as a support person needs it: what needs a look, its numbers and 30 days of activity, what is set
 * up, who is in it, its plan and balance, what its customers paid it, everything else worth knowing on a call, and
 * its tickets. The quick look shows the same at a glance; this page is where things are changed.
 */
export default async function BusinessPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [detail, wallet, partnerPayouts, glance] = await Promise.all([
    api.POST('/v1/queries/platform.business.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/platform.wallet.get', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/platform.partner_payouts.get', { body: { workspaceId } })
      .then(unwrapPage),
    api.POST('/v1/queries/platform.business.glance', { body: { workspaceId } }).then(unwrapPage),
  ]);
  const me = unwrap(await api.POST('/v1/queries/platform.me', { body: {} }));
  // Only staff who give founding seats are asked about them; for anybody else the block isn't there.
  const founding = me.staff?.permissions.includes('platform.founding.manage')
    ? await api
        .POST('/v1/queries/platform.founding.business', { body: { workspaceId } })
        .then(unwrapPage)
    : null;
  const b = detail.business;
  const setup = deskSetupRows(glance.setup);
  return (
    <div className="mx-auto w-full max-w-5xl">
      <Link href="/admin/businesses" className="text-[13px] text-text-3 hover:text-text">
        ← {DESK_BUSINESS_WORDS.allBusinesses}
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold md:text-2xl">{b.name}</h1>
          <p className="mt-1 text-[13px] text-text-3">
            {DESK_BUSINESS_WORDS.headline(b, new Date(b.createdAt).toLocaleDateString())}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant={glance.plan ? 'ok' : 'gray'}>{deskPlanLabel(glance.plan)}</Badge>
            {b.foundingSeat ? <Badge variant="ok">{b.foundingSeat}</Badge> : null}
          </div>
        </div>
        {me.staff?.permissions.includes('platform.view_as') ? (
          <ViewAsButton
            workspaceId={b.workspaceId}
            businessName={b.name}
            founder={me.staff.founder}
          />
        ) : null}
      </div>

      <div className="mt-5" data-testid="business-flags">
        <FlagList
          flags={deskBusinessFlags({ ...b, tickets: detail.tickets }, glance, wallet)}
          // Each flag's tab is a section further down this page.
          action={(tab, label) => (
            <a href={`#${tab}`} className={FLAG_ACTION_CLASS}>
              {label}
            </a>
          )}
        />
      </div>

      <div className="mt-4">
        <GlanceCounts items={deskQuickLookCounts(detail.counts, glance)} />
      </div>

      <div className="mt-6 grid items-start gap-5 md:grid-cols-2">
        <ActivitySection glance={glance} />

        <GlanceSection id="people" title={DESK_BUSINESS_WORDS.theirPeople}>
          <ul className="mt-3 flex flex-col gap-2 text-[13px]">
            {detail.people.map((p) => (
              <li key={p.userId} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {p.fullName || p.email}
                  <span className="text-text-3"> · {p.role}</span>
                </span>
                <span className="flex flex-none items-center gap-2 text-text-3">
                  {deskLastActive(p.lastActiveAt)}
                  {/* The business as this person sees it (20261018000100), read-only. */}
                  {me.staff?.permissions.includes('platform.view_as') ? (
                    <ViewAsButton
                      workspaceId={b.workspaceId}
                      businessName={b.name}
                      founder={me.staff.founder}
                      person={p}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </GlanceSection>
      </div>

      <section id="setup" className="mt-5 scroll-mt-4" data-testid="business-setup">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">{DESK_BUSINESS_WORDS.whatIsSetUp}</h2>
          <span className="text-xs text-text-3">{deskSetupScore(setup)}</span>
        </div>
        <SetupRows setup={setup} />
      </section>

      <div id="money" className="mt-5 grid scroll-mt-4 items-start gap-5 md:grid-cols-2">
        <GlanceSection title={DESK_QUICK_LOOK_WORDS.theirPlan}>
          <GlanceLines lines={deskPlanLines(glance.plan)} />
        </GlanceSection>
        <TheirMoneySection glance={glance} />
      </div>

      {founding ? (
        <FoundingSeatBlock workspaceId={workspaceId} businessName={b.name} founding={founding} />
      ) : null}

      <WalletBlock
        workspaceId={workspaceId}
        businessName={b.name}
        wallet={wallet}
        canChange={me.staff?.permissions.includes('platform.wallets.adjust') ?? false}
      />

      <PartnerPayoutsBlock
        workspaceId={workspaceId}
        businessName={b.name}
        payouts={partnerPayouts}
        canChange={me.staff?.permissions.includes('platform.partner_payouts.manage') ?? false}
      />

      <PhoneModelBlock
        workspaceId={workspaceId}
        phoneModel={detail.phoneModel}
        phoneListener={detail.phoneListener}
        canChange={me.staff?.permissions.includes('platform.ai.manage') ?? false}
      />

      <VideoCallsBlock
        workspaceId={workspaceId}
        videoCalls={detail.videoCalls}
        canChange={me.staff?.permissions.includes('platform.addons.manage') ?? false}
      />

      {me.staff?.permissions.includes('platform.view_as') ? (
        <SupportAccessAsk workspaceId={workspaceId} />
      ) : null}

      <AddonTestingBlock
        workspaceId={workspaceId}
        grants={detail.addonGrants}
        canChange={me.staff?.permissions.includes('platform.addons.manage') ?? false}
      />

      <OwnBusinessBlock
        workspaceId={workspaceId}
        isPlatform={detail.isPlatform}
        canChange={me.staff?.permissions.includes('platform.own_business.manage') ?? false}
      />

      <GlanceSection title={DESK_QUICK_LOOK_WORDS.moreAboutThem} className="mt-5" id="more">
        <MoreAboutThem lines={deskMoreLines(b, glance, detail.phoneModel)} />
      </GlanceSection>

      <div id="tickets" className="mt-5 grid scroll-mt-4 items-start gap-5 md:grid-cols-2">
        <GlanceSection title={DESK_BUSINESS_WORDS.theirTickets}>
          {detail.tickets.length === 0 ? (
            <p className="mt-2 text-[13px] text-text-3">{DESK_BUSINESS_WORDS.neverWrittenIn}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2 text-[13px]">
              {detail.tickets.map((t) => (
                <li key={t.id}>
                  <Link href={`/admin/tickets/${t.id}`} className="hover:text-accent-text">
                    #{t.number} {t.subject}
                    <span className="text-text-3">
                      {' '}
                      · {STATUS_WORD[t.status]} · {whenWords(t.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </GlanceSection>
        <ProblemReportsSection glance={glance} />
      </div>
    </div>
  );
}
