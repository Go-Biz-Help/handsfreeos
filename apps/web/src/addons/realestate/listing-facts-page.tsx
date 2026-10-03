'use client';
/**
 * The home's facts on a listing (board 33, design/realestate/ListingFacts.dc.html). Chris decided (2026-10-01): three
 * ways in, the seller's questionnaire in their portal, the old listing's words pasted for the AI to read, or typed
 * by the agent; only a person confirms them. Each fact shows where it came from, with the words the AI found it in,
 * and where the seller and the old listing disagree the agent picks one.
 */
import { fmtMonthDay, localDayOf as dateOf } from '@hfos/core';
import {
  factWords,
  HOME_TYPE_KEYS,
  HOME_TYPES,
  LISTING_FACTS,
  type HomeType,
} from '@hfos/core/addons/realestate/homes';
import {
  LISTING_HOME_FACT_KEYS,
  SELLER_QUESTIONS,
  type FactFrom,
  type ListingHomeFactKey,
} from '@hfos/core/addons/realestate/listing';
import { Clock, Info } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { CardHead } from './bits';
import { DealCrumb, firstNames } from './buyer-bits';
import type { ListingChoice, ListingView } from './types';
import { useAct } from './use-act';

const thisYear = () => new Date().getFullYear();

interface Row {
  readonly checked: boolean;
  readonly value: unknown;
  readonly from: FactFrom;
  readonly quote: string | null;
  /** The agent picked, typed or ticked it here: new answers arriving don't change it. */
  readonly picked?: boolean;
}
type Rows = Partial<Record<ListingHomeFactKey, Row>>;

/** What each fact starts as: what's confirmed, else the one answer there is; a disagreement waits for a pick. */
function rowsFrom(choices: readonly ListingChoice[]): Rows {
  const rows: Rows = {};
  for (const c of choices) {
    const key = c.key as ListingHomeFactKey;
    if (c.confirmed)
      rows[key] = {
        checked: true,
        value: c.confirmed.value,
        from: c.confirmed.from,
        quote: c.confirmed.quote,
      };
    else if (c.candidates.length && !c.disagree) {
      const first = c.candidates[0]!;
      rows[key] = { checked: true, value: first.value, from: first.from, quote: first.quote };
    }
  }
  return rows;
}

export function ListingFactsPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  listing: l,
  sellers,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  listing: ListingView;
  sellers: readonly string[];
  live: boolean;
}) {
  const router = useRouter();
  const seller = firstNames(sellers) || 'The seller';
  const [rows, setRows] = useState<Rows>(() => rowsFrom(l.choices));
  const [highlights, setHighlights] = useState(l.highlights ?? '');
  // A paste read or the seller's answers arriving: what nobody has touched yet takes the new answer, and one that
  // now disagrees waits for a pick again.
  const signature = JSON.stringify(l.choices);
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    const fresh = rowsFrom(l.choices);
    setRows((now) => {
      const next: Rows = { ...fresh };
      for (const [k, r] of Object.entries(now) as [ListingHomeFactKey, Row][])
        if (r.picked) next[k] = r;
        else if (!fresh[k]) delete next[k];
      return next;
    });
  }
  const [dialog, setDialog] = useState<'paste' | 'type' | null>(null);
  const { busy, act } = useAct();

  // The AI reads the pasted words in the background: look again until it's done.
  const filling = l.pasted.state === 'filling';
  useEffect(() => {
    if (!filling) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [filling, router]);

  const choiceOf = (k: ListingHomeFactKey) => l.choices.find((c) => c.key === k);
  const toDecide = l.choices.filter(
    (c) => c.disagree && !c.confirmed && rows[c.key as ListingHomeFactKey]?.value === undefined,
  );
  const shown = LISTING_HOME_FACT_KEYS.filter(
    (k) => rows[k]?.value !== undefined || toDecide.some((c) => c.key === k),
  );
  const ticked = shown.filter((k) => rows[k]?.checked && rows[k]?.value !== undefined);
  const pick = (
    k: ListingHomeFactKey,
    c: { value: unknown; from: FactFrom; quote: string | null },
  ) =>
    setRows({
      ...rows,
      [k]: { checked: true, value: c.value, from: c.from, quote: c.quote, picked: true },
    });
  const fromBadge = (from: FactFrom) =>
    from === 'seller' ? (
      <Badge variant="accent">From {seller}’s questionnaire</Badge>
    ) : from === 'pasted' ? (
      <Badge variant="gray">From the old listing</Badge>
    ) : from === 'mls' ? (
      <Badge variant="ok">From the MLS</Badge>
    ) : (
      <Badge variant="gray">Typed by you</Badge>
    );
  const q = l.questionnaire;

  return (
    <div data-testid="realestate-listing-facts">
      <DealCrumb
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={dealName}
        here="The home’s facts"
      />
      <PageHeader
        title="The home’s facts"
        description={[
          l.street ?? dealName,
          `${shown.length} ${shown.length === 1 ? 'fact' : 'facts'}`,
          toDecide.length ? `${toDecide.length} to decide` : null,
          l.factsConfirmedAt
            ? `confirmed ${fmtMonthDay(dateOf(l.factsConfirmedAt, timeZone), thisYear())}${l.factsConfirmedBy ? ` by ${l.factsConfirmedBy.fullName}` : ''}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          live ? (
            <>
              <Button
                variant="secondary"
                onClick={() => setDialog('paste')}
                data-testid="facts-paste"
              >
                Paste the old listing
              </Button>
              <Button
                variant="secondary"
                onClick={() => setDialog('type')}
                data-testid="facts-type"
              >
                Type one in
              </Button>
              <Button
                disabled={!ticked.length}
                loading={busy === 'confirm'}
                onClick={() =>
                  void act(
                    'confirm',
                    async () =>
                      unwrap(
                        await apiBrowser().POST('/v1/commands/realestate.listing.confirm_facts', {
                          body: {
                            workspaceId,
                            dealId,
                            facts: Object.fromEntries(ticked.map((k) => [k, rows[k]!.value])),
                            sources: Object.fromEntries(ticked.map((k) => [k, rows[k]!.from])),
                            highlights: highlights.trim() || null,
                          },
                        }),
                      ),
                    'Confirmed. These are the facts the description, the page and the flyer use.',
                  )
                }
                data-testid="facts-confirm"
              >
                Confirm {ticked.length} {ticked.length === 1 ? 'fact' : 'facts'}
              </Button>
            </>
          ) : null
        }
      />

      <div className="mb-4 space-y-3">
        {filling ? (
          <Callout tone="info" icon={Info}>
            Reading the old listing’s words. The facts it finds show here in a moment, each with the
            words it came from.
          </Callout>
        ) : l.pasted.state === 'failed' ? (
          <Callout tone="warning">
            {l.pasted.failure ?? 'The old listing couldn’t be read.'} Paste it again, or type the
            facts in.
          </Callout>
        ) : null}
        {q.state === 'none' ? (
          live ? (
            <Callout tone="neutral" icon={Info}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {sellers.length
                    ? `${seller} hasn’t been asked about the home yet. They can answer in their portal.`
                    : 'Add the seller under People on the deal, and they can answer questions about the home in their portal.'}
                </span>
                {sellers.length ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === 'ask'}
                    onClick={() =>
                      void act(
                        'ask',
                        async () =>
                          unwrap(
                            await apiBrowser().POST(
                              '/v1/commands/realestate.listing.request_questionnaire',
                              { body: { workspaceId, dealId } },
                            ),
                          ),
                        `Asked. It’s on ${seller}’s to-do in their portal.`,
                      )
                    }
                    data-testid="facts-ask-seller"
                  >
                    Ask {seller}
                  </Button>
                ) : null}
              </div>
            </Callout>
          ) : null
        ) : q.state !== 'submitted' ? (
          <Callout tone="neutral" icon={Clock}>
            {q.state === 'draft'
              ? `${seller} has started answering in their portal.`
              : `Waiting for ${seller}’s answers in their portal.`}
          </Callout>
        ) : null}
        {toDecide.map((c) => (
          <Callout tone="warning" key={c.key} data-testid={`facts-conflict-${c.key}`}>
            <div className="font-semibold text-text">
              {c.candidates
                .map((x) =>
                  x.from === 'seller'
                    ? `${seller} says ${x.words}`
                    : x.from === 'pasted'
                      ? `the old listing says ${x.words}`
                      : `you typed ${x.words}`,
                )
                .join('; ')
                .replace(/^./, (m) => m.toUpperCase())}
            </div>
            <div>
              Pick the one that’s right for {c.label.toLowerCase()}, or type the right figure.
              Nothing goes on the page until you confirm it.
            </div>
            {live ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {c.candidates.map((x, i) => (
                  <Button
                    key={`${x.from}-${i}`}
                    size="sm"
                    variant={x.from === 'pasted' ? 'primary' : 'secondary'}
                    onClick={() => pick(c.key as ListingHomeFactKey, x)}
                  >
                    {x.words}
                  </Button>
                ))}
              </div>
            ) : null}
          </Callout>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">
        <Card className="overflow-x-auto p-0" data-testid="facts-table">
          {shown.length === 0 ? (
            <p className="p-5 text-[13.5px] text-text-2">
              No facts yet. Ask {seller} about the home, paste the old listing’s words for the AI to
              read, or type them in.
            </p>
          ) : (
            <table className="w-full min-w-[560px] text-left text-[13.5px]">
              <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
                <tr>
                  <th className="w-10 px-4 py-3" aria-label="Confirm" />
                  <th className="px-2 py-3 font-semibold">Fact</th>
                  <th className="px-3 py-3 font-semibold">What it says</th>
                  <th className="px-4 py-3 font-semibold">Where it came from</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((k) => {
                  const r = rows[k];
                  const c = choiceOf(k);
                  return (
                    <tr
                      key={k}
                      className="border-b border-border last:border-b-0"
                      data-testid={`fact-row-${k}`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Confirm ${LISTING_FACTS[k].label}`}
                          className="h-[18px] w-[18px] cursor-pointer accent-accent"
                          checked={!!r?.checked && r.value !== undefined}
                          disabled={!live || r?.value === undefined}
                          onChange={(e) =>
                            r &&
                            setRows({
                              ...rows,
                              [k]: { ...r, checked: e.target.checked, picked: true },
                            })
                          }
                        />
                      </td>
                      <td className="px-2 py-3 text-text-2">
                        {c?.label ?? LISTING_FACTS[k].label}
                      </td>
                      <td className={cn('px-3 py-3', r?.value === undefined && 'text-text-3')}>
                        {r?.value === undefined ? 'Pick one above' : factWords(k, r.value)}
                      </td>
                      <td className="px-4 py-3">
                        {r ? fromBadge(r.from) : null}
                        {r?.quote ? (
                          <div className="mt-1 text-[12.5px] text-text-3">“{r.quote}”</div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
        <div className="space-y-4">
          {q.state === 'submitted' && (q.updates || q.loves) ? (
            <Card className="p-4 md:p-5" data-testid="facts-seller-words">
              <CardHead title={`In ${seller}’s words`} />
              {q.updates ? (
                <div className="mb-2 text-[13.5px]">
                  <div className="text-[12.5px] text-text-3">{SELLER_QUESTIONS.updates}</div>
                  {q.updates}
                </div>
              ) : null}
              {q.loves ? (
                <div className="text-[13.5px]">
                  <div className="text-[12.5px] text-text-3">{SELLER_QUESTIONS.loves}</div>
                  {q.loves}
                </div>
              ) : null}
            </Card>
          ) : null}
          <Card className="p-4 md:p-5">
            <Field
              label="Highlights for the description"
              htmlFor="facts-highlights"
              hint="What’s been updated and what stands out, in your words: heating and cooling, a new roof. The AI’s description uses these with the facts."
            >
              <Textarea
                id="facts-highlights"
                rows={5}
                value={highlights}
                onChange={(e) => setHighlights(e.target.value)}
                disabled={!live}
              />
            </Field>
          </Card>
        </div>
      </div>
      <p className="mt-3 text-[12.5px] text-text-3">
        The AI reads only the words you paste, and every fact it finds shows the words it came from.{' '}
        {seller}’s answers come from their questionnaire in the portal. Only a person confirms a
        fact.
      </p>

      <PasteDialog
        open={dialog === 'paste'}
        onClose={() => setDialog(null)}
        workspaceId={workspaceId}
        dealId={dealId}
      />
      <TypeDialog
        open={dialog === 'type'}
        onClose={() => setDialog(null)}
        onAdd={(k, value) =>
          setRows({
            ...rows,
            [k]: { checked: true, value, from: 'agent', quote: null, picked: true },
          })
        }
      />
    </div>
  );
}

function PasteDialog({
  open,
  onClose,
  workspaceId,
  dealId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
}) {
  const [text, setText] = useState('');
  const { busy, errors, act } = useAct(() => {
    setText('');
    onClose();
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Paste the old listing"
        description="The AI reads only these words for the home’s facts, and shows each with the words it came from. You confirm them."
        className="w-[min(640px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'paste',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.listing.paste', {
                    body: { workspaceId, dealId, text },
                  }),
                ),
              'Reading it now. The facts it finds show here in a moment.',
            );
          }}
        >
          <Field label="The old listing’s words" htmlFor="paste-text" error={errors.text}>
            <Textarea
              id="paste-text"
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              data-testid="facts-paste-text"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'paste'} data-testid="facts-paste-save">
              Read it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TypeDialog({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (key: ListingHomeFactKey, value: unknown) => void;
}) {
  const [key, setKey] = useState<ListingHomeFactKey>('beds');
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const kind = LISTING_FACTS[key].kind;
  const parse = (): unknown => {
    if (kind === 'type') return raw || null;
    if (kind === 'money') return parseMoney(raw);
    const n = Number(raw.replace(/[,\s]/g, ''));
    if (!raw.trim() || !Number.isFinite(n) || n < 0) return null;
    if (kind === 'half') return Number.isInteger(n * 2) ? n : null;
    return Number.isInteger(n) ? n : null;
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Type a fact in"
        description="It’s confirmed with the rest when you confirm."
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            const value = parse();
            if (value === null || value === undefined) {
              setError(
                kind === 'half'
                  ? 'Enter a number in halves, like 2.5.'
                  : kind === 'money'
                    ? 'Enter an amount, like 45.'
                    : kind === 'type'
                      ? 'Pick the kind of home.'
                      : 'Enter a whole number.',
              );
              return;
            }
            onAdd(key, value);
            setRaw('');
            setError(null);
            onClose();
          }}
        >
          <Field label="Fact" htmlFor="type-key">
            <Select
              id="type-key"
              value={key}
              onChange={(e) => {
                setKey(e.target.value as ListingHomeFactKey);
                setRaw('');
                setError(null);
              }}
            >
              {LISTING_HOME_FACT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {LISTING_FACTS[k].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What it is" htmlFor="type-value" error={error ?? undefined}>
            {kind === 'type' ? (
              <Select id="type-value" value={raw} onChange={(e) => setRaw(e.target.value)}>
                <option value="">Pick one</option>
                {HOME_TYPE_KEYS.map((t) => (
                  <option key={t} value={t}>
                    {HOME_TYPES[t as HomeType]}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                id="type-value"
                inputMode="decimal"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                placeholder={kind === 'money' ? '$' : undefined}
                data-testid="facts-type-value"
              />
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" data-testid="facts-type-add">
              Add it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
