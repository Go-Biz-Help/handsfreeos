'use client';
/**
 * Adding a home and checking its facts (board 14, design/realestate/AddHome.dc.html), and one home's own dialog:
 * its facts, where it stands, what the clients said, and what to do next with it (a tour, a CMA, an offer).
 *
 * Pasted listing text is read by the AI on the worker, so the dialog waits for it, then shows each fact with the
 * words it was found in. Nothing is kept as a fact until a person confirms it.
 */
import { fmtDateShort, localDayOf as dateOf, money } from '@hfos/core';
import {
  HOME_STATUSES,
  HOME_TYPE_KEYS,
  HOME_TYPES,
  LISTING_FACTS,
  type HomeStatus,
  type HomeType,
  type ListingFactKey,
} from '@hfos/core/addons/realestate/homes';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { parseMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { dealHref } from './bits';
import { FitList, homeFactsLine, street } from './buyer-bits';
import type { Home } from './types';
import { useAct } from './use-act';

type Facts = Home['facts'];
type Values = Partial<Record<ListingFactKey, string>>;

/** The facts as the cards group them, the board's way. */
const GROUPS: readonly (readonly ListingFactKey[])[] = [
  ['price_cents'],
  ['beds', 'baths'],
  ['sqft', 'lot_sqft'],
  ['year_built', 'garage_spaces'],
  ['hoa_monthly_cents'],
  ['property_type'],
];

const isMoney = (k: ListingFactKey) => LISTING_FACTS[k].kind === 'money';

function toValues(facts: Facts): Values {
  const v: Values = {};
  for (const k of Object.keys(LISTING_FACTS) as ListingFactKey[]) {
    const x = facts[k];
    if (x === undefined || x === null) continue;
    v[k] = isMoney(k) ? String((x as number) / 100) : String(x);
  }
  return v;
}

/** The values typed, as facts; or what's wrong with one. */
function toFacts(values: Values, keys: readonly ListingFactKey[]): Facts | string {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const raw = values[k]?.trim();
    if (!raw) continue;
    const label = LISTING_FACTS[k].label;
    if (k === 'property_type') {
      out[k] = raw;
      continue;
    }
    if (isMoney(k)) {
      const cents = parseMoney(raw);
      if (cents === null) return `${label}: enter an amount, like 409,000.`;
      out[k] = cents;
      continue;
    }
    const n = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) return `${label}: enter a number.`;
    if (k === 'baths' ? !Number.isInteger(n * 2) : !Number.isInteger(n))
      return k === 'baths' ? 'Baths go in halves, like 2.5.' : `${label}: enter a whole number.`;
    out[k] = n;
  }
  return out as Facts;
}

const num = (s: string | undefined) => Number((s ?? '').replace(/,/g, ''));

/** A card's title: "3 beds · 2 baths", "Built 1998 · 2-car garage". */
function groupWords(keys: readonly ListingFactKey[], v: Values): string {
  const parts = keys
    .filter((k) => v[k]?.trim())
    .map((k) => {
      const s = v[k]!.trim();
      switch (k) {
        case 'price_cents':
          return money(parseMoney(s) ?? 0);
        case 'hoa_monthly_cents':
          return `HOA ${money(parseMoney(s) ?? 0)} a month`;
        case 'beds':
          return `${s} ${num(s) === 1 ? 'bed' : 'beds'}`;
        case 'baths':
          return `${s} ${num(s) === 1 ? 'bath' : 'baths'}`;
        case 'sqft':
          return `${num(s).toLocaleString('en-US')} sq ft`;
        case 'lot_sqft':
          return `${num(s).toLocaleString('en-US')} sq ft lot`;
        case 'year_built':
          return `Built ${s}`;
        case 'garage_spaces':
          return `${s}-car garage`;
        case 'property_type':
          return HOME_TYPES[s as HomeType] ?? s;
      }
    });
  return parts.join(' · ');
}

/**
 * The facts to check, each card with the words it was found in, ticked to keep; or every fact as a field when the
 * agent types them in. `onConfirm` gets the facts kept.
 */
function FactsEditor({
  facts,
  sources,
  fromAi,
  busy,
  confirmWord,
  onConfirm,
  onLater,
  laterWord,
}: {
  facts: Facts;
  sources: Readonly<Record<string, string>>;
  fromAi: boolean;
  busy: boolean;
  confirmWord: (n: number) => string;
  onConfirm: (facts: Facts) => void;
  onLater: () => void;
  laterWord: string;
}) {
  const [values, setValues] = useState<Values>(() => toValues(facts));
  const [editing, setEditing] = useState(!fromAi);
  const groups = GROUPS.filter((g) => g.some((k) => values[k]?.trim()));
  const [kept, setKept] = useState<ReadonlySet<number>>(() => new Set(GROUPS.map((_, i) => i)));
  const [problem, setProblem] = useState<string | null>(null);
  const keys = editing
    ? (Object.keys(LISTING_FACTS) as ListingFactKey[])
    : GROUPS.flatMap((g, i) => (kept.has(i) ? g : []));
  // Each card is one fact to the agent ("3 beds · 2 baths"); typed in, each field is.
  const count = editing
    ? keys.filter((k) => values[k]?.trim()).length
    : GROUPS.filter((g, i) => kept.has(i) && g.some((k) => values[k]?.trim())).length;
  const confirm = () => {
    const out = toFacts(values, keys);
    if (typeof out === 'string') return setProblem(out);
    setProblem(null);
    onConfirm(out);
  };
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-3">
          {editing ? 'The home’s facts' : 'Facts from the text · check each one'}
        </h3>
        <button
          type="button"
          className="text-[12.5px] text-accent-text hover:underline"
          onClick={() => setEditing(!editing)}
        >
          {editing ? (fromAi ? 'Back to the found facts' : '') : 'Change a number'}
        </button>
      </div>
      {editing ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(LISTING_FACTS) as ListingFactKey[]).map((k) =>
            k === 'property_type' ? (
              <Field key={k} label={LISTING_FACTS[k].label} htmlFor={`fact-${k}`}>
                <Select
                  id={`fact-${k}`}
                  value={values[k] ?? ''}
                  onChange={(e) => setValues({ ...values, [k]: e.target.value })}
                >
                  <option value="">Not known</option>
                  {HOME_TYPE_KEYS.map((t) => (
                    <option key={t} value={t}>
                      {HOME_TYPES[t]}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field key={k} label={LISTING_FACTS[k].label} htmlFor={`fact-${k}`}>
                <Input
                  id={`fact-${k}`}
                  inputMode="decimal"
                  value={values[k] ?? ''}
                  placeholder={isMoney(k) ? '$' : ''}
                  onChange={(e) => setValues({ ...values, [k]: e.target.value })}
                />
              </Field>
            ),
          )}
        </div>
      ) : groups.length === 0 ? (
        <Callout tone="neutral">
          No facts were found in the text. Type them in from the listing, or check them later.
        </Callout>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {GROUPS.map((g, i) => {
            if (!g.some((k) => values[k]?.trim())) return null;
            const on = kept.has(i);
            const quote = g.map((k) => sources[k]).find(Boolean);
            return (
              <button
                key={g.join()}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = new Set(kept);
                  if (on) next.delete(i);
                  else next.add(i);
                  setKept(next);
                }}
                className="flex items-start justify-between gap-3 rounded-menu bg-card-2 px-3 py-2.5 text-left hover:bg-card-3"
                data-testid={`fact-card-${g[0]}`}
              >
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold">{groupWords(g, values)}</div>
                  <div className="truncate text-[12.5px] text-text-2">
                    {g.length === 1 && g[0] === 'price_cents' ? 'Price · ' : ''}
                    {quote ? `“${quote}”` : 'Typed in'}
                  </div>
                </div>
                <span
                  className={cn(
                    'mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full border',
                    on ? 'border-success bg-success text-on-solid' : 'border-border-strong bg-card',
                  )}
                >
                  {on ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {problem ? (
        <p role="alert" className="mt-2 text-[12.5px] text-danger-text">
          {problem}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px] text-text-3">
          {fromAi && !editing
            ? 'Written by AI from the text above. Nothing is kept until you confirm it.'
            : 'Check them against the listing.'}
        </p>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onLater}>
            {laterWord}
          </Button>
          <Button
            onClick={confirm}
            loading={busy}
            disabled={count === 0}
            data-testid="facts-confirm"
          >
            {confirmWord(count)}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Reads the deal's homes until the AI is done with this one: its facts, or why it couldn't. */
function useFilled(workspaceId: string, dealId: string, homeId: string | null) {
  const [home, setHome] = useState<Home | null>(null);
  useEffect(() => {
    // Closed and opened again: a fresh start.
    if (!homeId) return setHome(null);
    let stop = false;
    let tries = 0;
    const look = async () => {
      if (stop) return;
      tries += 1;
      try {
        const got = unwrap(
          await apiBrowser().POST('/v1/queries/realestate.homes', {
            body: { workspaceId, dealId, includeRemoved: false },
          }),
        );
        const h = got.homes.find((x) => x.id === homeId) ?? null;
        if (h && (h.factsState !== 'filling' || tries >= 40)) {
          if (!stop) setHome(h);
          return;
        }
      } catch {
        // Try again in a moment.
      }
      if (!stop) setTimeout(() => void look(), 1500);
    };
    void look();
    return () => {
      stop = true;
    };
  }, [workspaceId, dealId, homeId]);
  return home;
}

export function AddHomeDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  dealId: string;
}) {
  const router = useRouter();
  const [address, setAddress] = useState('');
  const [link, setLink] = useState('');
  const [text, setText] = useState('');
  const [homeId, setHomeId] = useState<string | null>(null);
  const filled = useFilled(workspaceId, dealId, homeId);
  const { busy, errors, act } = useAct();
  const close = () => {
    onOpenChange(false);
    setAddress('');
    setLink('');
    setText('');
    setHomeId(null);
  };
  const add = () =>
    act('add', async () => {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/realestate.home.add', {
          body: {
            workspaceId,
            dealId,
            address,
            link: link.trim() || undefined,
            pastedText: text.trim() || undefined,
          },
        }),
      );
      if (out.filling) setHomeId(out.homeId);
      else close();
    });
  const reading = !!homeId && !filled;
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        title="Add a home"
        className="max-h-[92dvh] w-[min(680px,calc(100vw-32px))] overflow-y-auto"
      >
        <form
          className="mt-3 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!homeId) void add();
          }}
        >
          <Field label="Address" htmlFor="home-address" error={errors.address}>
            <Input
              id="home-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="418 Maple Ave, Austin, TX 78745"
              autoFocus
              disabled={!!homeId}
              invalid={!!errors.address}
              data-testid="home-address"
            />
          </Field>
          <Field
            label="The listing’s text (optional)"
            htmlFor="home-text"
            hint="Paste it from the listing site. A link is kept for you to open, but HandsFreeOS never reads listing sites."
            error={errors.pastedText}
          >
            <Textarea
              id="home-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={!!homeId}
              rows={4}
              data-testid="home-text"
            />
          </Field>
          <Field label="Link (optional)" htmlFor="home-link" error={errors.link}>
            <Input
              id="home-link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://"
              disabled={!!homeId}
              invalid={!!errors.link}
            />
          </Field>
          {!homeId ? (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === 'add'} data-testid="home-add">
                {text.trim() ? 'Add and read the text' : 'Add the home'}
              </Button>
            </div>
          ) : null}
        </form>
        {reading ? (
          <div className="mt-4 flex items-center gap-2 text-[13.5px] text-text-2" role="status">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
            Reading the listing’s text for its facts…
          </div>
        ) : null}
        {filled?.factsState === 'failed' ? (
          <Callout tone="warning" className="mt-4">
            {filled.factsFailure ??
              'The text didn’t say the home’s facts clearly. Type them in below.'}
          </Callout>
        ) : null}
        {filled && filled.factsState !== 'filling' ? (
          <FactsEditor
            facts={filled.facts}
            sources={filled.factSources}
            fromAi={filled.factsState === 'suggested'}
            busy={busy === 'confirm'}
            confirmWord={(n) => (n === 1 ? 'Confirm 1 fact' : `Confirm ${n} facts`)}
            laterWord="Check later"
            onLater={() => {
              close();
              router.refresh();
            }}
            onConfirm={(facts) =>
              void act(
                'confirm',
                async () => {
                  unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.home.confirm_facts', {
                      body: { workspaceId, homeId: filled.id, facts },
                    }),
                  );
                  close();
                },
                'Added, with its facts.',
              )
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const STATUS_CHOICES: readonly HomeStatus[] = [
  'saved',
  'shortlisted',
  'toured',
  'offered',
  'passed',
];

export function HomeDialog({
  home,
  onOpenChange,
  workspaceId,
  dealId,
  timeZone,
  live,
}: {
  home: Home | null;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  dealId: string;
  timeZone: string;
  live: boolean;
}) {
  const router = useRouter();
  const { busy, act } = useAct();
  const [checking, setChecking] = useState(false);
  useEffect(() => setChecking(false), [home?.id]);
  const status = (s: HomeStatus) =>
    act(
      's',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.home.set_status', {
            body: { workspaceId, homeId: home!.id, status: s },
          }),
        ),
      s === 'removed' ? 'Removed from the deal. It’s kept in its history.' : 'Saved.',
    );
  const startCma = () =>
    act('cma', async () => {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/realestate.cma.start', {
          body: { workspaceId, dealId, homeId: home!.id },
        }),
      );
      router.push(dealHref(workspaceId, dealId, `cma/${out.cmaId}`));
    });
  const facts = useMemo(() => (home ? homeFactsLine(home.facts) : ''), [home]);
  if (!home) return null;
  const added = home.addedByClient
    ? `Added by ${home.addedByClient.name}`
    : home.addedBy
      ? `Added by ${home.addedBy.fullName}`
      : 'Added';
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title={street(home.address)}
        description={`${home.address} · ${added} ${fmtDateShort(dateOf(home.addedAt, timeZone))}`}
        className="max-h-[92dvh] w-[min(640px,calc(100vw-32px))] overflow-y-auto"
      >
        <div className="mt-4 space-y-4" data-testid="home-dialog">
          <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
            <span className="font-semibold">{facts || 'No facts yet'}</span>
            {home.factsState === 'confirmed' ? (
              <Badge variant="ok">Facts confirmed</Badge>
            ) : home.factsState === 'suggested' ? (
              <Badge variant="pending">Facts to confirm</Badge>
            ) : home.factsState === 'filling' ? (
              <Badge variant="gray">Reading the listing…</Badge>
            ) : null}
            {home.link ? (
              <a
                href={home.link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent-text hover:underline"
              >
                Listing <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
              </a>
            ) : null}
          </div>
          <FitList fit={home.fit} />
          {home.reactions.length ? (
            <ul className="space-y-1 text-[13.5px]">
              {home.reactions.map((r) => (
                <li key={r.personId}>
                  <span className="font-medium">{r.name}</span>{' '}
                  {r.reaction === 'saved' ? 'saved it' : 'passed on it'}
                  {r.note ? `: “${r.note}”` : ''}
                </li>
              ))}
            </ul>
          ) : null}
          {checking || (live && home.factsState === 'suggested') ? (
            <FactsEditor
              facts={home.facts}
              sources={home.factSources}
              fromAi={home.factsState === 'suggested'}
              busy={busy === 'confirm'}
              confirmWord={(n) => (n === 1 ? 'Confirm 1 fact' : `Confirm ${n} facts`)}
              laterWord={checking ? 'Cancel' : 'Check later'}
              onLater={() => (checking ? setChecking(false) : onOpenChange(false))}
              onConfirm={(f) =>
                void act(
                  'confirm',
                  async () => {
                    unwrap(
                      await apiBrowser().POST('/v1/commands/realestate.home.confirm_facts', {
                        body: { workspaceId, homeId: home.id, facts: f },
                      }),
                    );
                    setChecking(false);
                  },
                  'Facts confirmed.',
                )
              }
            />
          ) : null}
          {live ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <label htmlFor="home-status" className="text-[13px] text-text-2">
                Where it stands
              </label>
              <Select
                id="home-status"
                selectSize="sm"
                className="w-auto"
                value={home.status}
                onChange={(e) => void status(e.target.value as HomeStatus)}
                disabled={busy === 's'}
                data-testid="home-status"
              >
                {[
                  ...STATUS_CHOICES,
                  ...(home.status === 'removed' ? ['removed' as const] : []),
                ].map((s) => (
                  <option key={s} value={s}>
                    {HOME_STATUSES[s]}
                  </option>
                ))}
              </Select>
              {!checking && home.factsState !== 'suggested' ? (
                <Button size="sm" variant="ghost" onClick={() => setChecking(true)}>
                  {home.factsState === 'confirmed' ? 'Change its facts' : 'Type in its facts'}
                </Button>
              ) : null}
              <div className="ml-auto flex flex-wrap gap-2">
                <ButtonLink
                  size="sm"
                  variant="secondary"
                  href={dealHref(workspaceId, dealId, `tours?plan=1&home=${home.id}`)}
                >
                  Plan a tour
                </ButtonLink>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void startCma()}
                  loading={busy === 'cma'}
                >
                  Start a CMA
                </Button>
                <ButtonLink
                  size="sm"
                  variant="primary"
                  href={dealHref(workspaceId, dealId, `offers?start=${home.id}`)}
                >
                  Make an offer
                </ButtonLink>
              </div>
            </div>
          ) : null}
          {live && home.status !== 'removed' ? (
            <button
              type="button"
              className="text-[12.5px] text-text-3 hover:text-danger-text hover:underline"
              onClick={() =>
                confirm(
                  `Take ${street(home.address)} off this deal? It’s kept in the deal’s history.`,
                ) && void status('removed')
              }
            >
              Take it off the deal
            </button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
