'use client';
/**
 * A playbook's Test console (docs/outreach.md, decision 164): make someone up, see the first message that would go to
 * them, then play the chat out. Type their reply, tap a quick one, let them go quiet, or have the AI play them. Each
 * move shows the message that would go, what the AI read in their reply, and what happens next.
 *
 * The worker writes each message with the same writer Today's drafts use (`outreach.playbook.test`), from the
 * playbook as it's handed in: the saved one from the Playbooks page, or what's on screen in the builder, saved or not.
 * Nothing is sent or kept. The moves, their words and the quick replies are core's
 * (packages/core/src/addons/outreach/playbook-test.ts), shared with the phone.
 *
 * **Try a comment** (decision 165) sits under the chat: paste what a post says, or tap an example, and see the comment
 * that would wait for an OK under it, or that there'd be none.
 */
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
  type PlaybookTestOutput,
  type TestChatMove,
  type TestComment,
  type TestKnown,
  type TestLine,
  type TestMessage,
  type TestPersona,
  type TestState,
} from '@hfos/core/addons/outreach/playbook-test';
import { Bot, FlaskConical, Loader2, MessageCircle, MoonStar, RotateCcw, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';

export interface PlaybookTestProps {
  workspaceId: string;
  /** The saved playbook, when it is one. */
  playbookId: string | null;
  name: string;
  /** The playbook as it is on screen, when it's open in the builder. Left out, the saved one is tested. */
  details?: unknown;
  /** How many versions its first message has: more than one shows a picker. */
  versions: number;
  /** The networks it works on: the first that takes messages is where the made-up person starts. */
  platforms: readonly Platform[];
  open: boolean;
  onClose: () => void;
}

export function PlaybookTest({
  workspaceId,
  playbookId,
  name,
  details,
  versions,
  platforms,
  open,
  onClose,
}: PlaybookTestProps) {
  const messageOn = MESSAGE_PLATFORMS.filter((p) => platforms.includes(p));
  const [person, setPerson] = useState({
    name: '',
    platform: (messageOn[0] ?? 'facebook') as Platform,
    business: '',
    page: '',
    known: 'new' as TestKnown,
  });
  const [version, setVersion] = useState(0);
  const [chat, setChat] = useState<TestMessage[]>([]);
  const [lines, setLines] = useState<TestLine[]>([]);
  const [state, setState] = useState<TestState>(TEST_START);
  const [busy, setBusy] = useState<TestChatMove | null>(null);
  const [reply, setReply] = useState('');
  const [persona, setPersona] = useState<TestPersona>('interested');
  const [shown, setShown] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [lines.length, busy]);

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
      const out = await workerPost<PlaybookTestOutput>(
        '/v1/addons/outreach/actions/outreach.playbook.test',
        {
          workspaceId,
          input: {
            playbookId,
            name,
            ...(details !== undefined ? { details } : {}),
            person,
            chat: fresh ? [] : chat,
            state: fresh ? TEST_START : state,
            move: kind,
            text,
            persona,
            version,
          },
        },
      );
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
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={`${T.title}: ${name || 'this playbook'}`} description={T.blurb}>
        <div className="space-y-4" data-testid="playbook-test">
          {details !== undefined ? <p className="text-[12.5px] text-text-3">{T.unsaved}</p> : null}
          <fieldset className="space-y-3" disabled={busy !== null}>
            <legend className="mb-1 text-[13px] font-semibold">{T.person}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={T.name} htmlFor="pt-name">
                <Input
                  id="pt-name"
                  value={person.name}
                  maxLength={TEST_LIMITS.name}
                  placeholder={T.namePlaceholder}
                  onChange={(e) => setPerson((p) => ({ ...p, name: e.target.value }))}
                  data-testid="playbook-test-name"
                />
              </Field>
              <Field label={T.platform} htmlFor="pt-platform">
                <Select
                  id="pt-platform"
                  value={person.platform}
                  onChange={(e) =>
                    setPerson((p) => ({ ...p, platform: e.target.value as Platform }))
                  }
                >
                  {(messageOn.length ? messageOn : MESSAGE_PLATFORMS).map((p) => (
                    <option key={p} value={p}>
                      {PLATFORMS[p]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={T.business} htmlFor="pt-business">
              <Input
                id="pt-business"
                value={person.business}
                maxLength={TEST_LIMITS.business}
                placeholder={T.businessPlaceholder}
                onChange={(e) => setPerson((p) => ({ ...p, business: e.target.value }))}
                data-testid="playbook-test-business"
              />
            </Field>
            <Field label={T.page} htmlFor="pt-page">
              <Textarea
                id="pt-page"
                rows={2}
                className="min-h-[60px]"
                value={person.page}
                maxLength={TEST_LIMITS.page}
                placeholder={T.pagePlaceholder}
                onChange={(e) => setPerson((p) => ({ ...p, page: e.target.value }))}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={T.known} htmlFor="pt-known">
                <Select
                  id="pt-known"
                  value={person.known}
                  onChange={(e) => setPerson((p) => ({ ...p, known: e.target.value as TestKnown }))}
                >
                  {TEST_KNOWN_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {TEST_KNOWN[k].label}
                    </option>
                  ))}
                </Select>
              </Field>
              {versions > 1 ? (
                <Field label={T.version} htmlFor="pt-version">
                  <Select
                    id="pt-version"
                    value={String(version)}
                    onChange={(e) => setVersion(Number(e.target.value))}
                  >
                    {Array.from({ length: versions }, (_, i) => (
                      <option key={i} value={i}>
                        {T.versionN(i + 1)}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => void move('start')}
                loading={busy === 'start'}
                disabled={!person.name.trim()}
                data-testid="playbook-test-start"
              >
                <FlaskConical className="h-4 w-4" />
                {started ? T.again : T.start}
              </Button>
              {started ? (
                <Button variant="ghost" size="sm" onClick={reset}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {T.clear}
                </Button>
              ) : null}
            </div>
          </fieldset>

          {lines.length ? (
            <div
              className="space-y-2.5 rounded-card border border-border bg-card-2 p-3"
              aria-live="polite"
              data-testid="playbook-test-chat"
            >
              {lines.map((l, i) => {
                switch (l.kind) {
                  case 'me':
                    return (
                      <div key={i} className="flex flex-col items-end">
                        <span className="mb-0.5 text-[11.5px] font-medium text-text-3">
                          {l.label}
                        </span>
                        <div
                          className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3 py-2 text-[14px] text-white"
                          data-testid="playbook-test-message"
                        >
                          {l.text}
                        </div>
                        {l.others.length ? (
                          <button
                            type="button"
                            className="mt-1 text-[12px] text-accent-text hover:underline"
                            onClick={() => setShown(shown === i ? null : i)}
                          >
                            {shown === i ? T.hideOthers : T.others}
                          </button>
                        ) : null}
                        {shown === i
                          ? l.others.map((o) => (
                              <div
                                key={o}
                                className="mt-1 max-w-[92%] whitespace-pre-wrap rounded-2xl border border-border bg-card px-3 py-2 text-[13.5px] text-text-2"
                              >
                                {o}
                              </div>
                            ))
                          : null}
                      </div>
                    );
                  case 'them':
                    return (
                      <div key={i} className="flex flex-col items-start">
                        <span className="mb-0.5 text-[11.5px] font-medium text-text-3">
                          {testFirstName(person)}
                          {l.played ? ` ${T.played}` : ''}
                        </span>
                        <div className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-border bg-card px-3 py-2 text-[14px]">
                          {l.text}
                        </div>
                      </div>
                    );
                  case 'read':
                    return (
                      <p key={i} className="text-center text-[12.5px] text-text-2">
                        <span className="font-medium">{T.itRead}:</span> {l.text}
                      </p>
                    );
                  case 'note':
                    return (
                      <Callout key={i} tone="neutral">
                        {l.text}
                      </Callout>
                    );
                  case 'next':
                    return (
                      <p
                        key={i}
                        className="rounded-control bg-card px-3 py-2 text-[13px] text-text-2"
                        data-testid="playbook-test-next"
                      >
                        <span className="font-medium text-text">{T.next}:</span> {l.text}
                      </p>
                    );
                }
              })}
              {busy && busy !== 'start' ? (
                <p className="flex items-center gap-2 text-[13px] text-text-3">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {busy === 'play' ? T.playing : T.writing}
                </p>
              ) : null}
              <div ref={end} />
            </div>
          ) : null}

          {started ? (
            full ? (
              <Callout tone="neutral">{T.full}</Callout>
            ) : (
              <fieldset className="space-y-3" disabled={busy !== null}>
                <legend className="mb-1 text-[13px] font-semibold">{T.theirTurn}</legend>
                <div className="flex flex-wrap gap-1.5">
                  {TEST_QUICK.map((q) => (
                    <Button
                      key={q.key}
                      variant="secondary"
                      size="sm"
                      onClick={() => void move('reply', q.text)}
                      data-testid={`playbook-test-quick-${q.key}`}
                    >
                      {q.label}
                    </Button>
                  ))}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void move('quiet')}
                    data-testid="playbook-test-quiet"
                  >
                    <MoonStar className="h-3.5 w-3.5" />
                    {T.quiet}
                  </Button>
                </div>
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (reply.trim()) void move('reply', reply.trim());
                  }}
                >
                  <Textarea
                    aria-label={T.type}
                    rows={2}
                    className="min-h-[52px] flex-1"
                    value={reply}
                    maxLength={TEST_LIMITS.text}
                    placeholder={T.type}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && reply.trim()) {
                        e.preventDefault();
                        void move('reply', reply.trim());
                      }
                    }}
                    data-testid="playbook-test-reply"
                  />
                  <Button type="submit" disabled={!reply.trim()} aria-label={T.send}>
                    <Send className="h-4 w-4" />
                  </Button>
                </form>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void move('play')}
                    data-testid="playbook-test-play"
                  >
                    <Bot className="h-3.5 w-3.5" />
                    {T.play}
                  </Button>
                  <label className="flex items-center gap-1.5 text-[13px] text-text-2">
                    {T.playAs}
                    <Select
                      aria-label={T.whoPlays}
                      selectSize="sm"
                      value={persona}
                      onChange={(e) => setPersona(e.target.value as TestPersona)}
                    >
                      {TEST_PERSONA_KEYS.map((k) => (
                        <option key={k} value={k}>
                          {TEST_PERSONAS[k].label.toLowerCase()}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
              </fieldset>
            )
          ) : null}

          <CommentTest
            workspaceId={workspaceId}
            playbookId={playbookId}
            name={name}
            details={details}
            platforms={platforms}
            person={person}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Try a comment (decision 165): what a post says, pasted or picked from the examples, the kind of comment and the
 * network, then the comment that would wait for an OK under it, with the post's own words it is about. A post that
 * gives the AI nothing real to say gets none, and the console says so. It's written to the made-up person above, or
 * to a stand-in when they have no name yet.
 */
function CommentTest({
  workspaceId,
  playbookId,
  name,
  details,
  platforms,
  person,
}: Pick<PlaybookTestProps, 'workspaceId' | 'playbookId' | 'name' | 'details' | 'platforms'> & {
  person: { name: string; platform: Platform; business: string; page: string; known: TestKnown };
}) {
  const networks = PLATFORM_KEYS.filter((p) => platforms.includes(p));
  const [post, setPost] = useState('');
  const [kind, setKind] = useState<TestComment>('warm');
  const [network, setNetwork] = useState<Platform>(
    networks.includes('instagram') ? 'instagram' : (networks[0] ?? 'instagram'),
  );
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<PlaybookTestOutput | null>(null);
  const [others, setOthers] = useState(false);

  const go = async () => {
    if (busy || !post.trim()) return;
    setBusy(true);
    try {
      setOut(
        await workerPost<PlaybookTestOutput>('/v1/addons/outreach/actions/outreach.playbook.test', {
          workspaceId,
          input: {
            playbookId,
            name,
            ...(details !== undefined ? { details } : {}),
            person: {
              ...person,
              name: person.name.trim() || T.comment.person,
              platform: network,
            },
            move: 'comment',
            post: post.trim(),
            comment: kind,
          },
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
    <fieldset
      className="space-y-3 border-t border-border pt-4"
      disabled={busy}
      data-testid="playbook-test-comment"
    >
      <legend className="sr-only">{T.comment.title}</legend>
      <div>
        <h3 className="text-[13px] font-semibold">{T.comment.title}</h3>
        <p className="mt-0.5 text-[12.5px] text-text-3">{T.comment.blurb}</p>
      </div>
      <Field label={T.comment.post} htmlFor="pt-post">
        <Textarea
          id="pt-post"
          rows={3}
          className="min-h-[72px]"
          value={post}
          maxLength={TEST_LIMITS.post}
          placeholder={T.comment.postPlaceholder}
          onChange={(e) => setPost(e.target.value)}
          data-testid="playbook-test-post"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12.5px] text-text-3">{T.comment.examples}</span>
        {TEST_POSTS.map((p) => (
          <Button
            key={p.key}
            variant="secondary"
            size="sm"
            onClick={() => {
              setPost(p.text);
              setKind(p.comment);
              setOut(null);
            }}
            data-testid={`playbook-test-post-${p.key}`}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={T.comment.kind} htmlFor="pt-comment-kind" hint={TEST_COMMENTS[kind].hint}>
          <Select
            id="pt-comment-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as TestComment)}
          >
            {TEST_COMMENT_KEYS.map((k) => (
              <option key={k} value={k}>
                {TEST_COMMENTS[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={T.comment.network} htmlFor="pt-comment-network">
          <Select
            id="pt-comment-network"
            value={network}
            onChange={(e) => setNetwork(e.target.value as Platform)}
          >
            {(networks.length ? networks : PLATFORM_KEYS).map((p) => (
              <option key={p} value={p}>
                {PLATFORMS[p]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button
        variant="secondary"
        onClick={() => void go()}
        loading={busy}
        disabled={!post.trim()}
        data-testid="playbook-test-comment-go"
      >
        <MessageCircle className="h-4 w-4" />
        {busy ? T.comment.writing : T.comment.go}
      </Button>

      {out ? (
        <div
          className="space-y-2.5 rounded-card border border-border bg-card-2 p-3"
          aria-live="polite"
          data-testid="playbook-test-comment-result"
        >
          {out.message ? (
            <div className="flex flex-col items-end">
              <span className="mb-0.5 text-[11.5px] font-medium text-text-3">{out.label}</span>
              <div
                className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3 py-2 text-[14px] text-white"
                data-testid="playbook-test-comment-text"
              >
                {out.message}
              </div>
              {out.about ? (
                <p className="mt-1 max-w-[92%] text-right text-[12px] text-text-3">
                  {T.comment.about}: “{out.about}”
                </p>
              ) : null}
              {out.others.length ? (
                <button
                  type="button"
                  className="mt-1 text-[12px] text-accent-text hover:underline"
                  onClick={() => setOthers((o) => !o)}
                >
                  {others ? T.hideOthers : T.others}
                </button>
              ) : null}
              {others
                ? out.others.map((o) => (
                    <div
                      key={o}
                      className="mt-1 max-w-[92%] whitespace-pre-wrap rounded-2xl border border-border bg-card px-3 py-2 text-[13.5px] text-text-2"
                    >
                      {o}
                    </div>
                  ))
                : null}
            </div>
          ) : null}
          {out.note ? <Callout tone="neutral">{out.note}</Callout> : null}
          <p className="text-[12.5px] text-text-2">{T.comment.aboutYou(out.aboutYou)}</p>
          <p className="rounded-control bg-card px-3 py-2 text-[13px] text-text-2">
            <span className="font-medium text-text">{T.next}:</span> {out.next}
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
