import {
  DESK_BUSINESS_WORDS,
  DESK_SETUP_WORDS,
  deskBusinessCounts,
  deskLastActive,
} from '@hfos/core';
import Link from 'next/link';
import { AddonTestingBlock } from '@/components/admin/addon-testing-block';
import { SupportAccessAsk } from '@/components/admin/support-access-ask';
import { ViewAsButton } from '@/components/admin/view-as';
import { OwnBusinessBlock } from '@/components/admin/own-business-block';
import { PhoneModelBlock } from '@/components/admin/phone-model-block';
import { WalletBlock } from '@/components/admin/wallet-block';
import { STATUS_WORD, whenWords } from '@/components/admin/ticket-bits';
import { apiServer, unwrap, unwrapPage } from '@/lib/api/server';

/** One business, as a support person needs it: who is in it, how much is in it, and what is switched on. */
export default async function BusinessPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [detail, wallet] = await Promise.all([
    api.POST('/v1/queries/platform.business.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/platform.wallet.get', { body: { workspaceId } }).then(unwrapPage),
  ]);
  const me = unwrap(await api.POST('/v1/queries/platform.me', { body: {} }));
  const b = detail.business;
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
        </div>
        {me.staff?.permissions.includes('platform.view_as') ? (
          <ViewAsButton
            workspaceId={b.workspaceId}
            businessName={b.name}
            founder={me.staff.founder}
          />
        ) : null}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {deskBusinessCounts(detail.counts).map((c) => (
          <div key={c.label} className="rounded-card border border-border bg-card px-4 py-3">
            <dt className="text-[13px] text-text-3">{c.label}</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums">{c.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <section className="rounded-card border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{DESK_BUSINESS_WORDS.whatIsSetUp}</h2>
          <ul className="mt-3 flex flex-col gap-2 text-[13px]">
            {Object.entries(detail.setup).map(([key, on]) => (
              <li key={key} className="flex items-center justify-between gap-2">
                <span>{DESK_SETUP_WORDS[key] ?? key}</span>
                <span className={on ? 'text-success-text' : 'text-text-3'}>
                  {on ? DESK_BUSINESS_WORDS.setUpYes : DESK_BUSINESS_WORDS.setUpNotYet}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-card border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{DESK_BUSINESS_WORDS.theirPeople}</h2>
          <ul className="mt-3 flex flex-col gap-2 text-[13px]">
            {detail.people.map((p) => (
              <li key={p.userId} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">
                  {p.fullName || p.email}
                  <span className="text-text-3"> · {p.role}</span>
                </span>
                <span className="flex-none text-text-3">{deskLastActive(p.lastActiveAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <WalletBlock
        workspaceId={workspaceId}
        businessName={b.name}
        wallet={wallet}
        canChange={me.staff?.permissions.includes('platform.wallets.adjust') ?? false}
      />

      <PhoneModelBlock
        workspaceId={workspaceId}
        phoneModel={detail.phoneModel}
        canChange={me.staff?.permissions.includes('platform.ai.manage') ?? false}
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

      <section className="mt-5 rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{DESK_BUSINESS_WORDS.theirTickets}</h2>
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
      </section>
    </div>
  );
}
