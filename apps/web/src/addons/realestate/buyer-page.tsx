'use client';
/**
 * What the buyer wants (board 16, design/realestate/BuyerMemory.dc.html): the AI's suggestions from the clients'
 * own messages and calls, each with its quote, for the agent to confirm or turn down; what's confirmed; and the
 * profile every home is checked against. Nothing the AI suggests counts until a person confirms it, and anything
 * about who lives somewhere is never kept: only how many were left out.
 */
import { dayTime, fmtMonthDay } from '@hfos/core';
import { HOME_TYPE_KEYS, HOME_TYPES, type HomeType } from '@hfos/core/addons/realestate/homes';
import {
  MEMORY_KIND_KEYS,
  MEMORY_KINDS,
  type MemoryKind,
} from '@hfos/core/addons/realestate/memory';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { parseMoney } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { CardHead, Line } from './bits';
import { DealCrumb, firstNames, profileLines } from './buyer-bits';
import type { BuyerProfile, MemoryItem, MemoryList } from './types';
import { useAct } from './use-act';

const SOURCE_WORDS: Readonly<Record<MemoryItem['sourceKind'], string>> = {
  message: 'From a message',
  call: 'From a call',
  note: 'From a note',
  typed: 'Typed in',
};

export function BuyerPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  clients,
  profile,
  memory,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  clients: readonly string[];
  profile: BuyerProfile | null;
  memory: MemoryList;
  live: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const { busy, act } = useAct();
  const who = firstNames(clients) || 'the client';
  const waiting = memory.items.filter((i) => i.status === 'suggested');
  const confirmed = memory.items.filter((i) => i.status === 'confirmed');
  const lines = profileLines(profile);
  const decide = (item: MemoryItem, decision: 'confirm' | 'reject' | 'retire', words?: string) =>
    act(
      `${decision}-${item.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.memory.decide', {
            body: { workspaceId, itemId: item.id, decision, words },
          }),
        ),
      decision === 'confirm'
        ? 'Confirmed. It’s kept with the words it came from.'
        : decision === 'reject'
          ? 'Not kept.'
          : 'Marked no longer true.',
    );
  return (
    <div data-testid="realestate-buyer">
      <DealCrumb
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={dealName}
        here="What they want"
      />
      <PageHeader
        title="What they want"
        description={`${dealName} · the AI suggests from ${who}’s messages and calls; nothing counts until you confirm it`}
        actions={
          live ? (
            <>
              <Button
                variant="ghost"
                loading={busy === 'request'}
                onClick={() =>
                  void act(
                    'request',
                    async () =>
                      unwrap(
                        await apiBrowser().POST('/v1/commands/realestate.memory.request', {
                          body: { workspaceId, dealId },
                        }),
                      ),
                    'The AI will read what’s new in a few minutes.',
                  )
                }
              >
                Read what’s new
              </Button>
              <Button variant="secondary" onClick={() => setAdding(true)} data-testid="memory-add">
                Add one yourself
              </Button>
            </>
          ) : null
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-5">
        <div className="min-w-0 space-y-4">
          <Card className="p-4 md:p-5" data-testid="memory-waiting">
            <CardHead
              title={
                waiting.length === 0
                  ? 'Nothing to confirm'
                  : `${waiting.length} ${waiting.length === 1 ? 'suggestion' : 'suggestions'} to confirm`
              }
            />
            {waiting.length === 0 ? (
              <p className="text-[13.5px] text-text-2">
                When {who} {clients.length > 1 ? 'say' : 'says'} what they want in a message or on a
                call, the AI suggests it here with their words, for you to confirm.
              </p>
            ) : (
              <ul className="space-y-3">
                {waiting.map((i) => (
                  <Suggestion
                    key={i.id}
                    item={i}
                    timeZone={timeZone}
                    live={live}
                    busy={busy}
                    onDecide={(d, words) => void decide(i, d, words)}
                  />
                ))}
              </ul>
            )}
            {memory.protectedDropped > 0 ? (
              <Callout tone="warning" icon={ShieldCheck} className="mt-3">
                {memory.protectedDropped === 1
                  ? '1 suggestion was left out because it was about who lives there.'
                  : `${memory.protectedDropped} suggestions were left out because they were about who lives there.`}{' '}
                Fair housing rules don’t let a home search use it, so it isn’t kept.
              </Callout>
            ) : null}
          </Card>
        </div>
        <div className="space-y-4">
          <Card className="p-4 md:p-5" data-testid="buyer-profile">
            <CardHead
              title="Confirmed"
              action={
                live ? (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                    {profile ? 'Edit' : 'Add their budget and rooms'}
                  </Button>
                ) : null
              }
            />
            {lines.map((l) => (
              <Line key={l.label} label={l.label}>
                {l.value}
              </Line>
            ))}
            {confirmed.length ? (
              <ul className="mt-2 space-y-2 border-t border-border pt-3">
                {confirmed.map((i) => (
                  <li key={i.id} className="text-[13.5px]">
                    <div className="flex items-start justify-between gap-2">
                      <span>
                        <span className="text-text-2">{MEMORY_KINDS[i.kind]}:</span> {i.words}
                      </span>
                      {live ? (
                        <button
                          type="button"
                          className="flex-none text-[12px] text-text-3 hover:text-text hover:underline"
                          onClick={() => void decide(i, 'retire')}
                        >
                          No longer true
                        </button>
                      ) : null}
                    </div>
                    {i.quote ? <div className="text-[12.5px] text-text-3">“{i.quote}”</div> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {!lines.length && !confirmed.length ? (
              <p className="text-[13.5px] text-text-2">Nothing confirmed yet.</p>
            ) : (
              <p className="mt-3 text-[12.5px] text-text-3">
                {profile?.updatedBy
                  ? `Budget and rooms last changed by ${profile.updatedBy.fullName}, ${fmtMonthDay(profile.updatedAt.slice(0, 10), new Date().getFullYear())}. `
                  : ''}
                Each thing confirmed keeps the words it came from and who confirmed it.
              </p>
            )}
          </Card>
        </div>
      </div>
      <AddMemoryDialog
        open={adding}
        onOpenChange={setAdding}
        workspaceId={workspaceId}
        dealId={dealId}
      />
      <ProfileDialog
        open={editing}
        onOpenChange={setEditing}
        workspaceId={workspaceId}
        dealId={dealId}
        profile={profile}
      />
    </div>
  );
}

function Suggestion({
  item,
  timeZone,
  live,
  busy,
  onDecide,
}: {
  item: MemoryItem;
  timeZone: string;
  live: boolean;
  busy: string | null;
  onDecide: (d: 'confirm' | 'reject', words?: string) => void;
}) {
  const [words, setWords] = useState<string | null>(null);
  return (
    <li className="rounded-menu border border-border p-3.5" data-testid="memory-suggestion">
      <div className="flex items-start justify-between gap-3">
        {words === null ? (
          <div className="text-[14px] font-semibold">
            {MEMORY_KINDS[item.kind]}: {item.words}
          </div>
        ) : (
          <Input
            inputSize="sm"
            value={words}
            onChange={(e) => setWords(e.target.value)}
            aria-label="What to remember"
            autoFocus
          />
        )}
        <Badge variant="gray">{MEMORY_KINDS[item.kind]}</Badge>
      </div>
      {item.quote ? (
        <blockquote className="mt-2 border-l-2 border-border-strong pl-3 text-[13.5px] text-text-2">
          “{item.quote}”
        </blockquote>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] text-text-3">
          {SOURCE_WORDS[item.sourceKind]} · {dayTime(item.createdAt, timeZone)}
        </span>
        {live ? (
          <div className="flex gap-1.5">
            {words === null ? (
              <Button size="sm" variant="ghost" onClick={() => setWords(item.words)}>
                Change the words
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDecide('reject')}
              loading={busy === `reject-${item.id}`}
            >
              Not right
            </Button>
            <Button
              size="sm"
              onClick={() =>
                onDecide('confirm', words && words.trim() !== item.words ? words.trim() : undefined)
              }
              loading={busy === `confirm-${item.id}`}
              data-testid="memory-confirm"
            >
              Confirm
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function AddMemoryDialog({
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
  const [kind, setKind] = useState<MemoryKind>('must_have');
  const [words, setWords] = useState('');
  const { busy, errors, act } = useAct(() => {
    onOpenChange(false);
    setWords('');
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Remember something they said"
        description="It’s kept as confirmed, in your words. Say what the home needs, never who lives nearby."
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'add',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.memory.add', {
                    body: { workspaceId, dealId, kind, words },
                  }),
                ),
              'Kept.',
            );
          }}
        >
          <Field label="What kind" htmlFor="memory-kind">
            <Select
              id="memory-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as MemoryKind)}
            >
              {MEMORY_KIND_KEYS.map((k) => (
                <option key={k} value={k}>
                  {MEMORY_KINDS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What to remember" htmlFor="memory-words" error={errors.words}>
            <Input
              id="memory-words"
              value={words}
              onChange={(e) => setWords(e.target.value)}
              placeholder="A fenced yard for the dog"
              invalid={!!errors.words}
              autoFocus
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'add'}>
              Keep it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const lines = (s: string) =>
  s
    .split(/\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);

function ProfileDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  profile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  dealId: string;
  profile: BuyerProfile | null;
}) {
  const dollars = (c: number | null | undefined) =>
    c === null || c === undefined ? '' : String(c / 100);
  const [min, setMin] = useState(dollars(profile?.budgetMinCents));
  const [max, setMax] = useState(dollars(profile?.budgetMaxCents));
  const [areas, setAreas] = useState(profile?.areas.join(', ') ?? '');
  const [types, setTypes] = useState<readonly string[]>(profile?.homeTypes ?? []);
  const [beds, setBeds] = useState(profile?.bedsMin?.toString() ?? '');
  const [baths, setBaths] = useState(profile?.bathsMin?.toString() ?? '');
  const [sqft, setSqft] = useState(profile?.sqftMin?.toString() ?? '');
  const [moveBy, setMoveBy] = useState(profile?.moveBy ?? '');
  const [must, setMust] = useState(profile?.mustHaves.join('\n') ?? '');
  const [never, setNever] = useState(profile?.dealBreakers.join('\n') ?? '');
  const { busy, errors, act } = useAct(() => onOpenChange(false));
  const n = (s: string) => (s.trim() ? Number(s.replace(/,/g, '')) : null);
  const save = () =>
    act(
      'save',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.buyer_profile.save', {
            body: {
              workspaceId,
              dealId,
              profile: {
                budgetMinCents: min.trim() ? parseMoney(min) : null,
                budgetMaxCents: max.trim() ? parseMoney(max) : null,
                areas: lines(areas),
                homeTypes: types as HomeType[],
                bedsMin: n(beds),
                bathsMin: n(baths),
                sqftMin: n(sqft),
                moveBy: moveBy || null,
                mustHaves: lines(must),
                dealBreakers: lines(never),
              },
            },
          }),
        ),
      'Saved. Every home is checked against it now.',
    );
  const err = (k: string) => errors[`profile.${k}`] ?? errors[k];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="What they want"
        description="Every home is checked against this. Describe the home, never the people who live near it."
        className="w-[min(620px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 grid gap-3.5 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Lowest price" htmlFor="pf-min" error={err('budgetMinCents')}>
            <Input
              id="pf-min"
              inputMode="decimal"
              value={min}
              onChange={(e) => setMin(e.target.value)}
              placeholder="$"
            />
          </Field>
          <Field label="Highest price" htmlFor="pf-max" error={err('budgetMaxCents')}>
            <Input
              id="pf-max"
              inputMode="decimal"
              value={max}
              onChange={(e) => setMax(e.target.value)}
              placeholder="$"
            />
          </Field>
          <Field
            label="Areas"
            htmlFor="pf-areas"
            hint="Towns, ZIP codes or neighborhoods, with commas."
            error={err('areas')}
            className="sm:col-span-2"
          >
            <Input id="pf-areas" value={areas} onChange={(e) => setAreas(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <div className="mb-1.5 text-[13px] font-medium">Kinds of home</div>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {HOME_TYPE_KEYS.map((t) => (
                <Checkbox
                  key={t}
                  label={HOME_TYPES[t]}
                  checked={types.includes(t)}
                  onChange={(e) =>
                    setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))
                  }
                />
              ))}
            </div>
          </div>
          <Field label="Bedrooms, at least" htmlFor="pf-beds" error={err('bedsMin')}>
            <Input
              id="pf-beds"
              inputMode="numeric"
              value={beds}
              onChange={(e) => setBeds(e.target.value)}
            />
          </Field>
          <Field label="Bathrooms, at least" htmlFor="pf-baths" error={err('bathsMin')}>
            <Input
              id="pf-baths"
              inputMode="decimal"
              value={baths}
              onChange={(e) => setBaths(e.target.value)}
            />
          </Field>
          <Field label="Square feet, at least" htmlFor="pf-sqft" error={err('sqftMin')}>
            <Input
              id="pf-sqft"
              inputMode="numeric"
              value={sqft}
              onChange={(e) => setSqft(e.target.value)}
            />
          </Field>
          <Field label="Move by" htmlFor="pf-move" error={err('moveBy')}>
            <Input
              id="pf-move"
              type="date"
              value={moveBy}
              onChange={(e) => setMoveBy(e.target.value)}
            />
          </Field>
          <Field label="Must-haves" htmlFor="pf-must" hint="One a line." error={err('mustHaves')}>
            <Textarea
              id="pf-must"
              rows={3}
              value={must}
              onChange={(e) => setMust(e.target.value)}
            />
          </Field>
          <Field
            label="Deal-breakers"
            htmlFor="pf-never"
            hint="One a line."
            error={err('dealBreakers')}
          >
            <Textarea
              id="pf-never"
              rows={3}
              value={never}
              onChange={(e) => setNever(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'save'} data-testid="profile-save">
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
