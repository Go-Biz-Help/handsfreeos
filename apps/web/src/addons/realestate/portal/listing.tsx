'use client';
/**
 * The seller's own pages in their portal (boards 46–49, design/realestate/PortalListing, PortalQuestionnaire,
 * PortalSignOff and PortalOffers): their listing (the price and what it was, the MLS, its page, what's waiting for
 * them and the open houses), the questions about their home, a sign-off of exact words, and the offers side by side
 * with what they'd take home from each. Telling their agent what they think of an offer accepts nothing; signing
 * off words is kept with those words and the time.
 */
import { dueWords } from '@hfos/core/addons/realestate/offer-words';
import { SELLER_CHOICES } from '@hfos/core/addons/realestate/net';
import { SELLER_QUESTIONS } from '@hfos/core/addons/realestate/listing';
import { fmtMonthDay, fmtWhen, localDayOf, money } from '@hfos/core';
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { usePortal, usePortalAct, usePortalQuery } from '@/components/portal/context';
import { PortalCardHead } from '@/components/portal/ui';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { parseMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ContingenciesCard, DealSteps, Done, firstName, street, TaskRow, zone } from './bits';
import type { PortalCompareRow, PortalDeal, PortalListing, PortalSellerChoice } from './types';

const thisYear = () => new Date().getFullYear();
const day = (iso: string) => fmtMonthDay(localDayOf(iso, zone()), thisYear());

function Back({ to, label }: { to: string; label: string }) {
  const { href } = usePortal();
  return (
    <Link
      href={href(to)}
      className="mb-3 inline-block text-[13.5px] text-accent-text hover:underline"
    >
      {label}
    </Link>
  );
}

/** A listing deal's page in the seller's portal (board 46). */
export function ListingDealPage({
  dealId,
  deal,
  reload,
}: {
  dealId: string;
  deal: PortalDeal;
  reload: () => void;
}) {
  const { href } = usePortal();
  const { data: l } = usePortalQuery<PortalListing>('realestate.portal.listing', { dealId });
  const d = deal.deal;
  const agent = firstName(d.agentName);
  const was = l?.priceChanges.find((p) => p.state === 'applied');
  const open = deal.tasks.filter((t) => t.status === 'open' && !t.mine);
  const c = l?.comparison;
  const undecided = c
    ? c.rows.filter((r) => !c.myChoices.some((m) => m.offerId === r.offerId))
    : [];
  const today = new Date().toISOString().slice(0, 10);
  const dates = deal.keyDates.filter((k) => k.date >= today);
  return (
    <div className="space-y-4" data-testid="portal-listing">
      <Back to="" label="Home" />
      <h1 className="text-[24px] font-semibold">
        Selling {l?.street ?? (l?.address ? street(l.address) : 'your home')}
      </h1>
      <Card className="p-4">
        <DealSteps deal={d} />
      </Card>
      {l ? (
        <Card className="p-4" data-testid="portal-listing-card">
          <PortalCardHead>Your listing</PortalCardHead>
          <dl className="space-y-1.5 text-[14px]">
            <div className="flex justify-between gap-3">
              <dt className="text-text-2">Price</dt>
              <dd className="font-semibold tabular-nums">
                {l.priceCents !== null ? money(l.priceCents) : 'Not set yet'}
              </dd>
            </div>
            {was?.appliedAt ? (
              <div className="flex justify-between gap-3">
                <dt className="text-text-2">Was</dt>
                <dd className="tabular-nums">
                  {money(was.fromCents)} until {day(was.appliedAt)}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <dt className="text-text-2">On the MLS</dt>
              <dd>{l.mls ? `Since ${fmtMonthDay(l.mls.liveOn, thisYear())}` : 'Not yet'}</dd>
            </div>
          </dl>
          {l.pagePath ? (
            <a
              href={l.pagePath}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-[13.5px] text-accent-text hover:underline"
              data-testid="portal-listing-page"
            >
              See your listing page
            </a>
          ) : null}
        </Card>
      ) : null}
      <Card className="p-4" data-testid="portal-waiting">
        <PortalCardHead>Waiting for you</PortalCardHead>
        {open.length === 0 && undecided.length === 0 ? (
          <p className="text-[14px] text-text-2">
            Nothing right now. {agent} will let you know when something needs you.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {undecided.length ? (
              <li className="flex items-center gap-3 py-2.5">
                <AlertCircle className="h-6 w-6 flex-none text-warning-text" strokeWidth={1.5} />
                <span className="min-w-0 flex-1 text-[14px]">
                  Look at your {c!.rows.length === 1 ? 'offer' : `${c!.rows.length} offers`} and
                  tell {agent} what you think
                </span>
                <Link
                  href={href(`a/realestate/deals/${dealId}/offers`)}
                  className={buttonClassName({ variant: 'secondary', size: 'sm' })}
                  data-testid="portal-offers-open"
                >
                  Open
                </Link>
              </li>
            ) : null}
            {open.map((t) => (
              <TaskRow key={t.id} task={t} dealId={dealId} onDone={reload} />
            ))}
          </ul>
        )}
      </Card>
      {l?.openHouses.length ? (
        <Card className="p-4">
          <PortalCardHead>Open houses</PortalCardHead>
          <ul className="space-y-1.5 text-[14px]">
            {l.openHouses.map((o) => (
              <li key={o.id}>
                {fmtWhen(o.startsAt, o.endsAt, zone())} with {agent}.
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {dates.length ? (
        <Card className="p-4">
          <PortalCardHead>Key dates</PortalCardHead>
          <ul className="space-y-1.5 text-[14px]">
            {dates.map((k) => (
              <li key={k.key} className="flex justify-between gap-3">
                <span className="text-text-2">{k.label}</span>
                <span>{fmtMonthDay(k.date, thisYear())}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <ContingenciesCard deal={deal} />
      {c && undecided.length === 0 ? (
        <Link
          href={href(`a/realestate/deals/${dealId}/offers`)}
          className="block text-[13.5px] text-accent-text hover:underline"
        >
          Your offers, side by side
        </Link>
      ) : null}
    </div>
  );
}

// ---------- the questions about their home (board 47) ----------

const FACT_FIELDS = [
  { key: 'beds', label: 'Bedrooms', kind: 'int' },
  { key: 'baths', label: 'Bathrooms', kind: 'half' },
  { key: 'sqft', label: 'Size (sq ft)', kind: 'int' },
  { key: 'year_built', label: 'Year built', kind: 'int' },
  { key: 'hoa_monthly_cents', label: 'HOA dues a month', kind: 'money' },
] as const;
type FactKey = (typeof FACT_FIELDS)[number]['key'];

const shown = (key: FactKey, v: unknown): string =>
  typeof v !== 'number'
    ? ''
    : key === 'hoa_monthly_cents'
      ? (v / 100).toLocaleString('en-US')
      : key === 'year_built'
        ? String(v)
        : v.toLocaleString('en-US');

/** What a typed answer is, or null when it isn't a number that fits. */
function factOf(
  kind: (typeof FACT_FIELDS)[number]['kind'],
  text: string,
): number | null | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (kind === 'money') return parseMoney(t);
  const n = Number(t.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  if (kind === 'half') return Number.isInteger(n * 2) ? n : null;
  return Number.isInteger(n) ? n : null;
}

export function QuestionnairePage({ dealId }: { dealId: string }) {
  const { data: l, reload } = usePortalQuery<PortalListing>('realestate.portal.listing', {
    dealId,
  });
  const { data: deal } = usePortalQuery<PortalDeal>('realestate.portal.deal', { dealId });
  if (!l || !deal) return null;
  return (
    <QuestionnaireForm
      key={l.questionnaire.savedAt ?? 'new'}
      dealId={dealId}
      listing={l}
      agent={firstName(deal.deal.agentName)}
      onSaved={reload}
    />
  );
}

function QuestionnaireForm({
  dealId,
  listing: l,
  agent,
  onSaved,
}: {
  dealId: string;
  listing: PortalListing;
  agent: string;
  onSaved: () => void;
}) {
  const { op, href } = usePortal();
  const router = useRouter();
  const q = l.questionnaire;
  const sent = q.state === 'submitted';
  const [facts, setFacts] = useState<Record<FactKey, string>>(
    () =>
      Object.fromEntries(
        FACT_FIELDS.map((f) => [f.key, shown(f.key, q.answers.facts[f.key])]),
      ) as Record<FactKey, string>,
  );
  const [updates, setUpdates] = useState(q.answers.updates ?? '');
  const [loves, setLoves] = useState(q.answers.loves ?? '');
  const { busy, act } = usePortalAct();
  const parsed = FACT_FIELDS.map((f) => [f.key, factOf(f.kind, facts[f.key])] as const);
  const bad = new Set(parsed.filter(([, v]) => v === null).map(([k]) => k));
  const save = () =>
    op('realestate.portal.questionnaire.save', {
      dealId,
      facts: Object.fromEntries(parsed.filter(([, v]) => typeof v === 'number')),
      updates: updates.trim(),
      loves: loves.trim(),
    });
  return (
    <div className="space-y-4" data-testid="portal-questionnaire">
      <Back to="a/realestate/todo" label="To do" />
      <h1 className="text-[24px] font-semibold">Tell us about your home</h1>
      {sent ? (
        <Card className="flex items-start gap-3 p-4 text-[14px]">
          <Done />
          <span>
            Sent to {agent}
            {q.submittedAt ? ` ${day(q.submittedAt)}` : ''}. {agent} checks every answer before
            anything is shared.
          </span>
        </Card>
      ) : (
        <p className="text-[14px] text-text-2">
          {agent} checks every answer before anything is shared. Save and come back any time.
        </p>
      )}
      <form
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void act(
            'send',
            async () => {
              await save();
              await op('realestate.portal.questionnaire.submit', { dealId });
              router.push(href(`a/realestate/deals/${dealId}`));
            },
            `Sent to ${agent}. Thank you!`,
          );
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          {FACT_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              htmlFor={`q-${f.key}`}
              error={bad.has(f.key) ? 'Enter a number, like 3.' : undefined}
            >
              <Input
                id={`q-${f.key}`}
                inputMode="decimal"
                value={facts[f.key]}
                placeholder={f.kind === 'money' ? '$' : undefined}
                disabled={sent}
                onChange={(e) => setFacts((x) => ({ ...x, [f.key]: e.target.value }))}
                data-testid={`q-${f.key}`}
              />
            </Field>
          ))}
        </div>
        <Field label={SELLER_QUESTIONS.updates} htmlFor="q-updates">
          <Textarea
            id="q-updates"
            rows={3}
            maxLength={2000}
            value={updates}
            disabled={sent}
            onChange={(e) => setUpdates(e.target.value)}
            data-testid="q-updates"
          />
        </Field>
        <Field label={SELLER_QUESTIONS.loves} htmlFor="q-loves">
          <Textarea
            id="q-loves"
            rows={3}
            maxLength={2000}
            value={loves}
            disabled={sent}
            onChange={(e) => setLoves(e.target.value)}
            data-testid="q-loves"
          />
        </Field>
        {!sent ? (
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              loading={busy === 'save'}
              disabled={bad.size > 0}
              onClick={() =>
                void act(
                  'save',
                  async () => {
                    await save();
                    onSaved();
                  },
                  'Saved. Come back any time.',
                )
              }
              data-testid="q-save"
            >
              Save for later
            </Button>
            <Button
              type="submit"
              loading={busy === 'send'}
              disabled={bad.size > 0}
              data-testid="q-send"
            >
              Send to {agent}
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}

// ---------- a sign-off of exact words (board 48) ----------

export function SignOffPage({ dealId, taskId }: { dealId: string; taskId: string }) {
  const { op, href } = usePortal();
  const { data: deal, reload } = usePortalQuery<PortalDeal>('realestate.portal.deal', { dealId });
  const [agree, setAgree] = useState(false);
  const { busy, act } = usePortalAct(reload);
  if (!deal) return null;
  const t = deal.tasks.find((x) => x.id === taskId);
  const agent = firstName(deal.deal.agentName);
  if (!t || t.kind !== 'sign_off' || !t.signOffWords || t.status === 'canceled')
    return (
      <div className="space-y-3">
        <Back to={`a/realestate/deals/${dealId}`} label="Your deal" />
        <Card className="p-4 text-[14px]">
          That isn’t waiting for you anymore. {agent} may have changed it; it’s on your deal if
          there’s a new one.
        </Card>
      </div>
    );
  const finished = t.status === 'done' || t.mine;
  return (
    <div className="space-y-4" data-testid="portal-sign-off-page">
      <Back to="a/realestate/todo" label="To do" />
      <h1 className="text-[24px] font-semibold">{t.title}</h1>
      {t.detail ? <p className="text-[14px] text-text-2">{t.detail}</p> : null}
      <Card className="p-4">
        <p
          className="whitespace-pre-wrap text-[15px] leading-relaxed"
          data-testid="portal-sign-off-words"
        >
          {t.signOffWords}
        </p>
      </Card>
      {finished ? (
        <Card className="flex items-start gap-3 p-4 text-[14px]">
          <Done />
          <span>
            You signed off{t.doneAt ? ` ${day(t.doneAt)}` : ''}.
            {t.waiting ? ` ${t.waiting}.` : ` ${agent} can see it.`}
          </span>
        </Card>
      ) : (
        <>
          <Checkbox
            label="I approve these words."
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
            data-testid="portal-sign-off-agree"
          />
          <Button
            className="w-full"
            disabled={!agree}
            loading={busy === 'sign'}
            onClick={() =>
              void act(
                'sign',
                () =>
                  op('realestate.portal.task.complete', {
                    taskId: t.id,
                    signedWords: t.signOffWords,
                  }),
                `Signed off. ${agent} can see it.`,
              )
            }
            data-testid="portal-sign-off"
          >
            Sign off
          </Button>
          <Link
            href={href('messages')}
            className={cn(buttonClassName({ variant: 'secondary' }), 'w-full')}
          >
            Ask {agent} for a change
          </Link>
        </>
      )}
      <p className="text-[13px] text-text-2">
        Your sign-off is kept with these exact words and the time.
      </p>
    </div>
  );
}

// ---------- the offers side by side (board 49) ----------

/** "No loan, no appraisal. 5-day inspection.": what stands out about an offer, in a line. */
function standsOut(r: PortalCompareRow): string {
  return [
    r.paying.startsWith('Cash') ? 'No loan, no appraisal.' : null,
    r.inspection ? `${r.inspection.replace(/ days?$/, '-day')} inspection.` : null,
    r.sellerCreditCents ? `Asks ${money(r.sellerCreditCents)} toward their costs.` : null,
    r.homeSale ? 'They need to sell their home first.' : null,
    r.escalation ? `${r.escalation}.` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

export function OffersPage({ dealId }: { dealId: string }) {
  const { data: l, reload } = usePortalQuery<PortalListing>('realestate.portal.listing', {
    dealId,
  });
  const { data: deal } = usePortalQuery<PortalDeal>('realestate.portal.deal', { dealId });
  if (!l || !deal) return null;
  const agent = firstName(deal.deal.agentName);
  const c = l.comparison;
  const due = c?.rows
    .map((r) => r.respondBy)
    .filter((x): x is string => !!x)
    .sort()[0];
  return (
    <div className="space-y-3" data-testid="portal-offers">
      <Back to={`a/realestate/deals/${dealId}`} label="Your home" />
      <h1 className="text-[24px] font-semibold">Your offers</h1>
      {!c ? (
        <Card className="p-4 text-[14px] text-text-2">
          No offers shared with you yet. {agent} shares them here, side by side, when they come in.
        </Card>
      ) : (
        <>
          <p className="text-[14px] text-text-2">
            Shared by {agent}, {day(c.sharedAt)}.
            {due ? ` The first answer is due ${dueWords(due, zone(), Date.now())}.` : ''}
          </p>
          {c.rows.map((r) => (
            <OfferChoice
              key={r.offerId}
              comparisonId={c.id}
              row={r}
              mine={c.myChoices.find((m) => m.offerId === r.offerId)}
              agent={agent}
              onSent={reload}
            />
          ))}
          <p className="text-[13px] text-text-2">
            {c.note} Telling {agent} here doesn’t accept or sign anything.
          </p>
        </>
      )}
    </div>
  );
}

function OfferChoice({
  comparisonId,
  row: r,
  mine,
  agent,
  onSent,
}: {
  comparisonId: string;
  row: PortalCompareRow;
  mine: { choice: PortalSellerChoice; words: string | null; at: string } | undefined;
  agent: string;
  onSent: () => void;
}) {
  const { op } = usePortal();
  const [choice, setChoice] = useState<PortalSellerChoice | null>(null);
  const [words, setWords] = useState('');
  const { busy, act } = usePortalAct(() => {
    setChoice(null);
    setWords('');
    onSent();
  });
  const picked = choice ?? mine?.choice ?? null;
  return (
    <div className="space-y-2" data-testid="portal-offer">
      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[16px] font-semibold">{r.buyers ?? `Offer ${r.number}`}</div>
            <div className="text-[13.5px] text-text-2">
              {r.paying}
              {r.closingDate ? ` · closes ${fmtMonthDay(r.closingDate, thisYear())}` : ''}
            </div>
          </div>
          {r.best ? <Badge variant="ok">Highest estimate</Badge> : null}
        </div>
        <dl className="mt-2 space-y-1 text-[14px]">
          <div className="flex justify-between gap-3">
            <dt className="text-text-2">Price</dt>
            <dd className="tabular-nums">{money(r.priceCents)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-text-2">You’d take home about</dt>
            <dd className="font-semibold tabular-nums">{money(r.net.netCents)}</dd>
          </div>
        </dl>
        {standsOut(r) ? <p className="mt-1 text-[13px] text-text-2">{standsOut(r)}</p> : null}
        {mine && !choice ? (
          <p className="mt-2 text-[13px]">
            You told {agent}: {SELLER_CHOICES[mine.choice]}
            {mine.words ? ` · “${mine.words}”` : ''} · {day(mine.at)}
          </p>
        ) : null}
      </Card>
      <div className="flex flex-wrap gap-2" role="group" aria-label="What you think">
        {(Object.keys(SELLER_CHOICES) as PortalSellerChoice[]).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={picked === k}
            onClick={() => setChoice(k)}
            className={cn(
              'h-9 rounded-full border px-3.5 text-[13.5px]',
              picked === k
                ? 'border-accent bg-accent-soft font-medium text-accent-text'
                : 'border-border-strong bg-card text-text hover:bg-card-2',
            )}
            data-testid={`portal-offer-${k}`}
          >
            {SELLER_CHOICES[k]}
          </button>
        ))}
      </div>
      {choice ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'send',
              () =>
                op('realestate.portal.offer_choice', {
                  comparisonId,
                  offerId: r.offerId,
                  choice,
                  ...(words.trim() ? { words: words.trim() } : {}),
                }),
              `Sent. ${agent} will be in touch.`,
            );
          }}
        >
          <Textarea
            aria-label={`Anything to tell ${agent}?`}
            placeholder={`Anything to tell ${agent}? (optional)`}
            rows={3}
            maxLength={1000}
            value={words}
            onChange={(e) => setWords(e.target.value)}
            data-testid="portal-offer-words"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setChoice(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'send'} data-testid="portal-offer-send">
              Tell {agent}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
