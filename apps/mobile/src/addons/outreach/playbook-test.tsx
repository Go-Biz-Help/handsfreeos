import {
  MESSAGE_PLATFORMS,
  PLATFORM_KEYS,
  PLATFORMS,
  type Platform,
} from '@hfos/core/addons/outreach/networks';
import {
  TEST_COMMENT_KEYS,
  TEST_COMMENTS,
  TEST_KNOWN,
  TEST_KNOWN_KEYS,
  TEST_LIMITS,
  TEST_PERSONA_KEYS,
  TEST_PERSONAS,
  TEST_POSTS,
  TEST_QUICK,
  TEST_START,
  TEST_WORDS as T,
  testAdds,
  testFirstName,
  testFull,
  testLinesAfter,
  type PlaybookTestInput,
  type PlaybookTestOutput,
  type TestChatMove,
  type TestComment,
  type TestKnown,
  type TestLine,
  type TestMessage,
  type TestPersona,
  type TestState,
} from '@hfos/core/addons/outreach/playbook-test';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Bot, FlaskConical, MessageCircle, Moon, RotateCcw, Send } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

import { Note } from './kit';

/**
 * A playbook's Test console on the phone (docs/outreach.md, decision 164), as the web has it
 * (apps/web/src/addons/outreach/playbook-test.tsx): make someone up, see the first message that would go to them, then
 * play the chat out. Type their reply, tap a quick one, let them go quiet, or have the AI play them. Each move shows
 * the message that would go, what the AI read in their reply, and what happens next.
 *
 * The worker writes each message with the same writer Today's drafts use (`outreach.playbook.test`), from the saved
 * playbook. Nothing is sent or kept, and it needs signal. The moves, their words and what a move adds to the chat are
 * core's (packages/core/src/addons/outreach/playbook-test.ts).
 *
 * **Try a comment** (decision 165) sits under the chat: what a post says, typed or picked from the examples, then the
 * comment that would wait for an OK under it, or that there'd be none.
 */

/** Asks the worker for a move: what would go, or throws with why not. */
export type AskTest = (input: PlaybookTestInput) => Promise<PlaybookTestOutput>;

export function PlaybookTestSheet({
  playbookId,
  name,
  versions,
  platforms,
  open,
  onClose,
  onAsk,
}: {
  playbookId: string;
  name: string;
  /** How many versions its first message has: more than one shows a picker. */
  versions: number;
  /** The networks it works on: the made-up person is on one that takes messages. */
  platforms: readonly Platform[];
  open: boolean;
  onClose: () => void;
  onAsk: AskTest;
}) {
  const on = MESSAGE_PLATFORMS.filter((p) => platforms.includes(p));
  const messageOn = on.length ? on : MESSAGE_PLATFORMS;
  const [person, setPerson] = React.useState({
    name: '',
    platform: (messageOn[0] ?? 'facebook') as Platform,
    business: '',
    page: '',
    known: 'new' as TestKnown,
  });
  const [version, setVersion] = React.useState(0);
  const [chat, setChat] = React.useState<TestMessage[]>([]);
  const [lines, setLines] = React.useState<TestLine[]>([]);
  const [state, setState] = React.useState<TestState>(TEST_START);
  const [busy, setBusy] = React.useState<TestChatMove | null>(null);
  const [reply, setReply] = React.useState('');
  const [persona, setPersona] = React.useState<TestPersona>('interested');
  const [shown, setShown] = React.useState<number | null>(null);
  const keyboard = useKeyboardHeight();

  const started = chat.some((m) => m.fromMe);
  const full = testFull(chat);

  const reset = () => {
    setChat([]);
    setLines([]);
    setState(TEST_START);
    setReply('');
    setShown(null);
  };

  const move = async (kind: TestChatMove, text = '') => {
    if (busy) return;
    setBusy(kind);
    const fresh = kind === 'start';
    try {
      const out = await onAsk({
        playbookId,
        name,
        person,
        chat: fresh ? [] : chat,
        state: fresh ? TEST_START : state,
        move: kind,
        text,
        persona,
        version,
      });
      const { said, lines: added } = testAdds(out, kind);
      setChat((c) => [...(fresh ? [] : c), ...said]);
      setLines((l) => testLinesAfter(l, added, kind));
      setState(out.state);
      setReply('');
      setShown(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`${T.title}: ${name}`}
      description={T.blurb}
      scroll
      testID="playbook-test"
    >
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="gap-3">
        <Text className="text-[14px] font-semibold">{T.person}</Text>
        <Input
          value={person.name}
          maxLength={TEST_LIMITS.name}
          placeholder={`${T.name}: ${T.namePlaceholder}`}
          accessibilityLabel={T.name}
          editable={busy === null}
          onChangeText={(t) => setPerson((p) => ({ ...p, name: t }))}
          testID="playbook-test-name"
        />
        <Input
          value={person.business}
          maxLength={TEST_LIMITS.business}
          placeholder={`${T.business}: ${T.businessPlaceholder}`}
          accessibilityLabel={T.business}
          editable={busy === null}
          onChangeText={(t) => setPerson((p) => ({ ...p, business: t }))}
          testID="playbook-test-business"
        />
        <Input
          value={person.page}
          multiline
          maxLength={TEST_LIMITS.page}
          placeholder={`${T.page}. ${T.pagePlaceholder}`}
          accessibilityLabel={T.page}
          editable={busy === null}
          onChangeText={(t) => setPerson((p) => ({ ...p, page: t }))}
          className="h-20 py-3"
          testID="playbook-test-page"
        />
        {messageOn.length > 1 ? (
          <Chips
            label={T.platform}
            options={messageOn.map((p) => ({ value: p, label: PLATFORMS[p] }))}
            value={person.platform}
            onChange={(platform) => setPerson((p) => ({ ...p, platform }))}
            disabled={busy !== null}
            testID="playbook-test-platform"
          />
        ) : null}
        <Chips
          label={T.known}
          options={TEST_KNOWN_KEYS.map((k) => ({ value: k, label: TEST_KNOWN[k].label }))}
          value={person.known}
          onChange={(known) => setPerson((p) => ({ ...p, known }))}
          disabled={busy !== null}
          testID="playbook-test-known"
        />
        {versions > 1 ? (
          <Chips
            label={T.version}
            options={Array.from({ length: versions }, (_, i) => ({
              value: String(i),
              label: T.versionN(i + 1),
            }))}
            value={String(version)}
            onChange={(v) => setVersion(Number(v))}
            disabled={busy !== null}
            testID="playbook-test-version"
          />
        ) : null}
        <View className="flex-row flex-wrap items-center gap-2">
          <Button
            icon={FlaskConical}
            loading={busy === 'start'}
            disabled={!person.name.trim() || busy !== null}
            onPress={() => void move('start')}
            testID="playbook-test-start"
          >
            {started ? T.again : T.start}
          </Button>
          {started ? (
            <Button
              size="sm"
              variant="ghost"
              icon={RotateCcw}
              disabled={busy !== null}
              onPress={reset}
              testID="playbook-test-clear"
            >
              {T.clear}
            </Button>
          ) : null}
        </View>

        {lines.length ? (
          <View
            className="gap-2.5 rounded-md border border-border bg-card-2 px-3 py-3"
            accessibilityLiveRegion="polite"
            testID="playbook-test-chat"
          >
            {lines.map((l, i) => {
              switch (l.kind) {
                case 'me':
                  return (
                    <View key={i} className="items-end gap-0.5">
                      <Text className="text-[11.5px] font-medium text-text-3">{l.label}</Text>
                      <View className="max-w-[92%] rounded-[16px] rounded-br-[5px] bg-accent px-3 py-2">
                        <Text
                          className="text-[14px] leading-[20px] text-white"
                          testID="playbook-test-message"
                        >
                          {l.text}
                        </Text>
                      </View>
                      {l.others.length ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() => setShown(shown === i ? null : i)}
                          testID="playbook-test-others"
                        >
                          {shown === i ? T.hideOthers : T.others}
                        </Button>
                      ) : null}
                      {shown === i
                        ? l.others.map((o) => (
                            <View
                              key={o}
                              className="max-w-[92%] rounded-[16px] border border-border bg-card px-3 py-2"
                            >
                              <Text className="text-[13.5px] leading-[19px] text-text-2">{o}</Text>
                            </View>
                          ))
                        : null}
                    </View>
                  );
                case 'them':
                  return (
                    <View key={i} className="items-start gap-0.5">
                      <Text className="text-[11.5px] font-medium text-text-3">
                        {`${testFirstName(person)}${l.played ? ` ${T.played}` : ''}`}
                      </Text>
                      <View className="max-w-[92%] rounded-[16px] rounded-bl-[5px] border border-border bg-card px-3 py-2">
                        <Text className="text-[14px] leading-[20px]" testID="playbook-test-theirs">
                          {l.text}
                        </Text>
                      </View>
                    </View>
                  );
                case 'read':
                  return (
                    <Text
                      key={i}
                      className="text-center text-[12.5px] leading-[17px] text-text-2"
                      testID="playbook-test-read"
                    >
                      <Text className="text-[12.5px] font-medium text-text-2">{`${T.itRead}: `}</Text>
                      {l.text}
                    </Text>
                  );
                case 'note':
                  return (
                    <Text
                      key={i}
                      className="rounded-menu bg-card px-3 py-2 text-[13px] leading-[18px] text-text-2"
                      testID="playbook-test-note"
                    >
                      {l.text}
                    </Text>
                  );
                case 'next':
                  return (
                    <Text
                      key={i}
                      className="rounded-menu bg-card px-3 py-2 text-[13px] leading-[18px] text-text-2"
                      testID="playbook-test-next"
                    >
                      <Text className="text-[13px] font-medium text-text">{`${T.next}: `}</Text>
                      {l.text}
                    </Text>
                  );
              }
            })}
            {busy && busy !== 'start' ? (
              <View className="flex-row items-center gap-2" testID="playbook-test-writing">
                <ActivityIndicator size="small" />
                <Text className="text-[13px] text-text-3">
                  {busy === 'play' ? T.playing : T.writing}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {started ? (
          full ? (
            <Note testID="playbook-test-full">{T.full}</Note>
          ) : (
            <View className="gap-3">
              <Text className="text-[14px] font-semibold">{T.theirTurn}</Text>
              <View className="flex-row flex-wrap gap-1.5">
                {TEST_QUICK.map((q) => (
                  <Button
                    key={q.key}
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onPress={() => void move('reply', q.text)}
                    testID={`playbook-test-quick-${q.key}`}
                  >
                    {q.label}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Moon}
                  disabled={busy !== null}
                  onPress={() => void move('quiet')}
                  testID="playbook-test-quiet"
                >
                  {T.quiet}
                </Button>
              </View>
              <View className="flex-row items-end gap-2">
                <Input
                  value={reply}
                  multiline
                  maxLength={TEST_LIMITS.text}
                  placeholder={T.type}
                  accessibilityLabel={T.type}
                  editable={busy === null}
                  onChangeText={setReply}
                  className="h-16 flex-1 py-2"
                  testID="playbook-test-reply"
                />
                <Button
                  icon={Send}
                  disabled={!reply.trim() || busy !== null}
                  accessibilityLabel={T.send}
                  onPress={() => void move('reply', reply.trim())}
                  testID="playbook-test-send"
                />
              </View>
              <Chips
                label={`${T.play} ${T.playAs}`}
                options={TEST_PERSONA_KEYS.map((k) => ({
                  value: k,
                  label: TEST_PERSONAS[k].label,
                }))}
                value={persona}
                onChange={setPersona}
                disabled={busy !== null}
                testID="playbook-test-persona"
              />
              <Button
                size="sm"
                variant="secondary"
                icon={Bot}
                className="self-start"
                loading={busy === 'play'}
                disabled={busy !== null}
                onPress={() => void move('play')}
                testID="playbook-test-play"
              >
                {T.play}
              </Button>
            </View>
          )
        ) : null}

        <CommentTest
          playbookId={playbookId}
          name={name}
          platforms={platforms}
          person={person}
          onAsk={onAsk}
        />
      </View>
    </Sheet>
  );
}

/**
 * Try a comment (decision 165), as the web has it: what a post says, the kind of comment and the network, then the
 * comment that would wait for an OK under it with the post's own words it is about. A post that gives the AI nothing
 * real to say gets none, and the console says so. It's written to the made-up person above, or to a stand-in when
 * they have no name yet.
 */
function CommentTest({
  playbookId,
  name,
  platforms,
  person,
  onAsk,
}: {
  playbookId: string;
  name: string;
  platforms: readonly Platform[];
  person: { name: string; platform: Platform; business: string; page: string; known: TestKnown };
  onAsk: AskTest;
}) {
  const on = PLATFORM_KEYS.filter((p) => platforms.includes(p));
  const networks = on.length ? on : PLATFORM_KEYS;
  const [post, setPost] = React.useState('');
  const [kind, setKind] = React.useState<TestComment>('warm');
  const [network, setNetwork] = React.useState<Platform>(
    networks.includes('instagram') ? 'instagram' : networks[0]!,
  );
  const [busy, setBusy] = React.useState(false);
  const [out, setOut] = React.useState<PlaybookTestOutput | null>(null);
  const [others, setOthers] = React.useState(false);

  const go = async () => {
    if (busy || !post.trim()) return;
    setBusy(true);
    try {
      setOut(
        await onAsk({
          playbookId,
          name,
          person: { ...person, name: person.name.trim() || T.comment.person, platform: network },
          move: 'comment',
          post: post.trim(),
          comment: kind,
        }),
      );
      setOthers(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-3 border-t border-border pt-4" testID="playbook-test-comment">
      <View className="gap-0.5">
        <Text className="text-[14px] font-semibold">{T.comment.title}</Text>
        <Text className="text-[12.5px] leading-[18px] text-text-3">{T.comment.blurb}</Text>
      </View>
      <Input
        value={post}
        multiline
        maxLength={TEST_LIMITS.post}
        placeholder={`${T.comment.post}. ${T.comment.postPlaceholder}`}
        accessibilityLabel={T.comment.post}
        editable={!busy}
        onChangeText={setPost}
        className="h-24 py-3"
        testID="playbook-test-post"
      />
      <View className="gap-1.5">
        <Text className="text-[13px] font-medium text-text-2">{T.comment.examples}</Text>
        <View className="flex-row flex-wrap gap-1.5">
          {TEST_POSTS.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant="secondary"
              disabled={busy}
              onPress={() => {
                setPost(p.text);
                setKind(p.comment);
                setOut(null);
              }}
              testID={`playbook-test-post-${p.key}`}
            >
              {p.label}
            </Button>
          ))}
        </View>
      </View>
      <Chips
        label={T.comment.kind}
        options={TEST_COMMENT_KEYS.map((k) => ({ value: k, label: TEST_COMMENTS[k].label }))}
        value={kind}
        onChange={setKind}
        disabled={busy}
        testID="playbook-test-comment-kind"
      />
      <Text className="-mt-1.5 text-[12.5px] leading-[18px] text-text-3">
        {TEST_COMMENTS[kind].hint}
      </Text>
      {networks.length > 1 ? (
        <Chips
          label={T.comment.network}
          options={networks.map((p) => ({ value: p, label: PLATFORMS[p] }))}
          value={network}
          onChange={setNetwork}
          disabled={busy}
          testID="playbook-test-comment-network"
        />
      ) : null}
      <Button
        variant="secondary"
        icon={MessageCircle}
        className="self-start"
        loading={busy}
        disabled={!post.trim() || busy}
        onPress={() => void go()}
        testID="playbook-test-comment-go"
      >
        {busy ? T.comment.writing : T.comment.go}
      </Button>

      {out ? (
        <View
          className="gap-2.5 rounded-md border border-border bg-card-2 px-3 py-3"
          accessibilityLiveRegion="polite"
          testID="playbook-test-comment-result"
        >
          {out.message ? (
            <View className="items-end gap-0.5">
              <Text className="text-[11.5px] font-medium text-text-3">{out.label}</Text>
              <View className="max-w-[92%] rounded-[16px] rounded-br-[5px] bg-accent px-3 py-2">
                <Text
                  className="text-[14px] leading-[20px] text-white"
                  testID="playbook-test-comment-text"
                >
                  {out.message}
                </Text>
              </View>
              {out.about ? (
                <Text
                  className="max-w-[92%] text-right text-[12px] leading-[17px] text-text-3"
                  testID="playbook-test-comment-about"
                >
                  {`${T.comment.about}: “${out.about}”`}
                </Text>
              ) : null}
              {out.others.length ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setOthers((o) => !o)}
                  testID="playbook-test-comment-others"
                >
                  {others ? T.hideOthers : T.others}
                </Button>
              ) : null}
              {others
                ? out.others.map((o) => (
                    <View
                      key={o}
                      className="max-w-[92%] rounded-[16px] border border-border bg-card px-3 py-2"
                    >
                      <Text className="text-[13.5px] leading-[19px] text-text-2">{o}</Text>
                    </View>
                  ))
                : null}
            </View>
          ) : null}
          {out.note ? (
            <Text
              className="rounded-menu bg-card px-3 py-2 text-[13px] leading-[18px] text-text-2"
              testID="playbook-test-comment-note"
            >
              {out.note}
            </Text>
          ) : null}
          <Text className="text-[12.5px] leading-[18px] text-text-2">
            {T.comment.aboutYou(out.aboutYou)}
          </Text>
          <Text className="rounded-menu bg-card px-3 py-2 text-[13px] leading-[18px] text-text-2">
            <Text className="text-[13px] font-medium text-text">{`${T.next}: `}</Text>
            {out.next}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** One pick from a few, as chips under what they're for. */
function Chips<V extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  testID,
}: {
  label: string;
  options: readonly { readonly value: V; readonly label: string }[];
  value: V;
  onChange: (value: V) => void;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <View className="gap-1.5" accessibilityLabel={label} testID={testID}>
      <Text className={cn('text-[13px] font-medium text-text-2')}>{label}</Text>
      <View className="flex-row flex-wrap gap-1.5">
        {options.map((o) => (
          <FilterChip
            key={o.value}
            label={o.label}
            on={o.value === value}
            onPress={() => onChange(o.value)}
            disabled={disabled}
            testID={`${testID}-${o.value}`}
          />
        ))}
      </View>
    </View>
  );
}
