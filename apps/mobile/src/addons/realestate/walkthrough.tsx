import { fmtMonthDay, fmtTime, localDayOf } from '@hfos/core';
import {
  WALKTHROUGH_ITEM_WORDS,
  WALKTHROUGH_SOURCE_WORDS,
} from '@hfos/core/addons/realestate/field-words';
import { streetOf } from '@hfos/core/addons/realestate/listing';
import {
  firstNamesOf,
  RE_WALKTHROUGH_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-closing';
import { termsNow } from '@hfos/core/addons/realestate/terms';
import { clientTasksOfCopy } from '@hfos/core/addons/realestate/views/closing';
import { termEntriesOfCopy } from '@hfos/core/addons/realestate/views/deal-facts';
import { walkthroughOfCopy, type WalkthroughView } from '@hfos/core/addons/realestate/views/field';
import { addressOfCopy } from '@hfos/core/addons/realestate/views/listing';
import * as React from 'react';
import { View } from 'react-native';

import { Camera, Check, House, Plus, Users, Wrench, X } from '@/components/icons';
import { List, ListLabel } from '@/components/shell/list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import {
  addWalkthroughItem,
  checkWalkthroughItem,
  finishWalkthrough,
  planWalkthrough,
  startWalkthrough,
} from './closing-actions';
import { SignalButton } from './kit';
import {
  CheckRow,
  DealSubpage,
  FieldError,
  FieldLabel,
  keepDealPhoto,
  PhotoFrame,
  SignalNote,
  SummaryAnswer,
  uploadDealPhoto,
  useDealPage,
  useSummaryAnswer,
  whenWords,
  type KeptDealPhoto,
} from './subpage';

/**
 * The final walkthrough on the phone (board 86, spec X-24): its checklist, built from the contract, the repairs
 * agreed, the inspection and each room, is on the phone before the agent goes, and the whole walkthrough works with
 * no signal: starting it, ticking each thing with a note and photos, adding one the list doesn't have, and finishing
 * it. A thing that isn't right becomes a duty before closing once the finish reaches HandsFreeOS, and the finished
 * checklist is the "Final walkthrough" duty's proof. Building the list needs signal, once.
 */

type Walkthrough = NonNullable<WalkthroughView['walkthrough']>;
type Item = Walkthrough['items'][number];
type Source = Item['source'];
const SOURCES: readonly Source[] = ['repair', 'included', 'excluded', 'finding', 'room', 'added'];
const ICONS = {
  repair: Wrench,
  included: House,
  excluded: X,
  finding: Wrench,
  room: Camera,
  added: Plus,
};

/** Who's at the walkthrough, where and when closing is: what its card says under its name. */
export interface WalkthroughFacts {
  readonly street: string | null;
  readonly clients: string;
  readonly closing: string | null;
  /** A duty a thing not right became: who it's for and when it's due. */
  duty(id: string | null): { readonly who: string | null; readonly due: string | null } | null;
}

export function WalkthroughScreen({ dealId }: { dealId: string }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const view = React.useMemo(
    () => walkthroughOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const facts = React.useMemo<WalkthroughFacts>(() => {
    const address = addressOfCopy(copy, dealId);
    const clients = clientTasksOfCopy(copy, dealId, { userId: ctx.userId })?.clients ?? [];
    const duties = copy.duties.get(dealId) ?? [];
    return {
      street: address ? streetOf(address) : null,
      clients: firstNamesOf(clients.map((c) => c.name)),
      closing: termsNow(termEntriesOfCopy(copy, dealId)).get('closing')?.current?.valueDate ?? null,
      duty: (id) => {
        const d = id ? duties.find((x) => x.id === id) : undefined;
        if (!d) return null;
        const who = d.accountableUserId ? copy.user(d.accountableUserId) : null;
        return {
          who: who?.split(/\s+/)[0] ?? null,
          due: d.dueAt ? fmtMonthDay(localDayOf(d.dueAt, ctx.timeZone)) : null,
        };
      },
    };
  }, [copy, dealId, ctx.userId, ctx.timeZone]);
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () => ({
      ...unwrap(
        await api.POST('/v1/queries/realestate.walkthrough', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ),
      full: true,
    }),
    `walkthrough:${dealId}`,
    'walkthrough',
  );
  const w = view?.walkthrough ?? null;
  const [item, setItem] = React.useState<Item | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const subtitle =
    w?.state === 'started' && facts.street
      ? `${facts.street} · ${fmtTime(ctx.now, ctx.timeZone)}`
      : w?.state === 'done'
        ? (facts.street ?? undefined)
        : undefined;
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={W.title}
      subtitle={subtitle}
      testID="re-walkthrough"
    >
      {whole && view ? (
        <WalkthroughBody
          walkthrough={w}
          facts={facts}
          today={ctx.today}
          timeZone={ctx.timeZone}
          onPlan={async () => {
            await planWalkthrough({ workspaceId: ctx.workspaceId, dealId });
          }}
          onStart={() =>
            w &&
            void startWalkthrough({ workspaceId: ctx.workspaceId, walkthroughId: w.id }).catch(
              (e: unknown) => toast.error(errorMessage(e)),
            )
          }
          onItem={setItem}
          onAdd={() => setAdding(true)}
          onFinish={() => setFinishing(true)}
        />
      ) : (
        <SummaryAnswer answer={server} what="walkthrough">
          {(data) => (
            <WalkthroughBody
              walkthrough={data.walkthrough}
              facts={facts}
              today={ctx.today}
              timeZone={ctx.timeZone}
            />
          )}
        </SummaryAnswer>
      )}
      <ItemSheet
        item={item}
        onClose={() => setItem(null)}
        onPhoto={() => keepDealPhoto(ctx.userId, 'camera')}
        onSave={async (it, state, note, photos) => {
          if (!w) return;
          const dependsOn: string[] = [];
          for (const [i, photo] of photos.entries())
            dependsOn.push(
              await uploadDealPhoto({
                workspaceId: ctx.workspaceId,
                dealId,
                photo,
                name: `Walkthrough · ${it.title} ${it.photoFileIds.length + i + 1}.jpg`,
              }),
            );
          await checkWalkthroughItem({
            workspaceId: ctx.workspaceId,
            walkthroughId: w.id,
            userId: ctx.userId,
            itemId: it.id,
            state,
            note,
            photoFileIds: [...it.photoFileIds, ...photos.map((p) => p.fileId)],
            dependsOn,
          });
        }}
      />
      <AddItemSheet
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={async (title, detail) => {
          if (!w) return;
          await addWalkthroughItem({
            workspaceId: ctx.workspaceId,
            dealId,
            walkthroughId: w.id,
            title,
            detail,
            position: w.items.length + 1,
          });
        }}
      />
      <FinishSheet
        open={finishing}
        summary={w?.summary ?? ''}
        clients={facts.clients}
        onClose={() => setFinishing(false)}
        onFinish={async (clientsAgreed) => {
          if (!w) return;
          await finishWalkthrough({
            workspaceId: ctx.workspaceId,
            walkthroughId: w.id,
            clientsAgreed,
          });
          toast.show(W.finished);
        }}
      />
    </DealSubpage>
  );
}

/** How a thing was, in the words its kind uses: a repair is "Fixed", a fridge "OK". */
export function stateWord(item: Pick<Item, 'source' | 'state'>): string {
  if (item.state === 'unchecked') return WALKTHROUGH_ITEM_WORDS.unchecked;
  return item.source === 'repair' ? W.repairStates[item.state] : WALKTHROUGH_ITEM_WORDS[item.state];
}

/** "Fixed · receipt from Hill Roofing" once it's checked; what to look at before. */
export function itemLine(item: Item): string {
  if (item.state === 'unchecked') return item.detail ?? W.checkIt;
  return [stateWord(item), item.note].filter(Boolean).join(' · ');
}

const groupsOf = (items: readonly Item[]) =>
  SOURCES.map((source) => ({ source, items: items.filter((i) => i.source === source) })).filter(
    (g) => g.items.length > 0,
  );

export function WalkthroughBody({
  walkthrough: w,
  facts,
  today,
  timeZone,
  onPlan,
  onStart,
  onItem,
  onAdd,
  onFinish,
}: {
  walkthrough: Walkthrough | null;
  facts: WalkthroughFacts;
  today: string;
  timeZone: string;
  onPlan?: () => Promise<void>;
  onStart?: () => void;
  onItem?: (item: Item) => void;
  onAdd?: () => void;
  onFinish?: () => void;
}) {
  const [planning, setPlanning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  if (!w)
    return (
      <View className="gap-3" testID="walkthrough-none">
        <Card className="p-4">
          <Text className="text-[14px] leading-[20px] text-text-2">{W.none}</Text>
        </Card>
        <FieldError>{error}</FieldError>
        {onPlan ? (
          <SignalButton
            label={W.plan}
            why={W.planWhy}
            disabled={planning}
            onPress={() => {
              setPlanning(true);
              setError(null);
              onPlan()
                .catch((e: unknown) => setError(errorMessage(e)))
                .finally(() => setPlanning(false));
            }}
            testID="walkthrough-plan"
          />
        ) : null}
      </View>
    );
  if (w.state === 'done')
    return <WalkthroughDone walkthrough={w} facts={facts} timeZone={timeZone} />;
  const head = (
    <Card className="gap-1 p-4" testID="walkthrough-card">
      <View className="flex-row items-start justify-between gap-2">
        <Text className="flex-1 text-[15px] font-semibold">{W.card}</Text>
        {w.scheduledAt ? (
          <Badge variant="pending">{whenWords(w.scheduledAt, today, timeZone)}</Badge>
        ) : null}
      </View>
      <Text className="text-[13.5px] text-text-2">
        {[
          facts.street,
          facts.clients ? W.with(facts.clients) : null,
          facts.closing ? W.closing(fmtMonthDay(facts.closing)) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </Card>
  );
  if (w.state === 'planned')
    return (
      <View className="gap-3" testID="walkthrough-planned">
        {head}
        <ListLabel>{W.builtFrom}</ListLabel>
        <List>
          {groupsOf(w.items).map(({ source, items }) => (
            <CheckRow
              key={source}
              icon={ICONS[source]}
              label={W.groups[source](items.length)}
              line={groupLine(source, items)}
              testID={`walkthrough-group-${source}`}
            />
          ))}
        </List>
        {onStart ? (
          <Button onPress={onStart} testID="walkthrough-start">
            {W.start}
          </Button>
        ) : null}
        {onAdd ? (
          <Button variant="secondary" icon={Plus} onPress={onAdd} testID="walkthrough-add">
            {W.addItem}
          </Button>
        ) : null}
        <SignalNote>{W.onPhone}</SignalNote>
      </View>
    );
  return (
    <View className="gap-3" testID="walkthrough-started">
      {groupsOf(w.items).map(({ source, items }) => (
        <View key={source} className="gap-1.5">
          <View className="flex-row items-baseline gap-2 px-1 pt-2">
            <Text variant="group">{WALKTHROUGH_SOURCE_WORDS[source]}</Text>
            {source !== 'excluded' ? (
              <Text className="text-xs text-text-3">
                {W.ofCount(items.filter((i) => i.state !== 'unchecked').length, items.length)}
              </Text>
            ) : null}
          </View>
          <List>
            {items.map((i) => (
              <CheckRow
                key={i.id}
                checked={i.state === 'ok'}
                label={i.title}
                line={itemLine(i)}
                warning={i.state === 'not_ok' ? stateWord(i) : null}
                end={i.photoFileIds.length ? <PhotoFrame className="w-10" /> : undefined}
                onPress={onItem ? () => onItem(i) : undefined}
                testID={`walkthrough-item-${i.id}`}
              />
            ))}
          </List>
        </View>
      ))}
      {onAdd ? (
        <Button variant="secondary" icon={Plus} onPress={onAdd} testID="walkthrough-add">
          {W.addItem}
        </Button>
      ) : null}
      {onFinish ? (
        <Button onPress={onFinish} testID="walkthrough-finish">
          {W.finish}
        </Button>
      ) : null}
      <SignalNote>{W.onPhone}</SignalNote>
    </View>
  );
}

/** "From the contract: fridge, washer, dryer…" */
function groupLine(source: Source, items: readonly Item[]): string {
  const names = items.map((i) => i.title.toLowerCase());
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
  switch (source) {
    case 'included':
      return W.groupLines.included(shown);
    case 'excluded':
      return W.groupLines.excluded(
        items
          .map((i) => i.title)
          .slice(0, 3)
          .join(', '),
      );
    default:
      return W.groupLines[source];
  }
}

function WalkthroughDone({
  walkthrough: w,
  facts,
  timeZone,
}: {
  walkthrough: Walkthrough;
  facts: WalkthroughFacts;
  timeZone: string;
}) {
  const photos = w.items.reduce((n, i) => n + i.photoFileIds.length, 0);
  const bad = w.items.filter((i) => i.state === 'not_ok');
  const ok = w.items.filter((i) => i.state === 'ok').length;
  const at = w.finishedAt ? fmtTime(w.finishedAt, timeZone) : '';
  return (
    <View className="gap-3" testID="walkthrough-done">
      <Card className="gap-1 p-4">
        <View className="flex-row items-start justify-between gap-2">
          <Text className="flex-1 text-[15px] font-semibold">{W.done}</Text>
          <Badge variant={bad.length ? 'pending' : 'ok'}>{W.okCount(ok, w.items.length)}</Badge>
        </View>
        <Text className="text-[13.5px] text-text-2">
          {W.doneLine(at, facts.clients || null, photos)}
        </Text>
        {bad.length ? (
          <Text className="text-[13.5px]" testID="walkthrough-to-fix">
            <Text className="text-[13.5px] font-semibold">{W.toFix(bad.length)}</Text>{' '}
            {bad
              .map((i) => {
                const d = facts.duty(i.dutyId);
                return W.fixItem(i.title, d?.who ?? null, d?.due ?? null);
              })
              .join('; ')}
          </Text>
        ) : null}
      </Card>
      <ListLabel>{W.proof}</ListLabel>
      <List>
        <CheckRow icon={Check} label={W.proofDone} line={W.proofDoneLine} />
        <CheckRow
          icon={Users}
          label={W.agreed(facts.clients)}
          line={
            w.clientsAgreedAt ? W.agreedLine(fmtTime(w.clientsAgreedAt, timeZone)) : W.notAgreed
          }
        />
      </List>
    </View>
  );
}

/** One thing checked: how it was, photos and a note. */
export function ItemSheet({
  item,
  onClose,
  onPhoto,
  onSave,
}: {
  item: Item | null;
  onClose: () => void;
  onPhoto: () => Promise<KeptDealPhoto | null>;
  onSave: (
    item: Item,
    state: 'ok' | 'not_ok' | 'unsure',
    note: string,
    photos: readonly KeptDealPhoto[],
  ) => Promise<void>;
}) {
  const [state, setState] = React.useState<'ok' | 'not_ok' | 'unsure'>('ok');
  const [note, setNote] = React.useState('');
  const [photos, setPhotos] = React.useState<KeptDealPhoto[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!item) return;
    setState(item.state === 'unchecked' ? 'ok' : item.state);
    setNote(item.note ?? '');
    setPhotos([]);
    setError(null);
  }, [item]);
  if (!item) return <Sheet open={false} onClose={onClose} />;
  const words = (s: 'ok' | 'not_ok' | 'unsure') => stateWord({ source: item.source, state: s });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(item, state, note.trim(), photos);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = item.photoFileIds.length + photos.length;
  return (
    <Sheet
      open
      onClose={onClose}
      title={item.title}
      description={item.detail ?? undefined}
      testID="walkthrough-item-sheet"
    >
      <View className="gap-3">
        <Segmented
          label={item.title}
          value={state}
          onChange={setState}
          options={(['ok', 'not_ok', 'unsure'] as const).map((s) => ({
            value: s,
            label: words(s),
            testID: `walkthrough-state-${s}`,
          }))}
        />
        <View className="flex-row gap-2">
          {Array.from({ length: shown }, (_, i) => (
            <PhotoFrame key={i} label={`Photo ${i + 1}`} className="flex-1" />
          ))}
          {shown < 3 ? (
            <PhotoFrame
              className="flex-1"
              onPress={() =>
                void onPhoto().then((p) => {
                  if (p) setPhotos((was) => [...was, p]);
                })
              }
              testID="walkthrough-photo"
            />
          ) : null}
          {Array.from({ length: Math.max(0, 2 - shown) }, (_, i) => (
            <View key={`gap-${i}`} className="flex-1" />
          ))}
        </View>
        <FieldLabel>{W.note}</FieldLabel>
        <Input
          value={note}
          onChangeText={setNote}
          placeholder={state === 'not_ok' ? W.noteHint : undefined}
          testID="walkthrough-note"
        />
        <FieldError>{error}</FieldError>
        <Button loading={busy} onPress={() => void save()} testID="walkthrough-save">
          {W.save}
        </Button>
        {state === 'not_ok' ? <SignalNote>{W.fixDuty(item.title)}</SignalNote> : null}
      </View>
    </Sheet>
  );
}

/** Something to check the list doesn't have. */
export function AddItemSheet({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (title: string, detail: string | null) => Promise<void>;
}) {
  const [title, setTitle] = React.useState('');
  const [detail, setDetail] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setTitle('');
    setDetail('');
    setError(null);
  }, [open]);
  const add = async () => {
    if (!title.trim()) {
      setError(W.sayWhat);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd(title.trim(), detail.trim() || null);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={W.addTitle} testID="walkthrough-add-sheet">
      <View className="gap-3">
        <FieldLabel>{W.what}</FieldLabel>
        <Input
          value={title}
          onChangeText={setTitle}
          placeholder={W.whatHint}
          invalid={!!error && !title.trim()}
          testID="walkthrough-add-what"
        />
        <FieldLabel>{W.detail}</FieldLabel>
        <Input value={detail} onChangeText={setDetail} testID="walkthrough-add-detail" />
        <FieldError>{error}</FieldError>
        <Button loading={busy} onPress={() => void add()} testID="walkthrough-add-save">
          {W.save}
        </Button>
      </View>
    </Sheet>
  );
}

/** Finishing: the clients' OK, ticked on the phone with them. */
export function FinishSheet({
  open,
  summary,
  clients,
  onClose,
  onFinish,
}: {
  open: boolean;
  summary: string;
  clients: string;
  onClose: () => void;
  onFinish: (clientsAgreed: boolean) => Promise<void>;
}) {
  const [agreed, setAgreed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setAgreed(false);
      setError(null);
    }
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={W.finishTitle}
      description={W.finishAbout(summary)}
      testID="walkthrough-finish-sheet"
    >
      <View className="gap-3">
        <View className="flex-row items-center gap-3">
          <Text className="flex-1 text-base">{W.agreed(clients)}</Text>
          <Switch
            label={W.agreed(clients)}
            checked={agreed}
            onCheckedChange={setAgreed}
            testID="walkthrough-agreed"
          />
        </View>
        <FieldError>{error}</FieldError>
        <Button
          loading={busy}
          onPress={() => {
            setBusy(true);
            setError(null);
            onFinish(agreed)
              .then(onClose)
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
          testID="walkthrough-finish-save"
        >
          {W.finish}
        </Button>
      </View>
    </Sheet>
  );
}
