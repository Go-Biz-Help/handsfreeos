'use client';
/**
 * One CMA (board 19, design/realestate/Cma.dc.html): the comps the agent added, each with its adjustment and
 * whether it's used; the price range worked out from them; the summary the AI drafts for the agent to check, read
 * by both fair-housing checks; and sharing it with the client once it's final and checked.
 */
import { fmtMonthDay, money } from '@hfos/core';
import {
  adjustmentWords,
  CMA_METHOD_WORDS,
  CMA_STATUSES,
  COMP_STATUS_KEYS,
  COMP_STATUSES,
  type CompStatus,
} from '@hfos/core/addons/realestate/cma';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { parseMoney } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { CardHead, dealHref, Line } from './bits';
import { DealCrumb, firstNames, street } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import type { Cma, CmaComp } from './types';
import { useAct } from './use-act';

const thisYear = () => new Date().getFullYear();
const n = (x: number) => x.toLocaleString('en-US');

export function CmaPage({
  workspaceId,
  dealId,
  dealName,
  cma,
  clients,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  cma: Cma;
  clients: readonly string[];
  live: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const router = useRouter();
  const [comp, setComp] = useState<CmaComp | 'new' | null>(null);
  const [subject, setSubject] = useState(false);
  const [writing, setWriting] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const { busy, act } = useAct();
  const draft = cma.status === 'draft';
  const shared = cma.status === 'shared';
  const who = firstNames(clients) || 'the client';
  const s = cma.subject;
  const waitingOnChecks =
    cma.summary.state === 'drafting' || (cma.summary.state === 'ready' && !cma.fairHousing.checked);
  // The worker drafts and checks a moment later: look again until it has.
  useEffect(() => {
    if (!waitingOnChecks) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [waitingOnChecks, router]);
  const run = (
    key: string,
    path:
      | '/v1/commands/realestate.cma.finalize'
      | '/v1/commands/realestate.cma.reopen'
      | '/v1/commands/realestate.cma.request_summary'
      | '/v1/commands/realestate.cma.share',
    done: string,
  ) =>
    act(
      key,
      async () =>
        unwrap(
          // Each takes the same body: the CMA.
          await apiBrowser().POST(path as '/v1/commands/realestate.cma.finalize', {
            body: { workspaceId, cmaId: cma.id },
          }),
        ),
      done,
    );
  const startAnother = () =>
    act('another', async () => {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/realestate.cma.start', {
          // A listing's CMA is for its own home: no home of a buyer's to name.
          body: { workspaceId, dealId, homeId: cma.homeId ?? undefined, fromCmaId: cma.id },
        }),
      );
      router.push(dealHref(workspaceId, dealId, `cma/${out.cmaId}`));
    });
  const facts = [
    s.beds !== null ? `${s.beds} bd` : null,
    s.baths !== null ? `${s.baths} ba` : null,
    s.sqft !== null ? `${n(s.sqft)} sq ft` : null,
    s.listPriceCents !== null ? `listed at ${money(s.listPriceCents)}` : null,
  ].filter(Boolean);
  const r = cma.range;
  const span = r ? r.highCents - r.lowCents : 0;
  return (
    <div data-testid="realestate-cma">
      <DealCrumb
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={dealName}
        here={`CMA · ${street(s.address)}`}
      />
      <PageHeader
        title={`CMA · ${street(s.address)}`}
        description={
          <>
            {facts.length
              ? facts.join(' · ')
              : 'Add the home’s rooms and size to work out a range.'}{' '}
            {live && draft ? (
              <button
                type="button"
                className="text-accent-text hover:underline"
                onClick={() => setSubject(true)}
              >
                Change
              </button>
            ) : null}
          </>
        }
        actions={
          live ? (
            <>
              <Badge variant={draft ? 'gray' : 'ok'} className="self-center">
                CMA {cma.number} · {CMA_STATUSES[cma.status]}
              </Badge>
              {draft ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => setComp('new')}
                    data-testid="cma-add-comp"
                  >
                    Add a comp
                  </Button>
                  <Button
                    onClick={() =>
                      void run(
                        'final',
                        '/v1/commands/realestate.cma.finalize',
                        'Finalized. The range is kept as it is.',
                      )
                    }
                    loading={busy === 'final'}
                    disabled={!r}
                    data-testid="cma-finalize"
                  >
                    Finalize
                  </Button>
                </>
              ) : cma.status === 'final' ? (
                <Button
                  variant="secondary"
                  onClick={() =>
                    void run(
                      'reopen',
                      '/v1/commands/realestate.cma.reopen',
                      'Reopened. Its comps can change again.',
                    )
                  }
                  loading={busy === 'reopen'}
                >
                  Reopen
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => void startAnother()}
                  loading={busy === 'another'}
                >
                  Start another from it
                </Button>
              )}
            </>
          ) : null
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-5">
        <div className="min-w-0 space-y-4">
          <Card className="overflow-x-auto p-0" data-testid="cma-comps">
            {cma.comps.length === 0 ? (
              <p className="px-5 py-6 text-[13.5px] text-text-2">
                No comps yet. Add homes that sold nearby, with their price, date and size; the range
                is worked out from the ones you use.
              </p>
            ) : (
              <table className="w-full min-w-[560px] text-left text-[13.5px] [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_td]:px-2.5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5 [&_th]:px-2.5">
                <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Nearby</th>
                    <th className="px-3 py-3 font-semibold">Price</th>
                    <th className="px-3 py-3 font-semibold">Sold</th>
                    <th className="px-3 py-3 font-semibold">Bd · Ba · Sq ft</th>
                    <th className="px-3 py-3 font-semibold">Away</th>
                    <th className="px-3 py-3 font-semibold">Adjusted</th>
                    <th className="px-5 py-3 font-semibold">Use</th>
                  </tr>
                </thead>
                <tbody>
                  {cma.comps.map((c) => (
                    <tr
                      key={c.id}
                      className={cn(
                        'border-b border-border last:border-b-0',
                        live && draft && 'cursor-pointer hover:bg-card-2',
                        !c.used && 'text-text-3',
                      )}
                      onClick={() => live && draft && setComp(c)}
                    >
                      <td className="px-5 py-3">
                        <div className="font-semibold">{street(c.address)}</div>
                        {c.why || c.warnings.length ? (
                          <div className="text-[12px] text-warning-text">
                            {[c.why, ...c.warnings].filter(Boolean).join(' · ')}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 tabular-nums">{money(c.priceCents)}</td>
                      <td className="px-3 py-3">
                        {c.status === 'sold' && c.soldOn
                          ? fmtMonthDay(c.soldOn, thisYear())
                          : COMP_STATUSES[c.status]}
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        {[c.beds, c.baths, c.sqft !== null ? n(c.sqft) : null]
                          .map((x) => (x === null ? '—' : String(x)))
                          .join(' · ')}
                      </td>
                      <td className="px-3 py-3">
                        {c.distanceMiles !== null ? `${c.distanceMiles} mi` : '—'}
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        {c.adjustmentCents ? adjustmentWords(c.adjustmentCents) : '—'}
                      </td>
                      <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Use ${street(c.address)}`}
                          className="h-[18px] w-[18px] accent-accent"
                          checked={c.used}
                          disabled={!live || !draft || busy === `use-${c.id}`}
                          onChange={(e) =>
                            void act(`use-${c.id}`, async () =>
                              unwrap(
                                await apiBrowser().POST('/v1/commands/realestate.cma.update_comp', {
                                  body: { workspaceId, compId: c.id, used: e.target.checked },
                                }),
                              ),
                            )
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <SummaryCard
            cma={cma}
            live={live}
            busy={busy}
            writing={writing}
            setWriting={setWriting}
            onDraft={() =>
              void run('draft', '/v1/commands/realestate.cma.request_summary', 'Drafting it now.')
            }
            onSave={(summary) =>
              void act(
                'save',
                async () => {
                  unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.cma.save_summary', {
                      body: { workspaceId, cmaId: cma.id, summary },
                    }),
                  );
                  setWriting(false);
                },
                'Saved. The fair-housing checks read it now.',
              )
            }
          />
        </div>
        <div className="space-y-4">
          <Card className="p-4 md:p-5" data-testid="cma-range">
            <CardHead title="Price range" />
            {r ? (
              <>
                <Line label="Low">{money(r.lowCents)}</Line>
                <Line label={<span className="font-semibold text-text">Likely</span>}>
                  <span className="font-semibold">{money(r.likelyCents)}</span>
                </Line>
                <Line label="High">{money(r.highCents)}</Line>
                <div className="mt-2 h-1.5 rounded-full bg-card-2" aria-hidden>
                  <div
                    className="h-1.5 rounded-full bg-accent"
                    style={{
                      width: `${span ? Math.round(((r.likelyCents - r.lowCents) / span) * 100) : 50}%`,
                    }}
                  />
                </div>
                <p className="mt-2 text-[12.5px] text-text-3">
                  {CMA_METHOD_WORDS} From {r.counted} {r.counted === 1 ? 'comp' : 'comps'}, as of{' '}
                  {fmtMonthDay(cma.asOf, thisYear())}.
                </p>
              </>
            ) : (
              <p className="text-[13.5px] text-text-2">{cma.missing ?? 'Add a sold comp first.'}</p>
            )}
          </Card>
          <Card className="p-4 md:p-5" data-testid="cma-fair-housing">
            <CardHead
              title={
                cma.summary.state !== 'ready'
                  ? 'Fair housing'
                  : !cma.fairHousing.checked
                    ? 'Fair housing: checking…'
                    : cma.fairHousing.flags.length
                      ? `Fair housing: ${cma.fairHousing.flags.length} flagged`
                      : 'Fair housing: nothing flagged'
              }
            />
            {cma.fairHousing.flags.length ? (
              <ul className="mb-2 space-y-2 text-[13px]">
                {cma.fairHousing.flags.map((f, i) => (
                  <li key={i} className="rounded-menu bg-warning-soft px-3 py-2 text-warning-text">
                    <span className="font-semibold">“{f.phrase}”</span>: {f.reason} {f.safer}
                  </li>
                ))}
              </ul>
            ) : null}
            {cma.fairHousing.acknowledged ? (
              <p className="text-[13px] text-text-2">
                Kept by {cma.fairHousing.acknowledged.by?.fullName ?? 'someone'}:{' '}
                {cma.fairHousing.acknowledged.reason}
              </p>
            ) : cma.fairHousing.flags.length && live && !shared ? (
              <Button size="sm" variant="secondary" onClick={() => setKeeping(true)}>
                Keep it as it is, with a reason
              </Button>
            ) : null}
            <p className="text-[12.5px] text-text-3">
              Checked with the word list and the AI. A flag has to be fixed or kept with a reason
              before it’s shared.
            </p>
          </Card>
          <Card className="p-4 md:p-5" data-testid="cma-share">
            <CardHead title={`Share with ${who}`} />
            {shared ? (
              <p className="text-[13.5px] text-text-2">
                In {who}’s portal since{' '}
                {cma.sharedAt ? fmtMonthDay(cma.sharedAt.slice(0, 10), thisYear()) : 'today'}.
              </p>
            ) : (
              <>
                <p className="mb-3 text-[13.5px] text-text-2">
                  {cma.shareBlocked ??
                    `Once it’s shared, it’s in ${who}’s portal as a one-page summary.`}
                </p>
                {live ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!!cma.shareBlocked}
                    loading={busy === 'share'}
                    onClick={() =>
                      void run('share', '/v1/commands/realestate.cma.share', `Shared with ${who}.`)
                    }
                    data-testid="cma-share-button"
                  >
                    Share
                  </Button>
                ) : null}
              </>
            )}
          </Card>
        </div>
      </div>
      {comp ? (
        <CompDialog
          comp={comp === 'new' ? null : comp}
          onClose={() => setComp(null)}
          workspaceId={workspaceId}
          cmaId={cma.id}
        />
      ) : null}
      {subject ? (
        <SubjectDialog cma={cma} onClose={() => setSubject(false)} workspaceId={workspaceId} />
      ) : null}
      <ReasonDialog
        open={keeping}
        onOpenChange={setKeeping}
        title="Keep the summary as it is?"
        description="Say why the words flagged are fine here. It’s kept with your name."
        submit="Keep it"
        done="Kept, with your reason."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.cma.acknowledge_flags', {
              body: { workspaceId, cmaId: cma.id, reason },
            }),
          )
        }
      />
    </div>
  );
}

function SummaryCard({
  cma,
  live,
  busy,
  writing,
  setWriting,
  onDraft,
  onSave,
}: {
  cma: Cma;
  live: boolean;
  busy: string | null;
  writing: boolean;
  setWriting: (w: boolean) => void;
  onDraft: () => void;
  onSave: (text: string) => void;
}) {
  const sm = cma.summary;
  const [text, setText] = useState(sm.text ?? '');
  useEffect(() => setText(sm.text ?? ''), [sm.text]);
  const open = live && cma.status !== 'shared';
  return (
    <Card className="p-4 md:p-5" data-testid="cma-summary">
      <CardHead
        title="Summary"
        action={
          sm.state === 'ready' && sm.byAi ? (
            <Badge variant="accent">Drafted by AI · check it</Badge>
          ) : null
        }
      />
      {writing ? (
        <>
          <Textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setWriting(false)}>
              Cancel
            </Button>
            <Button onClick={() => onSave(text)} loading={busy === 'save'} disabled={!text.trim()}>
              Save
            </Button>
          </div>
        </>
      ) : sm.state === 'drafting' ? (
        <p className="flex items-center gap-2 text-[13.5px] text-text-2" role="status">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
          Drafting it from the CMA’s numbers…
        </p>
      ) : sm.state === 'ready' && sm.text ? (
        <>
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{sm.text}</p>
          {sm.unsupportedAmounts.length ? (
            <Callout tone="warning" className="mt-3">
              Check {sm.unsupportedAmounts.join(', ')}: nothing in the CMA gives{' '}
              {sm.unsupportedAmounts.length === 1 ? 'that amount' : 'those amounts'}.
            </Callout>
          ) : null}
          <p className="mt-2 text-[12.5px] text-text-3">
            {sm.byAi
              ? 'Written by AI from the comps you used. Change anything that isn’t right.'
              : 'Written by your team.'}
          </p>
        </>
      ) : (
        <p className="text-[13.5px] text-text-2">
          {sm.state === 'failed'
            ? (sm.failure ?? 'It couldn’t be drafted. Try again, or write it yourself.')
            : 'No summary yet. The AI can draft it from the range and the comps you used, for you to check.'}
        </p>
      )}
      {open && !writing ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={onDraft}
            loading={busy === 'draft'}
            disabled={!cma.range || sm.state === 'drafting'}
            data-testid="cma-draft"
          >
            {sm.state === 'ready' ? 'Draft it again' : 'Draft it with AI'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setWriting(true)}>
            {sm.state === 'ready' ? 'Edit' : 'Write it yourself'}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const numOrNull = (s: string) => (s.trim() ? Number(s.replace(/,/g, '')) : null);

function CompDialog({
  comp,
  onClose,
  workspaceId,
  cmaId,
}: {
  comp: CmaComp | null;
  onClose: () => void;
  workspaceId: string;
  cmaId: string;
}) {
  const [address, setAddress] = useState(comp?.address ?? '');
  const [price, setPrice] = useState(comp ? String(comp.priceCents / 100) : '');
  const [status, setStatus] = useState<CompStatus>(comp?.status ?? 'sold');
  const [soldOn, setSoldOn] = useState(comp?.soldOn ?? '');
  const [beds, setBeds] = useState(comp?.beds?.toString() ?? '');
  const [baths, setBaths] = useState(comp?.baths?.toString() ?? '');
  const [sqft, setSqft] = useState(comp?.sqft?.toString() ?? '');
  const [year, setYear] = useState(comp?.yearBuilt?.toString() ?? '');
  const [away, setAway] = useState(comp?.distanceMiles?.toString() ?? '');
  const [note, setNote] = useState(comp?.note ?? '');
  const [adj, setAdj] = useState<{ label: string; amount: string }[]>(
    comp?.adjustments.map((a) => ({ label: a.label, amount: String(a.cents / 100) })) ?? [],
  );
  const { busy, errors, act } = useAct(onClose);
  const fields = {
    address,
    priceCents: parseMoney(price) ?? 0,
    status,
    soldOn: soldOn || null,
    beds: numOrNull(beds),
    baths: numOrNull(baths),
    sqft: numOrNull(sqft),
    yearBuilt: numOrNull(year),
    distanceMiles: numOrNull(away),
  };
  const save = () =>
    act(
      'save',
      async () =>
        comp
          ? unwrap(
              await apiBrowser().POST('/v1/commands/realestate.cma.update_comp', {
                body: {
                  workspaceId,
                  compId: comp.id,
                  ...fields,
                  note: note.trim() || null,
                  adjustments: adj
                    .filter((a) => a.label.trim() && a.amount.trim())
                    .map((a) => ({
                      label: a.label.trim(),
                      cents: Math.round(Number(a.amount.replace(/[$,\s]/g, '')) * 100),
                    })),
                },
              }),
            )
          : unwrap(
              await apiBrowser().POST('/v1/commands/realestate.cma.add_comp', {
                body: { workspaceId, cmaId, ...fields, note: note.trim() || undefined },
              }),
            ),
      comp ? 'Saved.' : 'Added.',
    );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={comp ? street(comp.address) : 'Add a comp'}
        description="A home nearby that sold, is pending or is for sale, with its own facts."
        className="max-h-[92dvh] w-[min(640px,calc(100vw-32px))] overflow-y-auto"
      >
        <form
          className="mt-4 grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field
            label="Address"
            htmlFor="comp-address"
            error={errors.address}
            className="sm:col-span-3"
          >
            <Input
              id="comp-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              autoFocus={!comp}
            />
          </Field>
          <Field label="Price" htmlFor="comp-price" error={errors.priceCents}>
            <Input
              id="comp-price"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="$"
            />
          </Field>
          <Field label="It’s" htmlFor="comp-status">
            <Select
              id="comp-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as CompStatus)}
            >
              {COMP_STATUS_KEYS.map((k) => (
                <option key={k} value={k}>
                  {COMP_STATUSES[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Sold on" htmlFor="comp-sold" error={errors.soldOn}>
            <Input
              id="comp-sold"
              type="date"
              value={soldOn}
              onChange={(e) => setSoldOn(e.target.value)}
              disabled={status !== 'sold'}
            />
          </Field>
          <Field label="Beds" htmlFor="comp-beds" error={errors.beds}>
            <Input
              id="comp-beds"
              inputMode="numeric"
              value={beds}
              onChange={(e) => setBeds(e.target.value)}
            />
          </Field>
          <Field label="Baths" htmlFor="comp-baths" error={errors.baths}>
            <Input
              id="comp-baths"
              inputMode="decimal"
              value={baths}
              onChange={(e) => setBaths(e.target.value)}
            />
          </Field>
          <Field label="Square feet" htmlFor="comp-sqft" error={errors.sqft}>
            <Input
              id="comp-sqft"
              inputMode="numeric"
              value={sqft}
              onChange={(e) => setSqft(e.target.value)}
            />
          </Field>
          <Field label="Year built" htmlFor="comp-year" error={errors.yearBuilt}>
            <Input
              id="comp-year"
              inputMode="numeric"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </Field>
          <Field label="Miles away" htmlFor="comp-away" error={errors.distanceMiles}>
            <Input
              id="comp-away"
              inputMode="decimal"
              value={away}
              onChange={(e) => setAway(e.target.value)}
            />
          </Field>
          <Field label="Note" htmlFor="comp-note" className="sm:col-span-3">
            <Input id="comp-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {comp ? (
            <div className="sm:col-span-3">
              <div className="mb-1.5 text-[13px] font-medium">Adjustments</div>
              <p className="mb-2 text-[12.5px] text-text-3">
                What it’s worth more (+) or less (−) than the home for, like “No garage” −8,000.
              </p>
              {adj.map((a, i) => (
                <div key={i} className="mb-2 flex gap-2">
                  <Input
                    aria-label="What for"
                    value={a.label}
                    onChange={(e) =>
                      setAdj(adj.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                    }
                    className="flex-1"
                  />
                  <Input
                    aria-label="Amount"
                    inputMode="decimal"
                    value={a.amount}
                    onChange={(e) =>
                      setAdj(adj.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                    }
                    className="w-32"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Take it off"
                    onClick={() => setAdj(adj.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                </div>
              ))}
              {adj.length < 8 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAdj([...adj, { label: '', amount: '' }])}
                >
                  <Plus className="h-4 w-4" strokeWidth={1.75} /> Add an adjustment
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2 sm:col-span-3">
            {comp ? (
              <Button
                variant="ghost"
                className="text-danger-text"
                loading={busy === 'remove'}
                onClick={() =>
                  void act(
                    'remove',
                    async () =>
                      unwrap(
                        await apiBrowser().POST('/v1/commands/realestate.cma.remove_comp', {
                          body: { workspaceId, compId: comp.id },
                        }),
                      ),
                    'Taken off.',
                  )
                }
              >
                Take it off
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === 'save'} data-testid="comp-save">
                {comp ? 'Save' : 'Add it'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SubjectDialog({
  cma,
  onClose,
  workspaceId,
}: {
  cma: Cma;
  onClose: () => void;
  workspaceId: string;
}) {
  const s = cma.subject;
  const [beds, setBeds] = useState(s.beds?.toString() ?? '');
  const [baths, setBaths] = useState(s.baths?.toString() ?? '');
  const [sqft, setSqft] = useState(s.sqft?.toString() ?? '');
  const [price, setPrice] = useState(s.listPriceCents ? String(s.listPriceCents / 100) : '');
  const [year, setYear] = useState(s.yearBuilt?.toString() ?? '');
  const { busy, errors, act } = useAct(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={street(s.address)} description="The home the CMA is for.">
        <form
          className="mt-4 grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'save',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.cma.set_subject', {
                    body: {
                      workspaceId,
                      cmaId: cma.id,
                      beds: numOrNull(beds),
                      baths: numOrNull(baths),
                      sqft: numOrNull(sqft),
                      listPriceCents: price.trim() ? parseMoney(price) : null,
                      yearBuilt: numOrNull(year),
                    },
                  }),
                ),
              'Saved.',
            );
          }}
        >
          <Field label="Beds" htmlFor="sub-beds" error={errors.beds}>
            <Input
              id="sub-beds"
              inputMode="numeric"
              value={beds}
              onChange={(e) => setBeds(e.target.value)}
            />
          </Field>
          <Field label="Baths" htmlFor="sub-baths" error={errors.baths}>
            <Input
              id="sub-baths"
              inputMode="decimal"
              value={baths}
              onChange={(e) => setBaths(e.target.value)}
            />
          </Field>
          <Field label="Square feet" htmlFor="sub-sqft" error={errors.sqft}>
            <Input
              id="sub-sqft"
              inputMode="numeric"
              value={sqft}
              onChange={(e) => setSqft(e.target.value)}
            />
          </Field>
          <Field label="Year built" htmlFor="sub-year" error={errors.yearBuilt}>
            <Input
              id="sub-year"
              inputMode="numeric"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </Field>
          <Field
            label="List price"
            htmlFor="sub-price"
            error={errors.listPriceCents}
            className="col-span-2"
          >
            <Input
              id="sub-price"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="$"
            />
          </Field>
          <div className="col-span-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'save'}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
