import { HOME_TYPE_KEYS, HOME_TYPES, type HomeType } from '@hfos/core/addons/realestate/homes';
import {
  MEMORY_KINDS,
  MEMORY_KIND_KEYS,
  type MemoryKind,
} from '@hfos/core/addons/realestate/memory';
import {
  foundToday,
  mlsSupplier,
  RE_BUYER_WORDS as W,
  wantsLines,
} from '@hfos/core/addons/realestate/phone-words-buyer';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { BuyerProfileFields } from '@hfos/core/addons/realestate/schemas';
import {
  buyerProfileOfCopy,
  matchesOfCopy,
  memoryOfCopy,
  type BuyerProfileView,
  type MemoryView,
} from '@hfos/core/addons/realestate/views/buyer';
import { parseMoney } from '@hfos/core';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Chips, Field } from '@/components/calendar/new-appointment';
import { Check, ChevronRight, Pencil, Plus, Search } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { remember, saveProfile } from './buyer-actions';
import {
  attempt,
  DealNotHere,
  GroupLabel,
  KeyValues,
  SignalNote,
  SummaryHead,
  TextSheet,
  useBuyerDeal,
  type BuyerDeal,
} from './buyer-kit';
import { NeedsSignalCard, openRe, reHref, useLiveAnswer } from './kit';

/**
 * What they want (board 82, first panel): the buyer's wants as the agent and the client last set them, what's
 * remembered about them, and the search that watches the MLS. Changes wait on the phone; the search runs again when
 * they send.
 */

type Profile = NonNullable<BuyerProfileView['profile']>;
type MemoryItem = MemoryView['items'][number];

export interface SearchSummary {
  readonly on: boolean;
  readonly supplier: string | null;
  readonly newToday: number;
}

export function BuyerWantsScreen({ dealId }: { dealId: string }) {
  const { ctx, copy, deal } = useBuyerDeal(dealId);
  const kept = React.useMemo(() => {
    const profile = buyerProfileOfCopy(copy, dealId, ctx);
    const memory = memoryOfCopy(copy, dealId, {}, ctx);
    const matches = matchesOfCopy(copy, dealId, {}, ctx);
    return { profile, memory, matches };
  }, [copy, dealId, ctx]);
  const full = deal?.full ?? false;
  const live = useLiveAnswer(
    deal && !full
      ? () => {
          const body = { workspaceId: ctx.workspaceId, dealId };
          return Promise.all([
            api.POST('/v1/queries/realestate.buyer_profile.get', { body }).then(unwrap),
            api.POST('/v1/queries/realestate.memory', { body }).then(unwrap),
            deal.side === 'buyer'
              ? api.POST('/v1/queries/realestate.matches', { body }).then(unwrap)
              : Promise.resolve(null),
          ]);
        }
      : null,
    `wants:${dealId}`,
    RE_PHONE_WORDS.summaryNeedsSignal(W.whatThey),
  );
  if (!deal) return <DealNotHere title={W.wantsTitle} workspaceId={ctx.workspaceId} />;

  const source = full
    ? {
        profile: kept.profile?.profile ?? null,
        items: kept.memory?.items ?? [],
        matches: kept.matches,
      }
    : live.data
      ? { profile: live.data[0].profile, items: live.data[1].items, matches: live.data[2] }
      : null;
  const search: SearchSummary | null = source?.matches?.search
    ? {
        on: source.matches.search.on,
        supplier: mlsSupplier(source.matches.matches[0]?.mls.sourceWords),
        newToday: foundToday(source.matches.matches, ctx.today, ctx.timeZone),
      }
    : null;

  return (
    <Screen
      title={W.wantsTitle}
      subtitle={deal.name}
      leading="back"
      back={reHref(ctx.workspaceId, `deals/${dealId}`)}
      testID="re-buyer"
    >
      {!full ? <SummaryHead /> : null}
      {source ? (
        <BuyerWantsBody
          workspaceId={ctx.workspaceId}
          userId={ctx.userId}
          deal={deal}
          profile={source.profile}
          items={source.items}
          search={search}
          today={ctx.today}
          editable={full}
        />
      ) : live.error ? (
        <NeedsSignalCard words={live.error} onRetry={live.reload} />
      ) : null}
    </Screen>
  );
}

export function BuyerWantsBody({
  workspaceId,
  userId,
  deal,
  profile,
  items,
  search,
  today,
  editable,
}: {
  workspaceId: string;
  userId: string;
  deal: BuyerDeal;
  profile: Profile | null;
  items: readonly MemoryItem[];
  search: SearchSummary | null;
  today: string;
  editable: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [remembering, setRemembering] = React.useState(false);
  const lines = wantsLines(profile, items, today);
  // What's remembered that the lines above don't already say.
  const others = items.filter(
    (i) => i.status === 'confirmed' && !['must_have', 'likes', 'deal_breaker'].includes(i.kind),
  );
  return (
    <View className="gap-3" testID="re-buyer-body">
      {lines.length ? (
        <KeyValues
          rows={lines.map((l) => ({ label: l.label, value: l.value, testID: `re-want-${l.key}` }))}
          testID="re-wants"
        />
      ) : (
        <Card className="px-4 py-5">
          <Text className="text-[14.5px] leading-[21px] text-text-2">{W.wantsEmpty(deal.who)}</Text>
        </Card>
      )}
      {search ? (
        <>
          <GroupLabel>{W.theSearch}</GroupLabel>
          <Card>
            <Pressable
              role="button"
              onPress={() => openRe(workspaceId, `deals/${deal.id}/matches`)}
              className="min-h-14 flex-row items-center gap-3 px-3.5 py-3 active:bg-card-2"
              testID="re-search"
            >
              <Icon as={Search} className="size-[18px] text-text-2" />
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-base">
                  {search.on ? W.searchSaved(search.supplier) : W.searchOff}
                </Text>
                <Text className="text-[13px] leading-[18px] text-text-3" testID="re-search-line">
                  {W.searchLine(search.on, search.newToday)}
                </Text>
              </View>
              <Icon as={ChevronRight} className="size-4 text-text-3" />
            </Pressable>
          </Card>
        </>
      ) : null}
      {editable ? (
        <View className="gap-2 pt-1">
          <Button
            variant="secondary"
            icon={Pencil}
            onPress={() => setEditing(true)}
            testID="re-buyer-change"
          >
            {W.change}
          </Button>
          <SignalNote words={W.changesWait} testID="re-buyer-waits" />
        </View>
      ) : null}
      {others.length || editable ? <GroupLabel>{W.remembered}</GroupLabel> : null}
      {others.length ? (
        <KeyValues
          rows={others.map((i) => ({ label: MEMORY_KINDS[i.kind], value: i.words }))}
          testID="re-remembered"
        />
      ) : null}
      {editable ? (
        <Button
          variant="ghost"
          icon={Plus}
          onPress={() => setRemembering(true)}
          testID="re-remember"
        >
          {W.remember}
        </Button>
      ) : null}
      {editable ? (
        <>
          <ProfileSheet
            open={editing}
            onClose={() => setEditing(false)}
            profile={profile}
            onSave={(p) => attempt(() => saveProfile(workspaceId, deal.id, p, userId), W.saved)}
          />
          <RememberSheet
            open={remembering}
            onClose={() => setRemembering(false)}
            onSave={(kind, words) =>
              attempt(() => remember(workspaceId, deal.id, kind, words, userId), W.remembering)
            }
          />
        </>
      ) : null}
    </View>
  );
}

const list = (s: string) =>
  s
    .split(/\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);
const dollars = (c: number | null | undefined) =>
  c === null || c === undefined ? '' : (c / 100).toLocaleString('en-US');

export type SavedProfile = Parameters<typeof saveProfile>[2];

/** The buyer's wants, from what's typed: the profile to save, or what's wrong in words. */
export function profileFromForm(f: {
  min: string;
  max: string;
  areas: string;
  types: readonly string[];
  beds: string;
  baths: string;
  sqft: string;
  moveBy: string;
  must: string;
  never: string;
}): { profile: SavedProfile } | { problem: string } {
  const amount = (s: string, what: string): number | null | string => {
    if (!s.trim()) return null;
    const c = parseMoney(s);
    return c === null ? W.notAmount(what) : c;
  };
  const count = (s: string, what: string): number | null | string => {
    if (!s.trim()) return null;
    const v = Number(s.replace(/,/g, ''));
    return Number.isFinite(v) ? v : W.notNumber(what);
  };
  const min = amount(f.min, W.lowest);
  const max = amount(f.max, W.highest);
  const beds = count(f.beds, W.bedsAtLeast);
  const baths = count(f.baths, W.bathsAtLeast);
  const sqft = count(f.sqft, W.sqftAtLeast);
  for (const v of [min, max, beds, baths, sqft]) if (typeof v === 'string') return { problem: v };
  if (f.moveBy.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(f.moveBy.trim()))
    return { problem: W.notDate };
  const parsed = BuyerProfileFields.safeParse({
    budgetMinCents: min,
    budgetMaxCents: max,
    areas: list(f.areas),
    homeTypes: f.types,
    bedsMin: beds,
    bathsMin: baths,
    sqftMin: sqft,
    moveBy: f.moveBy.trim() || null,
    mustHaves: list(f.must),
    dealBreakers: list(f.never),
  });
  if (!parsed.success) return { problem: parsed.error.issues[0]?.message ?? W.notDate };
  return { profile: parsed.data as SavedProfile };
}

function ProfileSheet({
  open,
  onClose,
  profile,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  profile: Profile | null;
  onSave: (p: SavedProfile) => Promise<boolean>;
}) {
  const fresh = React.useCallback(
    () => ({
      min: dollars(profile?.budgetMinCents),
      max: dollars(profile?.budgetMaxCents),
      areas: profile?.areas.join(', ') ?? '',
      types: profile?.homeTypes ?? [],
      beds: profile?.bedsMin?.toString() ?? '',
      baths: profile?.bathsMin?.toString() ?? '',
      sqft: profile?.sqftMin?.toString() ?? '',
      moveBy: profile?.moveBy ?? '',
      must: profile?.mustHaves.join(', ') ?? '',
      never: profile?.dealBreakers.join(', ') ?? '',
    }),
    [profile],
  );
  const [form, setForm] = React.useState(fresh);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setForm(fresh());
      setProblem(null);
    }
  }, [open, fresh]);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (t: HomeType) =>
    setForm((f) => ({
      ...f,
      types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t],
    }));
  const save = async () => {
    const out = profileFromForm(form);
    if ('problem' in out) {
      setProblem(out.problem);
      return;
    }
    setBusy(true);
    const ok = await onSave(out.profile);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={W.wantsTitle}
      description={W.sheetWhy}
      scroll
      testID="re-profile-sheet"
    >
      <View className="mt-3">
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Field label={W.lowest}>
              <Input
                value={form.min}
                onChangeText={set('min')}
                keyboardType="decimal-pad"
                placeholder="$"
                testID="re-profile-min"
              />
            </Field>
          </View>
          <View className="flex-1">
            <Field label={W.highest}>
              <Input
                value={form.max}
                onChangeText={set('max')}
                keyboardType="decimal-pad"
                placeholder="$"
                testID="re-profile-max"
              />
            </Field>
          </View>
        </View>
        <Field label={W.areas}>
          <Input
            value={form.areas}
            onChangeText={set('areas')}
            placeholder={W.areasHint}
            testID="re-profile-areas"
          />
        </Field>
        <Field label={W.kinds}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-1.5 pr-3">
              {HOME_TYPE_KEYS.map((t) => {
                const on = form.types.includes(t);
                return (
                  <Pressable
                    key={t}
                    role="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => toggle(t)}
                    testID={`re-profile-type-${t}`}
                    className={cn(
                      'h-11 flex-row items-center gap-1.5 rounded-full border px-3.5',
                      on ? 'border-transparent bg-accent-soft' : 'border-border-strong bg-card',
                    )}
                  >
                    {on ? <Icon as={Check} className="size-3.5 text-accent-text" /> : null}
                    <Text
                      className={cn(
                        'text-[13px] font-medium',
                        on ? 'text-accent-text' : 'text-text-2',
                      )}
                    >
                      {HOME_TYPES[t]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </Field>
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Field label={W.bedsAtLeast}>
              <Input
                value={form.beds}
                onChangeText={set('beds')}
                keyboardType="number-pad"
                testID="re-profile-beds"
              />
            </Field>
          </View>
          <View className="flex-1">
            <Field label={W.bathsAtLeast}>
              <Input
                value={form.baths}
                onChangeText={set('baths')}
                keyboardType="decimal-pad"
                testID="re-profile-baths"
              />
            </Field>
          </View>
        </View>
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Field label={W.sqftAtLeast}>
              <Input
                value={form.sqft}
                onChangeText={set('sqft')}
                keyboardType="number-pad"
                testID="re-profile-sqft"
              />
            </Field>
          </View>
          <View className="flex-1">
            <Field label={W.moveBy}>
              <Input
                value={form.moveBy}
                onChangeText={set('moveBy')}
                placeholder="2026-12-01"
                testID="re-profile-move"
              />
            </Field>
          </View>
        </View>
        <Field label={W.mustHaves}>
          <Input value={form.must} onChangeText={set('must')} testID="re-profile-must" />
        </Field>
        <Field label={W.neverHaves}>
          <Input value={form.never} onChangeText={set('never')} testID="re-profile-never" />
        </Field>
        {problem ? (
          <Text
            className="mb-3 text-[13px] leading-[18px] text-danger-text"
            testID="re-profile-problem"
          >
            {problem}
          </Text>
        ) : null}
        <Button loading={busy} onPress={() => void save()} testID="re-profile-save">
          {W.save}
        </Button>
        <SignalNote words={W.changesWait} />
      </View>
    </Sheet>
  );
}

function RememberSheet({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (kind: MemoryKind, words: string) => Promise<boolean>;
}) {
  const [kind, setKind] = React.useState<MemoryKind>('likes');
  React.useEffect(() => {
    if (open) setKind('likes');
  }, [open]);
  return (
    <TextSheet
      open={open}
      onClose={onClose}
      title={W.remember}
      description={W.rememberHint}
      submit={W.save}
      onSubmit={(words) => onSave(kind, words)}
      testID="re-remember-sheet"
    >
      <View className="mt-3">
        <Chips
          options={MEMORY_KIND_KEYS.map((k) => ({ value: k, label: MEMORY_KINDS[k] }))}
          value={kind}
          onChange={(v) => setKind(v as MemoryKind)}
          testID="re-remember-kind"
        />
      </View>
    </TextSheet>
  );
}
