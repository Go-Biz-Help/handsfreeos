import { NETWORK_WORDS as NW } from '@hfos/core/addons/outreach/network-words';
import { PLATFORM_KEYS, PLATFORMS, WORKING_PLATFORMS } from '@hfos/core/addons/outreach/networks';
import { scriptMinutes, VIDEO_PARTS, VIDEO_WORDS as V } from '@hfos/core/addons/outreach/video';
import { OUTREACH_WORDS as W, playbookSectionTitle } from '@hfos/core/addons/outreach/words';
import {
  ANSWER_NEXT_KEYS,
  answerNextLabel,
  nextQuestionId,
  followUpGapsFor,
  PACE_LIMITS,
  paceOf,
  PLAYBOOK_GOAL_KEYS,
  PLAYBOOK_GOALS,
  PLAYBOOK_STEP_KEYS,
  PLAYBOOK_STEPS,
  PlaybookSaveInput,
  type Playbook,
  type PlaybookDetails,
  type PlaybookQuestion,
} from '@hfos/core/addons/outreach/playbooks';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Archive, Check, Plus, RotateCcw, Trash } from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import {
  NeedsSignal,
  Note,
  openOutreach,
  Part,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';

/**
 * One playbook on the phone (decision 44): each part of it, and for owners and admins, changing it a part at a time
 * in a sheet. Before each save the phone asks for the playbook again and puts only the part changed on what it finds,
 * so a change made meanwhile on the web isn't undone. The AI's help (Improve, Suggest more) is on the web. It needs
 * signal. Its networks are one part: one playbook for every network (Chris), at least one picked.
 */

export type Section = keyof typeof W.playbookSections | 'name';

/** The fields of the details each part changes. */
export const SECTION_FIELDS: Readonly<
  Record<Exclude<Section, 'name'>, readonly (keyof PlaybookDetails)[]>
> = {
  goal: ['goal'],
  offer: ['offer', 'link'],
  audience: ['audience'],
  signs: ['signs'],
  skip: ['skip'],
  area: ['area'],
  networks: ['platforms'],
  groupWords: ['groupWords'],
  steps: ['steps'],
  pace: ['pace'],
  // The short video's link (decision 69): its script is written on the web, with the AI.
  video: ['videoLink'],
  tone: ['tone'],
  samples: ['samples'],
  openers: ['openerStyles', 'ownOpeners'],
  questions: ['questions'],
  avoid: ['avoid'],
  disclaimer: ['disclaimer'],
  tags: ['tags'],
};
const SECTIONS = Object.keys(SECTION_FIELDS) as Exclude<Section, 'name'>[];

/** The playbook as it is now, with only the part changed on the phone put on it. */
export function mergeSection(
  fresh: Pick<Playbook, 'name' | 'details'>,
  draft: Pick<Playbook, 'name' | 'details'>,
  section: Section,
): Pick<Playbook, 'name' | 'details'> {
  if (section === 'name') return { name: draft.name, details: fresh.details };
  const details: Record<string, unknown> = { ...fresh.details };
  for (const field of SECTION_FIELDS[section]) details[field] = draft.details[field];
  return { name: fresh.name, details: details as PlaybookDetails };
}

const linesOf = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** A part's words, read: what it says, or "Nothing yet." */
export function sectionWords(details: PlaybookDetails, section: Exclude<Section, 'name'>): string {
  const or = (s: string | null | undefined) => (s && s.trim() ? s : W.empty);
  const list = (l: readonly string[]) => (l.length ? l.join('\n') : W.empty);
  switch (section) {
    case 'goal':
      return PLAYBOOK_GOALS[details.goal];
    case 'offer':
      return [details.offer, details.link].filter(Boolean).join('\n') || W.empty;
    case 'steps':
      return details.steps.length
        ? details.steps.map((s) => PLAYBOOK_STEPS[s].label).join(' · ')
        : W.empty;
    case 'networks':
      return details.platforms.length
        ? details.platforms.map((p) => PLATFORMS[p]).join(' · ')
        : W.empty;
    case 'pace':
      return (
        W.pace(
          details.steps.includes('message') ? details.pace.messageAfterDays : null,
          details.steps.includes('follow_up') ? paceOf(details.pace).followUps : null,
        ) || W.empty
      );
    case 'video': {
      const script = details.videoScript;
      return [
        details.videoLink?.trim() || V.summary(false, Boolean(script)),
        script
          ? [
              V.runs(scriptMinutes(script)),
              ...script.parts.map(
                (p, i) => `${i + 1} · ${VIDEO_PARTS[p.part].title}\n${p.say}\n${V.show}: ${p.show}`,
              ),
            ].join('\n\n')
          : V.onComputer,
      ].join('\n\n');
    }
    case 'openers':
      return list([...details.openerStyles, ...details.ownOpeners]);
    case 'questions':
      return details.questions.length
        ? details.questions
            .map((q) =>
              [
                q.text,
                ...q.answers.map(
                  (a) => `  ${a.label}: ${answerNextLabel(a.next, details.questions)}`,
                ),
              ].join('\n'),
            )
            .join('\n')
        : W.empty;
    case 'audience':
    case 'area':
    case 'tone':
    case 'disclaimer':
      return or(details[section]);
    default:
      return list(details[section]);
  }
}

async function loadPlaybook(workspaceId: string, playbookId: string): Promise<Playbook | null> {
  const { playbooks } = unwrap(
    await api.POST('/v1/queries/outreach.playbook.list', { body: { workspaceId } }),
  );
  return playbooks.find((p) => p.id === playbookId) ?? null;
}

const failed = (e: unknown) => toast.error(e instanceof ChangeError ? e.message : errorMessage(e));

export function PlaybookScreen({ playbookId }: { playbookId: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const answer = useOutreachAnswer(
    () => loadPlaybook(ws, playbookId),
    `playbook:${ws}:${playbookId}`,
    W.rows.playbooks,
  );
  return (
    <PlaybookBody
      playbook={answer.data}
      loading={answer.loading}
      error={answer.error}
      manages={ctx.manages}
      online={ctx.online}
      onRetry={answer.reload}
      onPlaybooks={() => openOutreach(ws, 'playbooks')}
      onSave={async (loaded, draft, section) => {
        try {
          // What's there now: someone may have changed it on the web meanwhile.
          const fresh = (await loadPlaybook(ws, playbookId)) ?? loaded;
          const merged = mergeSection(fresh, draft, section);
          const input = PlaybookSaveInput.safeParse({
            workspaceId: ws,
            playbookId,
            name: merged.name,
            details: merged.details,
          });
          if (!input.success) return input.error.issues[0]?.message ?? W.tryAgain;
          await change('outreach.playbook.save', input.data);
          toast.show(fresh.updatedAt !== loaded.updatedAt ? W.changedSince : W.savedForEveryone);
          answer.reload();
          return null;
        } catch (e) {
          return e instanceof ChangeError ? e.message : errorMessage(e);
        }
      }}
      onArchive={async (archived) => {
        try {
          await change('outreach.playbook.archive', { workspaceId: ws, playbookId, archived });
          toast.show(archived ? W.archivedDone : W.backDone);
          answer.reload();
        } catch (e) {
          failed(e);
        }
      }}
    />
  );
}

export function PlaybookBody({
  playbook,
  loading = false,
  error,
  manages,
  online,
  onRetry,
  onPlaybooks,
  onSave,
  onArchive,
}: {
  playbook: Playbook | null;
  /** The first answer is on its way. */
  loading?: boolean;
  error: string | null;
  manages: boolean;
  online: boolean;
  onRetry: () => void;
  /** Back to the list of playbooks. */
  onPlaybooks?: () => void;
  /** Saves one part: null when it's saved, else what's wrong. */
  onSave: (
    loaded: Playbook,
    draft: Pick<Playbook, 'name' | 'details'>,
    section: Section,
  ) => Promise<string | null>;
  onArchive: (archived: boolean) => void;
}) {
  const [editing, setEditing] = React.useState<Section | null>(null);
  if (!playbook)
    return (
      <Screen title={W.rows.playbooks} leading="back" testID="outreach-playbook">
        {error ? (
          <NeedsSignal words={error} onRetry={onRetry} testID="playbook-needs-signal" />
        ) : loading ? (
          <ActivityIndicator className="py-8" testID="playbook-loading" />
        ) : (
          <Card className="gap-3 px-5 py-6" testID="playbook-missing">
            <Note>{W.playbookMissing}</Note>
            {onPlaybooks ? (
              <Button variant="secondary" onPress={onPlaybooks} testID="playbook-missing-back">
                {W.rows.playbooks}
              </Button>
            ) : null}
          </Card>
        )}
      </Screen>
    );
  const canEdit = manages && online;
  return (
    <Screen
      title={playbook.name}
      subtitle={playbook.archivedAt ? W.archived : W.inUse}
      leading="back"
      testID="outreach-playbook"
    >
      {manages ? <Note>{W.aiOnTheWeb}</Note> : <Note>{W.readOnly}</Note>}
      {manages && !online ? <NeedsSignal words={W.needsSignal(W.rows.playbooks)} /> : null}
      <List>
        <ListRow
          label={W.name}
          detail={playbook.name}
          onPress={canEdit ? () => setEditing('name') : undefined}
          chevron={canEdit}
          testID="playbook-name"
        />
      </List>
      {SECTIONS.map((section) => (
        <Part
          key={section}
          title={playbookSectionTitle(section, playbook.details)}
          testID={`playbook-${section}`}
        >
          <Card className="gap-2 px-4 py-3">
            <Text className="text-[14px] leading-[20px]">
              {sectionWords(playbook.details, section)}
            </Text>
            {canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                onPress={() => setEditing(section)}
                testID={`playbook-edit-${section}`}
              >
                {W.change}
              </Button>
            ) : null}
          </Card>
        </Part>
      ))}
      {manages ? (
        <Button
          variant="secondary"
          icon={playbook.archivedAt ? RotateCcw : Archive}
          disabled={!online}
          onPress={() => onArchive(!playbook.archivedAt)}
          testID="playbook-archive"
        >
          {playbook.archivedAt ? W.bringBack : W.archive}
        </Button>
      ) : null}
      <SectionSheet
        playbook={playbook}
        section={editing}
        onClose={() => setEditing(null)}
        onSave={onSave}
      />
    </Screen>
  );
}

function SectionSheet({
  playbook,
  section,
  onClose,
  onSave,
}: {
  playbook: Playbook;
  section: Section | null;
  onClose: () => void;
  onSave: (
    loaded: Playbook,
    draft: Pick<Playbook, 'name' | 'details'>,
    section: Section,
  ) => Promise<string | null>;
}) {
  const [draft, setDraft] = React.useState<Pick<Playbook, 'name' | 'details'>>(playbook);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (section) {
      setDraft({ name: playbook.name, details: playbook.details });
      setProblem(null);
    }
  }, [section, playbook]);
  const set = (part: Partial<PlaybookDetails>) =>
    setDraft((d) => ({ ...d, details: { ...d.details, ...part } }));
  const save = async () => {
    if (!section) return;
    setBusy(true);
    const wrong = await onSave(playbook, draft, section);
    setBusy(false);
    if (wrong) setProblem(wrong);
    else onClose();
  };
  const title = section
    ? section === 'name'
      ? W.name
      : playbookSectionTitle(section, playbook.details)
    : undefined;
  return (
    <Sheet open={section !== null} onClose={onClose} title={title} scroll testID="playbook-sheet">
      <View className="gap-3">
        {section ? (
          <SectionEditor section={section} draft={draft} set={set} setDraft={setDraft} />
        ) : null}
        {problem ? (
          <Text className="text-[13.5px] text-danger" testID="playbook-problem">
            {problem}
          </Text>
        ) : null}
        <Button loading={busy} onPress={() => void save()} testID="playbook-save">
          {W.save}
        </Button>
      </View>
    </Sheet>
  );
}

function LinesInput({
  value,
  onChange,
  testID,
}: {
  value: readonly string[];
  onChange: (lines: string[]) => void;
  testID?: string;
}) {
  const [text, setText] = React.useState(value.join('\n'));
  return (
    <View className="gap-1">
      <Input
        value={text}
        onChangeText={(t) => {
          setText(t);
          onChange(linesOf(t));
        }}
        multiline
        className="h-32 py-3"
        testID={testID}
      />
      <Note>{W.oneALine}</Note>
    </View>
  );
}

function WordsInput({
  value,
  onChange,
  placeholder,
  multiline = true,
  testID,
}: {
  value: string | null;
  onChange: (words: string | null) => void;
  placeholder?: string;
  multiline?: boolean;
  testID?: string;
}) {
  return (
    <Input
      value={value ?? ''}
      onChangeText={(t) => onChange(t.trim() ? t : null)}
      placeholder={placeholder}
      multiline={multiline}
      className={multiline ? 'h-28 py-3' : undefined}
      testID={testID}
    />
  );
}

function SectionEditor({
  section,
  draft,
  set,
  setDraft,
}: {
  section: Section;
  draft: Pick<Playbook, 'name' | 'details'>;
  set: (part: Partial<PlaybookDetails>) => void;
  setDraft: React.Dispatch<React.SetStateAction<Pick<Playbook, 'name' | 'details'>>>;
}) {
  const d = draft.details;
  switch (section) {
    case 'name':
      return (
        <Input
          value={draft.name}
          onChangeText={(name) => setDraft((x) => ({ ...x, name }))}
          testID="playbook-edit-name-input"
        />
      );
    case 'goal':
      return (
        <List>
          {PLAYBOOK_GOAL_KEYS.map((g) => (
            <ListRow
              key={g}
              label={PLAYBOOK_GOALS[g]}
              end={d.goal === g ? <Icon as={Check} className="size-5 text-accent" /> : undefined}
              chevron={false}
              onPress={() => set({ goal: g })}
              testID={`playbook-goal-${g}`}
            />
          ))}
        </List>
      );
    case 'offer':
      return (
        <>
          <WordsInput
            value={d.offer}
            onChange={(offer) => set({ offer })}
            placeholder={W.offerLabel}
          />
          <WordsInput
            value={d.link}
            onChange={(link) => set({ link: link?.trim() ?? null })}
            placeholder={W.linkLabel}
            multiline={false}
          />
        </>
      );
    case 'video':
      return (
        <>
          <WordsInput
            value={d.videoLink ?? null}
            onChange={(link) => set({ videoLink: link?.trim() || null })}
            placeholder={V.linkPlaceholder}
            multiline={false}
            testID="playbook-video-link"
          />
          <Note>{V.linkHint}</Note>
          <Note>{V.onComputer}</Note>
        </>
      );
    case 'audience':
    case 'area':
    case 'tone':
    case 'disclaimer':
      return (
        <WordsInput
          value={d[section]}
          onChange={(v) => set({ [section]: v })}
          testID="playbook-words"
        />
      );
    case 'networks':
      return (
        <View className="gap-3">
          <Note>{NW.playbookAbout}</Note>
          {WORKING_PLATFORMS.map((p) => {
            const on = d.platforms.includes(p);
            return (
              <View key={p} className="flex-row items-center gap-3">
                <View className="flex-1">
                  <Text className="text-[14.5px] font-medium">{PLATFORMS[p]}</Text>
                  <Note>{NW.where(p)}</Note>
                </View>
                <Switch
                  label={PLATFORMS[p]}
                  checked={on}
                  disabled={on && d.platforms.length === 1}
                  onCheckedChange={(v) =>
                    set({
                      platforms: PLATFORM_KEYS.filter((k) =>
                        k === p ? v : d.platforms.includes(k),
                      ),
                    })
                  }
                  testID={`playbook-network-${p}`}
                />
              </View>
            );
          })}
        </View>
      );
    case 'steps':
      return (
        <View className="gap-3">
          {PLAYBOOK_STEP_KEYS.map((step) => {
            const on = d.steps.includes(step);
            return (
              <View key={step} className="flex-row items-center gap-3">
                <View className="flex-1">
                  <Text className="text-[14.5px] font-medium">{PLAYBOOK_STEPS[step].label}</Text>
                  <Note>{PLAYBOOK_STEPS[step].hint}</Note>
                </View>
                <Switch
                  label={PLAYBOOK_STEPS[step].label}
                  checked={on}
                  onCheckedChange={(v) =>
                    set({
                      steps: PLAYBOOK_STEP_KEYS.filter((s) =>
                        s === step ? v : d.steps.includes(s),
                      ),
                    })
                  }
                  testID={`playbook-step-${step}`}
                />
              </View>
            );
          })}
        </View>
      );
    case 'pace': {
      const pace = paceOf(d.pace);
      return (
        <>
          <DaysInput
            label={W.messageAfter}
            value={d.pace.messageAfterDays}
            limits={PACE_LIMITS.messageAfterDays}
            onChange={(messageAfterDays) => set({ pace: { ...d.pace, messageAfterDays } })}
          />
          <DaysInput
            label={W.followUpAfter}
            value={pace.followUps}
            limits={PACE_LIMITS.followUps}
            onChange={(followUps) =>
              set({
                pace: {
                  ...d.pace,
                  followUps,
                  // A new count keeps the gaps already set, and starts any new ones where they'd start.
                  followUpGaps: followUpGapsFor(followUps).map((g, i) => pace.followUpGaps[i] ?? g),
                },
              })
            }
          />
          {pace.followUpGaps.map((gap, i) => (
            <DaysInput
              key={`gap-${i}`}
              label={W.followUpGap(i + 1)}
              value={gap}
              limits={PACE_LIMITS.followUpGap}
              onChange={(days) =>
                set({
                  pace: {
                    ...d.pace,
                    followUps: pace.followUps,
                    followUpGaps: pace.followUpGaps.map((g, j) => (j === i ? days : g)),
                  },
                })
              }
            />
          ))}
        </>
      );
    }
    case 'openers':
      return (
        <>
          <Text className="text-[14px] font-medium">{W.openerStyles}</Text>
          <LinesInput value={d.openerStyles} onChange={(openerStyles) => set({ openerStyles })} />
          <Text className="text-[14px] font-medium">{W.ownOpeners}</Text>
          <LinesInput value={d.ownOpeners} onChange={(ownOpeners) => set({ ownOpeners })} />
        </>
      );
    case 'questions':
      return (
        <QuestionsEditor
          questions={d.questions}
          tags={d.tags}
          onChange={(questions) => set({ questions })}
        />
      );
    default:
      return (
        <LinesInput
          value={d[section]}
          onChange={(lines) => set({ [section]: lines })}
          testID="playbook-lines"
        />
      );
  }
}

function DaysInput({
  label,
  value,
  limits,
  onChange,
}: {
  label: string;
  value: number;
  limits: { readonly min: number; readonly max: number };
  onChange: (days: number) => void;
}) {
  const [text, setText] = React.useState(String(value));
  return (
    <View className="gap-1">
      <Text className="text-[14px] font-medium">{label}</Text>
      <Input
        value={text}
        keyboardType="number-pad"
        onChangeText={(t) => {
          setText(t);
          const n = Number(t);
          if (t.trim() && Number.isInteger(n)) onChange(n);
        }}
      />
      <Note>{`${limits.min}–${limits.max}`}</Note>
    </View>
  );
}

/** The conversation: each question, its answers, and what each leads to and tags. */
function QuestionsEditor({
  questions,
  tags,
  onChange,
}: {
  questions: readonly PlaybookQuestion[];
  tags: readonly string[];
  onChange: (questions: PlaybookQuestion[]) => void;
}) {
  const put = (i: number, q: PlaybookQuestion) =>
    onChange(questions.map((x, j) => (j === i ? q : x)));
  const cycle = <T,>(list: readonly T[], now: T): T => list[(list.indexOf(now) + 1) % list.length]!;
  return (
    <View className="gap-4">
      {questions.map((q, i) => {
        const nexts = [...ANSWER_NEXT_KEYS, ...questions.slice(i + 1).map((x) => x.id)];
        const tagChoices: (string | null)[] = [null, ...tags];
        return (
          <Card key={q.id} className="gap-2 px-3 py-3" testID="playbook-question">
            <Text className="text-[13px] font-medium text-text-2">{W.question}</Text>
            <Input value={q.text} onChangeText={(text) => put(i, { ...q, text })} />
            <Text className="text-[13px] font-medium text-text-2">{W.answers}</Text>
            {q.answers.map((a, k) => {
              const putAnswer = (next: Partial<typeof a>) =>
                put(i, {
                  ...q,
                  answers: q.answers.map((x, m) => (m === k ? { ...x, ...next } : x)),
                });
              return (
                <View key={k} className="gap-1.5 border-t border-border pt-2">
                  <Input value={a.label} onChangeText={(label) => putAnswer({ label })} />
                  <View className="flex-row flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => putAnswer({ next: cycle(nexts, a.next) })}
                    >
                      {`${W.leadsTo}: ${answerNextLabel(a.next, questions)}`}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => putAnswer({ tag: cycle(tagChoices, a.tag) })}
                    >
                      {`${W.addsTag}: ${a.tag ?? W.noTag}`}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghostDanger"
                      icon={Trash}
                      onPress={() => put(i, { ...q, answers: q.answers.filter((_, m) => m !== k) })}
                    >
                      {W.remove}
                    </Button>
                  </View>
                </View>
              );
            })}
            <View className="flex-row flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                icon={Plus}
                onPress={() =>
                  put(i, {
                    ...q,
                    answers: [...q.answers, { label: '', tag: null, next: 'continue' }],
                  })
                }
              >
                {W.addAnswer}
              </Button>
              <Button
                size="sm"
                variant="ghostDanger"
                icon={Trash}
                onPress={() => onChange(questions.filter((_, j) => j !== i))}
              >
                {W.remove}
              </Button>
            </View>
          </Card>
        );
      })}
      <Button
        variant="secondary"
        icon={Plus}
        onPress={() =>
          onChange([...questions, { id: nextQuestionId(questions), text: '', answers: [] }])
        }
        testID="playbook-add-question"
      >
        {W.addQuestion}
      </Button>
      {questions.length ? null : (
        <Badge variant="gray">
          <Text>{W.empty}</Text>
        </Badge>
      )}
    </View>
  );
}
