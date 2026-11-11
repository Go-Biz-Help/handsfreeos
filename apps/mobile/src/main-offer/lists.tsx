import {
  cleanListLines,
  firstPicked,
  leftAfterAdding,
  isOfferList,
  listsFilled,
  MAIN_OFFER_LISTS_WORDS as LW,
  MAIN_OFFER_PHONE_WORDS as PW,
  MAIN_OFFER_WORDS as W,
  OFFER_LIST_INFO,
  OFFER_LIST_LIMITS,
  OFFER_LISTS,
  type MainOfferLists,
  type OfferList,
  type OfferListGap,
  roomIn,
  togglePicked,
} from '@hfos/core';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import {
  ChevronDown,
  ChevronRight,
  ListChecks,
  Pencil,
  Sparkles,
  Square,
  SquareCheck,
  X,
} from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useLiveAnswer } from '@/lib/live-answer';

import { MAIN_OFFER_MANAGE, mainOfferCalls, offerAiError, type MainOfferCalls } from './calls';

/**
 * The lists for content on the phone (docs/main-offer.md, "For your content"; the owner's pick 6b, 11 Nov 2026: the
 * phone changes them too, with the AI's help). The same lists and buttons as the web's card: each list opens to its
 * lines, with Write it for me, Improve a line, Examples, and What's missing across them all. Every change saves at
 * once and needs signal; nothing is kept on the phone. Owners and admins change them; everyone sees them.
 */
export function ContentListsScreen() {
  const { business } = useBusiness();
  const { permissions } = useGrants();
  const manages = permissions?.includes(MAIN_OFFER_MANAGE) ?? false;
  const { list: asked } = useLocalSearchParams<{ list?: string }>();
  const answer = useLiveAnswer(
    () => mainOfferCalls(business.id).get(),
    business.id,
    PW.needsSignal,
  );
  const offer = answer.data;

  return (
    <Screen
      title={LW.title}
      subtitle={W.title}
      leading="back"
      back={businessHref(business.id, 'settings/main-offer')}
      scroll={false}
      testID="main-offer-lists"
    >
      {!offer ? (
        answer.error ? (
          <Card className="m-4 gap-3 px-4 py-4" testID="main-offer-lists-trouble">
            <Text className="leading-[22px] text-text-2">{answer.error}</Text>
            <Button variant="secondary" onPress={answer.reload}>
              {PW.tryAgain}
            </Button>
          </Card>
        ) : (
          <View className="items-center py-10">
            <ActivityIndicator />
          </View>
        )
      ) : (
        <Lists
          calls={mainOfferCalls(business.id)}
          saved={offer.lists}
          manages={manages && offer.inUse}
          first={isOfferList(asked) ? asked : null}
        />
      )}
    </Screen>
  );
}

/** Settings → Main offer's row for the lists: how many are filled in, and a press opens them. */
export function ContentListsLink({
  workspaceId,
  lists,
}: {
  workspaceId: string;
  lists: MainOfferLists;
}) {
  return (
    <Pressable
      role="link"
      onPress={() => router.push(businessHref(workspaceId, 'settings/main-offer-lists'))}
      className="active:opacity-80"
      testID="main-offer-lists-link"
    >
      <Card className="flex-row items-center gap-3 px-4 py-3.5">
        <Icon as={ListChecks} className="size-5 text-accent-text" />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-semibold">{LW.title}</Text>
          <Text className="text-[13.5px] leading-[19px] text-text-2">
            {LW.filled(listsFilled(lists), OFFER_LISTS.length)}
          </Text>
        </View>
        <Icon as={ChevronRight} className="size-4 text-text-3" />
      </Card>
    </Pressable>
  );
}

function Lists({
  calls,
  saved,
  manages,
  first,
}: {
  calls: MainOfferCalls;
  saved: MainOfferLists;
  manages: boolean;
  first: OfferList | null;
}) {
  const keyboard = useKeyboardHeight();
  const [lists, setLists] = React.useState<MainOfferLists>(saved);
  const [open, setOpen] = React.useState<OfferList | null>(first);
  const [gaps, setGaps] = React.useState<OfferListGap[] | null>(null);
  const [checking, setChecking] = React.useState(false);

  /** Saves one list whole; one that can't be saved goes back, saying why. */
  async function save(list: OfferList, next: string[]): Promise<boolean> {
    const before = lists;
    setLists({ ...lists, [list]: cleanListLines(next) });
    try {
      const kept = await calls.saveList(list, cleanListLines(next));
      setLists((now) => ({ ...now, [list]: kept }));
      toast.show(LW.saved);
      return true;
    } catch (e) {
      setLists(before);
      toast.error(errorMessage(e));
      return false;
    }
  }

  async function checkGaps() {
    setChecking(true);
    try {
      setGaps((await calls.listsHelp({ mode: 'gaps' })).gaps);
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-3 p-4 pb-8"
      contentContainerStyle={keyboard ? { paddingBottom: keyboard + 32 } : undefined}
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-[14px] leading-[20px] text-text-2">{LW.hint}</Text>
      <Text className="text-[13px] text-text-3" testID="main-offer-lists-filled">
        {LW.filled(listsFilled(lists), OFFER_LISTS.length)}
      </Text>
      {manages ? (
        <Button
          variant="secondary"
          size="md"
          icon={Sparkles}
          loading={checking}
          onPress={() => void checkGaps()}
          testID="main-offer-lists-gaps"
        >
          {checking ? LW.gapsChecking : LW.gaps}
        </Button>
      ) : null}
      {gaps ? (
        <Card className="gap-1 px-4 py-3" testID="main-offer-lists-gaps-found">
          {gaps.length ? (
            gaps.map((g) => (
              <Pressable
                key={g.list}
                onPress={() => setOpen(g.list)}
                className="min-h-11 gap-0.5 py-1.5 active:opacity-70"
              >
                <Text className="text-[14px] font-medium">{OFFER_LIST_INFO[g.list].label}</Text>
                <Text className="text-[13.5px] leading-[19px] text-text-2">{g.note}</Text>
              </Pressable>
            ))
          ) : (
            <Text className="text-[14px] text-text-2">{LW.gapsNone}</Text>
          )}
          <Button variant="ghost" size="sm" className="self-end" onPress={() => setGaps(null)}>
            {LW.dismiss}
          </Button>
        </Card>
      ) : null}
      {!manages ? <Text className="text-[13px] text-text-3">{LW.managersOnly}</Text> : null}
      <Card className="overflow-hidden">
        {OFFER_LISTS.map((list, i) => (
          <ListRow
            key={list}
            calls={calls}
            list={list}
            lines={lists[list] ?? []}
            open={open === list}
            first={i === 0}
            onOpen={() => setOpen(open === list ? null : list)}
            manages={manages}
            save={(next) => save(list, next)}
          />
        ))}
      </Card>
    </ScrollView>
  );
}

/** What the AI gave for the open list, to tick several of and add together: its own lines, or examples to model. */
type Help = { kind: 'write' | 'examples'; options: string[]; picked: string[] };

function ListRow({
  calls,
  list,
  lines,
  open,
  first,
  onOpen,
  manages,
  save,
}: {
  calls: MainOfferCalls;
  list: OfferList;
  lines: string[];
  open: boolean;
  first: boolean;
  onOpen: () => void;
  manages: boolean;
  save: (next: string[]) => Promise<boolean>;
}) {
  const info = OFFER_LIST_INFO[list];
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState<'write' | 'examples' | 'save' | null>(null);
  const [help, setHelp] = React.useState<Help | null>(null);
  const full = lines.length >= OFFER_LIST_LIMITS.lines;
  const room = roomIn(lines);

  async function ask(kind: 'write' | 'examples') {
    setBusy(kind);
    try {
      const { options } = await calls.listsHelp({ mode: kind, list });
      if (!options.length) {
        toast.show(LW.nothingNew);
        setHelp(null);
      } else setHelp({ kind, options, picked: firstPicked(kind, options, lines) });
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    setBusy('save');
    if (await save([...lines, typed])) setTyped('');
    setBusy(null);
  }

  /** Adds the ticked lines together; the rest stay on show, to add too, while the list has room. */
  async function addPicked(shown: Help) {
    setBusy('save');
    if (await save([...lines, ...shown.picked])) {
      const left = leftAfterAdding(shown.options, shown.picked);
      setHelp(
        left.length && shown.picked.length < room ? { ...shown, options: left, picked: [] } : null,
      );
    }
    setBusy(null);
  }

  return (
    <View className={first ? '' : 'border-t border-border'} testID={`main-offer-list-${list}`}>
      <Pressable
        onPress={onOpen}
        accessibilityState={{ expanded: open }}
        accessibilityLabel={LW.open(info.label)}
        className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-card-2"
        testID={`main-offer-list-${list}-open`}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[15px] font-medium">{info.label}</Text>
          <Text className="text-[13px] text-text-3" numberOfLines={1}>
            {lines.length ? lines[0] : LW.empty}
          </Text>
        </View>
        {lines.length ? (
          <Text className="text-[12.5px] text-text-3">{LW.lines(lines.length)}</Text>
        ) : null}
        <Icon as={ChevronDown} className={`size-4 text-text-3 ${open ? 'rotate-180' : ''}`} />
      </Pressable>

      {open ? (
        <View className="gap-2.5 px-4 pb-4">
          <Text className="text-[13.5px] leading-[19px] text-text-2">{info.hint}</Text>
          {lines.map((l, i) => (
            <LineItem
              key={`${i}-${l}`}
              calls={calls}
              list={list}
              line={l}
              manages={manages}
              onChange={(next) =>
                save(
                  next === null
                    ? lines.filter((_, j) => j !== i)
                    : lines.map((x, j) => (j === i ? next : x)),
                )
              }
            />
          ))}

          {help ? (
            <View
              className="gap-1 rounded-menu bg-card-2 px-3 py-3"
              testID={`main-offer-list-${list}-${help.kind === 'write' ? 'suggestions' : 'examples'}`}
            >
              <Text className="pb-1 text-[13.5px] text-text-2">
                {help.kind === 'write' ? LW.suggestions : LW.examplesHint}
              </Text>
              {help.options.map((o, i) => {
                const on = help.picked.includes(o);
                const shut = !manages || (!on && help.picked.length >= room);
                return (
                  <Pressable
                    key={o}
                    role="checkbox"
                    aria-checked={on}
                    aria-disabled={shut}
                    disabled={shut}
                    onPress={() =>
                      setHelp({ ...help, picked: togglePicked(help.picked, o, lines) })
                    }
                    className={`min-h-11 flex-row items-start gap-2.5 py-1.5 active:opacity-70 ${shut ? 'opacity-50' : ''}`}
                    testID={`main-offer-list-${list}-${help.kind === 'write' ? 'suggestion' : 'example'}-${i}`}
                  >
                    <Icon
                      as={on ? SquareCheck : Square}
                      className={`mt-0.5 size-5 ${on ? 'text-accent-text' : 'text-text-3'}`}
                    />
                    <Text className="flex-1 text-[14px] leading-[20px]">{o}</Text>
                  </Pressable>
                );
              })}
              {help.options.length > room ? (
                <Text className="text-[12.5px] text-text-3">{LW.room(room)}</Text>
              ) : null}
              <View className="flex-row gap-2 pt-1">
                {manages ? (
                  <Button
                    size="md"
                    className="flex-1"
                    loading={busy === 'save'}
                    disabled={!help.picked.length}
                    onPress={() => void addPicked(help)}
                    testID={`main-offer-list-${list}-keep`}
                  >
                    {LW.addPicked(help.picked.length)}
                  </Button>
                ) : null}
                <Button size="md" variant="ghost" onPress={() => setHelp(null)}>
                  {LW.dismiss}
                </Button>
              </View>
            </View>
          ) : null}

          {manages ? (
            <>
              <View className="flex-row gap-2">
                <Input
                  value={typed}
                  onChangeText={setTyped}
                  maxLength={OFFER_LIST_LIMITS.line}
                  placeholder={LW.addPlaceholder(info.example)}
                  accessibilityLabel={LW.addLabel(info.label)}
                  editable={!full}
                  multiline
                  className="min-w-0 flex-1"
                  testID={`main-offer-list-${list}-input`}
                />
                <Button
                  variant="secondary"
                  size="md"
                  loading={busy === 'save' && !help}
                  disabled={!typed.trim() || full}
                  onPress={() => void add()}
                  testID={`main-offer-list-${list}-add`}
                >
                  {LW.add}
                </Button>
              </View>
              {full ? (
                <Text className="text-[12.5px] text-text-3">
                  {LW.full(OFFER_LIST_LIMITS.lines)}
                </Text>
              ) : null}
              <View className="flex-row flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  icon={Sparkles}
                  loading={busy === 'write'}
                  disabled={full || busy !== null}
                  onPress={() => void ask('write')}
                  testID={`main-offer-list-${list}-write`}
                >
                  {busy === 'write' ? LW.writing : LW.writeForMe}
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  loading={busy === 'examples'}
                  disabled={busy !== null}
                  onPress={() => void ask('examples')}
                  testID={`main-offer-list-${list}-examples-ask`}
                >
                  {LW.examples}
                </Button>
              </View>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** One line: change it, have the AI rewrite it three ways (Improve), or remove it. */
function LineItem({
  calls,
  list,
  line,
  manages,
  onChange,
}: {
  calls: MainOfferCalls;
  list: OfferList;
  line: string;
  manages: boolean;
  /** The line's new words, or null to remove it. */
  onChange: (next: string | null) => Promise<boolean>;
}) {
  const [editing, setEditing] = React.useState<string | null>(null);
  const [rewrites, setRewrites] = React.useState<string[] | null>(null);
  const [busy, setBusy] = React.useState<'improve' | 'save' | null>(null);

  async function improve() {
    setBusy('improve');
    try {
      const { options } = await calls.listsHelp({ mode: 'improve', list, line });
      if (options.length) setRewrites(options);
      else toast.show(LW.nothingNew);
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setBusy(null);
    }
  }

  async function change(next: string | null) {
    setBusy('save');
    const ok = await onChange(next);
    setBusy(null);
    if (ok) {
      setEditing(null);
      setRewrites(null);
    }
  }

  if (editing !== null)
    return (
      <View className="gap-2" testID="main-offer-list-line-editing">
        <Input
          value={editing}
          onChangeText={setEditing}
          maxLength={OFFER_LIST_LIMITS.line}
          accessibilityLabel={LW.edit}
          multiline
          autoFocus
        />
        <View className="flex-row gap-2">
          <Button
            size="md"
            className="flex-1"
            loading={busy === 'save'}
            disabled={!editing.trim()}
            onPress={() => void change(editing)}
            testID="main-offer-list-line-save"
          >
            {LW.save}
          </Button>
          <Button size="md" variant="ghost" onPress={() => setEditing(null)}>
            {LW.cancel}
          </Button>
        </View>
      </View>
    );

  return (
    <View className="gap-1.5 rounded-menu border border-border px-3 py-2.5">
      <Text className="text-[14px] leading-[20px]">{line}</Text>
      {manages ? (
        <View className="flex-row items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            icon={Sparkles}
            loading={busy === 'improve'}
            disabled={busy !== null}
            onPress={() => void improve()}
            testID="main-offer-list-line-improve"
          >
            {busy === 'improve' ? LW.improving : LW.improve}
          </Button>
          <View className="flex-1" />
          <Pressable
            accessibilityLabel={LW.edit}
            onPress={() => setEditing(line)}
            className="size-11 items-center justify-center active:opacity-70"
            testID="main-offer-list-line-edit"
          >
            <Icon as={Pencil} className="size-4 text-text-3" />
          </Pressable>
          <Pressable
            accessibilityLabel={LW.remove}
            disabled={busy !== null}
            onPress={() => void change(null)}
            className="size-11 items-center justify-center active:opacity-70"
            testID="main-offer-list-line-remove"
          >
            <Icon as={X} className="size-4 text-text-3" />
          </Pressable>
        </View>
      ) : null}
      {rewrites ? (
        <View
          className="gap-0.5 border-t border-border pt-2"
          testID="main-offer-list-line-rewrites"
        >
          <Text className="text-[12.5px] text-text-3">{LW.pickRewrite}</Text>
          {rewrites.map((r, i) => (
            <Pressable
              key={r}
              disabled={busy !== null}
              onPress={() => void change(r)}
              className="min-h-11 justify-center py-1.5 active:opacity-70"
              testID={`main-offer-list-line-rewrite-${i}`}
            >
              <Text className="text-[14px] leading-[20px] text-accent-text">{r}</Text>
            </Pressable>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onPress={() => setRewrites(null)}
          >
            {LW.keepMine}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
