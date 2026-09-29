import Link from 'next/link';
import { ViewAsButton } from '@/components/admin/view-as';
import { PhoneModelBlock } from '@/components/admin/phone-model-block';
import { WalletBlock } from '@/components/admin/wallet-block';
import { STATUS_WORD, sinceWords, whenWords } from '@/components/admin/ticket-bits';
import { CopyField } from '@/components/ui/copy-field';
import { apiServer, unwrap, unwrapPage } from '@/lib/api/server';

const SETUP_WORDS: Record<string, string> = {
  phone: 'Texting and calls',
  email: 'Email',
  payments: 'Taking money',
  calendar: 'Calendar and booking',
  aiTeammate: 'AI teammate',
};

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
        ← All businesses
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold md:text-2xl">{b.name}</h1>
          <p className="mt-1 text-[13px] text-text-3">
            {b.organizationName ? `${b.organizationName} · ` : ''}signed up{' '}
            {new Date(b.createdAt).toLocaleDateString()} · last active{' '}
            {b.lastActiveAt
              ? sinceWords(Math.round((Date.now() - Date.parse(b.lastActiveAt)) / 60000))
              : 'never'}{' '}
            ago
          </p>
          {/* What Admin → Founding asks for when approving a seat: a seat is the business's, not a workspace's. */}
          <div className="mt-2 flex max-w-sm items-center gap-2 text-[13px] text-text-3">
            <span className="shrink-0">Business id</span>
            <CopyField
              className="flex-1"
              value={b.organizationId}
              label="Copy the business id"
              copied="Copied the business id"
            />
          </div>
        </div>
        {me.staff?.permissions.includes('platform.view_as') ? (
          <ViewAsButton workspaceId={b.workspaceId} businessName={b.name} />
        ) : null}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: 'Contacts', value: detail.counts.people },
          { label: 'Leads', value: detail.counts.leads },
          { label: 'Conversations', value: detail.counts.conversations },
          { label: 'Appointments', value: detail.counts.appointments },
          { label: 'Invoices', value: detail.counts.invoices },
        ].map((c) => (
          <div key={c.label} className="rounded-card border border-border bg-card px-4 py-3">
            <dt className="text-[13px] text-text-3">{c.label}</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums">{c.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <section className="rounded-card border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">What is set up</h2>
          <ul className="mt-3 flex flex-col gap-2 text-[13px]">
            {Object.entries(detail.setup).map(([key, on]) => (
              <li key={key} className="flex items-center justify-between gap-2">
                <span>{SETUP_WORDS[key] ?? key}</span>
                <span className={on ? 'text-success-text' : 'text-text-3'}>
                  {on ? 'Yes' : 'Not yet'}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-card border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Their people</h2>
          <ul className="mt-3 flex flex-col gap-2 text-[13px]">
            {detail.people.map((p) => (
              <li key={p.userId} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">
                  {p.fullName || p.email}
                  <span className="text-text-3"> · {p.role}</span>
                </span>
                <span className="flex-none text-text-3">
                  {p.lastActiveAt
                    ? sinceWords(Math.round((Date.now() - Date.parse(p.lastActiveAt)) / 60000))
                    : 'never'}
                </span>
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

      <section className="mt-5 rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Their tickets</h2>
        {detail.tickets.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-3">They have never written in.</p>
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
