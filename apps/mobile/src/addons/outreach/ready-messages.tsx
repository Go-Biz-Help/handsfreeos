import {
  isMine,
  MESSAGE_CHIPS,
  MESSAGE_NOTE_MOST,
  NO_MESSAGE_NOTES,
  slotKey,
  type SamplePart,
  type SampleSlot,
} from '@hfos/core/addons/outreach/conversation';
import { READY_WORDS as R, type ReadinessOutput } from '@hfos/core/addons/outreach/readiness';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Pencil, RefreshCw, Sparkles, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

import { Note } from './kit';

/**
 * Your messages on the phone, under Get ready, as the web's (get-ready.tsx's `MessagesBody`): samples the AI writes for
 * the person's playbook, in their voice, to someone made up (the worker's `outreach.messages.samples`). The first
 * messages, the video, the link, the follow-ups in turn and a check-in, each as it would read in Messenger, to change
 * in their own words (`outreach.messages.edit`) or to have written again with what's not quite right (the worker's
 * `outreach.messages.rewrite`), which the AI then remembers for that part, each note to forget
 * (`outreach.messages.forget`) (decision 87). They read right OKs them against the main offer live now. Samples
 * written for an earlier main offer are written again whole before they're changed or OK'd. It all needs signal.
 */

const M = R.messages;

/** What the person can do with their samples: each says whether it was kept, and is said when it's not. */
export interface MessageActions {
  /** Writes the samples, or writes them all again. */
  readonly write: () => Promise<boolean>;
  /** One sample in the person's own words. */
  readonly edit: (slot: SampleSlot, text: string) => Promise<boolean>;
  /** One sample written again, with what should change. */
  readonly rewrite: (slot: SampleSlot, chips: readonly string[], note: string) => Promise<boolean>;
  /** A note on a part the AI no longer follows. */
  readonly forget: (part: SamplePart, note: string) => Promise<void>;
  /** The playbooks, where how many follow-ups is set. */
  readonly playbooks?: () => void;
}

export function MessagesList({
  readiness,
  onOk,
  actions,
}: {
  readiness: ReadinessOutput;
  onOk: (() => Promise<void>) | null;
  /** Writing and changing them; null where the phone can't, which then says where. */
  actions: MessageActions | null;
}) {
  const [busy, setBusy] = React.useState<'write' | 'ok' | null>(null);
  // The one sample open to change, or to tell the AI what's not quite right.
  const [open, setOpen] = React.useState<{ key: string; how: 'change' | 'more' } | null>(null);
  const samples = readiness.messages.samples;
  // An API from before decision 87 sends no notes.
  const notes = readiness.messages.notes ?? NO_MESSAGE_NOTES;
  const live = readiness.offer?.version ?? null;
  const again = readiness.items.find((i) => i.item === 'messages')?.state === 'look_again';
  const fresh = samples !== null && live !== null && samples.version === live;
  // Written for an earlier version: shown, but written again before they're OK'd or changed.
  const older = samples !== null && live !== null && samples.version !== live;
  const run = async (what: 'write' | 'ok', go: () => Promise<unknown>) => {
    setBusy(what);
    setOpen(null);
    try {
      await go();
    } finally {
      setBusy(null);
    }
  };
  const message = (slot: SampleSlot, text: string) => {
    const key = slotKey(slot);
    return (
      <SampleMessage
        key={key}
        slot={slot}
        text={text}
        mine={samples !== null && isMine(samples, slot)}
        locked={older || !actions}
        waiting={busy !== null}
        how={older ? null : open?.key === key ? open.how : null}
        onOpen={(how) => setOpen(how ? { key, how } : null)}
        actions={actions}
      />
    );
  };
  // What they told the AI of a part, each to forget.
  const told = (part: SamplePart) =>
    actions && notes[part].length ? (
      <View
        className="flex-row flex-wrap items-center gap-1.5"
        testID={`ready-message-notes-${part}`}
      >
        <Text className="text-[12.5px] text-text-3">{M.told}</Text>
        {notes[part].map((n) => (
          <View
            key={n}
            className="flex-row items-center gap-1 rounded-full bg-card-2 py-0.5 pl-2.5 pr-1"
          >
            <Text className="text-[12.5px] text-text-2">{n}</Text>
            <Pressable
              role="button"
              accessibilityLabel={M.forget(n)}
              onPress={() => void actions.forget(part, n)}
              hitSlop={10}
              className="size-6 items-center justify-center rounded-full"
              testID="ready-message-forget"
            >
              <Icon as={X} className="size-3.5 text-text-3" />
            </Pressable>
          </View>
        ))}
      </View>
    ) : null;
  const part = (title: string, children: React.ReactNode, end?: React.ReactNode) => (
    <View className="gap-1.5">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="text-[14px] font-semibold">{title}</Text>
        {end}
      </View>
      {children}
    </View>
  );
  return (
    <View className="mt-1 gap-3" testID="ready-messages-list">
      {samples ? <Note>{M.about(samples.playbookName, samples.version)}</Note> : null}
      {actions ? (
        // Look again is said on the item above, with what changed.
        older && !again ? (
          <Text
            className="rounded-menu bg-warning-soft px-3 py-2.5 text-[13px] leading-[18px] text-warning-text"
            testID="ready-messages-older"
          >
            {M.older}
          </Text>
        ) : samples && !older ? (
          <Note>{M.howTo}</Note>
        ) : null
      ) : !samples ? (
        <Note>{M.onComputer}</Note>
      ) : !fresh ? (
        <Note>{`${M.older} ${M.onComputer}`}</Note>
      ) : null}
      {busy === 'write' ? <Note testID="ready-messages-writing">{M.writing}</Note> : null}
      {samples ? (
        <>
          {part(
            M.first,
            <>
              {told('first')}
              {samples.first.map((t, index) => message({ part: 'first', index }, t))}
            </>,
          )}
          {part(
            M.video,
            samples.video ? (
              <>
                {told('video')}
                {message({ part: 'video', index: 0 }, samples.video)}
              </>
            ) : (
              <Note>{M.noVideo}</Note>
            ),
          )}
          {samples.link
            ? part(
                M.link,
                <>
                  {told('link')}
                  {message({ part: 'link', index: 0 }, samples.link)}
                </>,
              )
            : null}
          {samples.followUps.length
            ? part(
                M.followUps(samples.followUps.length),
                <>
                  {told('followUps')}
                  {samples.followUps.map((t, index) => (
                    <View key={index} className="gap-0.5">
                      <Text className="text-[12px] text-text-3">
                        {M.later(samples.followUpGaps[index] ?? 1)}
                      </Text>
                      {message({ part: 'followUps', index }, t)}
                    </View>
                  ))}
                </>,
                actions?.playbooks ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={actions.playbooks}
                    testID="ready-messages-how-many"
                  >
                    {M.changeHowMany}
                  </Button>
                ) : null,
              )
            : null}
          {samples.checkIn
            ? part(
                M.checkIn,
                <>
                  {told('checkIn')}
                  {message({ part: 'checkIn', index: 0 }, samples.checkIn)}
                </>,
              )
            : null}
        </>
      ) : actions && busy !== 'write' ? (
        <Note testID="ready-messages-none">{M.none}</Note>
      ) : null}
      {actions ? (
        <View className="gap-1.5">
          <Button
            size="md"
            variant={samples ? 'secondary' : 'primary'}
            icon={Sparkles}
            className="self-start"
            loading={busy === 'write'}
            disabled={busy !== null || live === null}
            onPress={() => void run('write', actions.write)}
            testID="ready-messages-write"
          >
            {samples ? M.again : M.write}
          </Button>
          {samples?.mine?.length ? <Note>{M.mineStay}</Note> : null}
        </View>
      ) : null}
      {fresh && onOk ? (
        <Button
          size="md"
          className="self-start"
          loading={busy === 'ok'}
          disabled={busy !== null}
          onPress={() => void run('ok', onOk)}
          testID="ready-messages-ok"
        >
          {M.ok}
        </Button>
      ) : null}
    </View>
  );
}

/**
 * One sample as it would read in Messenger, with what the person can do with it (decision 87): **Change** puts it in
 * their own words, and **Not quite right?** tells the AI what to change, with chips and their own words, and has it
 * written again, still open to try again in one press. Either is kept for that part of their messages.
 */
function SampleMessage({
  slot,
  text,
  mine,
  locked,
  waiting,
  how,
  onOpen,
  actions,
}: {
  slot: SampleSlot;
  text: string;
  mine: boolean;
  /** It can't be changed now: there's nothing to press. */
  locked: boolean;
  /** The rest are being written or OK'd: wait for that. */
  waiting: boolean;
  /** Open to change, or to say what's not quite right; null while shut. */
  how: 'change' | 'more' | null;
  onOpen: (how: 'change' | 'more' | null) => void;
  actions: MessageActions | null;
}) {
  const [draft, setDraft] = React.useState(text);
  React.useEffect(() => setDraft(text), [text, how]);
  const [chips, setChips] = React.useState<readonly string[]>([]);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const save = async () => {
    if (!actions) return;
    setBusy(true);
    try {
      if (await actions.edit(slot, draft)) onOpen(null);
    } finally {
      setBusy(false);
    }
  };
  const rewrite = async () => {
    if (!actions) return;
    setBusy(true);
    try {
      if (await actions.rewrite(slot, chips, note)) {
        setChips([]);
        setNote('');
      }
    } finally {
      setBusy(false);
    }
  };
  const off = busy || waiting;
  return (
    <View className="gap-1" testID="ready-message">
      {how === 'change' ? (
        <View className="gap-2">
          <Input
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={600}
            accessibilityLabel={M.change}
            className="h-32 py-3"
            testID="ready-message-text"
          />
          <View className="flex-row flex-wrap gap-2">
            <Button
              size="sm"
              loading={busy}
              disabled={off || !draft.trim() || draft.trim() === text}
              onPress={() => void save()}
              testID="ready-message-save"
            >
              {M.save}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onPress={() => onOpen(null)}>
              {M.cancel}
            </Button>
          </View>
        </View>
      ) : (
        <View className="max-w-[92%] self-start">
          <Text
            selectable
            className="rounded-[14px] bg-accent-soft px-3 py-2 text-[14px] leading-[20px]"
            testID="ready-message-sample"
          >
            {text}
          </Text>
        </View>
      )}
      <View className="flex-row flex-wrap items-center gap-x-1 gap-y-1">
        {mine ? (
          <View className="flex-row items-center gap-1 pr-2">
            <Icon as={Pencil} className="size-3 text-text-3" />
            <Text className="text-[12px] text-text-3" testID="ready-message-mine">
              {M.yours}
            </Text>
          </View>
        ) : null}
        {!locked && how !== 'change' ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={off}
            onPress={() => onOpen('change')}
            testID="ready-message-change"
          >
            {M.change}
          </Button>
        ) : null}
        {!locked ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={off}
            accessibilityState={{ expanded: how === 'more' }}
            onPress={() => onOpen(how === 'more' ? null : 'more')}
            testID="ready-message-more"
          >
            {M.notQuite}
          </Button>
        ) : null}
      </View>
      {how === 'more' ? (
        <View
          className="gap-2.5 rounded-menu border border-border bg-card-2 p-3"
          testID="ready-message-more-panel"
        >
          <Text className="text-[13.5px] font-semibold">{M.what}</Text>
          <View className="flex-row flex-wrap gap-2">
            {MESSAGE_CHIPS[slot.part].map((c) => (
              <FilterChip
                key={c}
                label={c}
                on={chips.includes(c)}
                onPress={() =>
                  setChips((was) => (was.includes(c) ? was.filter((x) => x !== c) : [...was, c]))
                }
                testID="ready-message-chip"
              />
            ))}
          </View>
          <Text className="text-[13.5px] font-medium">{M.yourWords}</Text>
          <Input
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={MESSAGE_NOTE_MOST}
            placeholder={M.placeholder}
            accessibilityLabel={M.yourWords}
            className="h-20 py-2.5"
            testID="ready-message-note"
          />
          <Button
            size="sm"
            icon={RefreshCw}
            className="self-start"
            loading={busy}
            disabled={off}
            onPress={() => void rewrite()}
            testID="ready-message-rewrite"
          >
            {M.rewrite}
          </Button>
          <Note>{busy ? M.rewriting : M.kept(slot.part)}</Note>
        </View>
      ) : null}
    </View>
  );
}
