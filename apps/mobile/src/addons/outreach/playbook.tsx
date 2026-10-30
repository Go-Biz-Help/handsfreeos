import { NETWORK_WORDS as NW } from '@hfos/core/addons/outreach/network-words';
import { PLATFORM_KEYS, PLATFORMS, WORKING_PLATFORMS } from '@hfos/core/addons/outreach/networks';
import type {
  AssistQuestion,
  PlaybookAssistOutput,
} from '@hfos/core/addons/outreach/playbook-assist';
import {
  scriptMinutes,
  VIDEO_LIMITS,
  VIDEO_PARTS,
  VIDEO_SHOWS,
  VIDEO_TIPS,
  VIDEO_WORDS as V,
  type VideoDraft,
  type VideoPart,
  type VideoScript,
  type VideoScriptInput,
} from '@hfos/core/addons/outreach/video';
import {
  findWordsHint,
  OUTREACH_WORDS as W,
  playbookSectionTitle,
} from '@hfos/core/addons/outreach/words';
import {
  ANSWER_NEXT_KEYS,
  answerNextLabel,
  hasWordsOn,
  nextQuestionId,
  followUpGapsFor,
  PACE_LIMITS,
  paceOf,
  PLAYBOOK_GOAL_KEYS,
  PLAYBOOK_LIMITS,
  PLAYBOOK_GOALS,
  PLAYBOOK_STEP_KEYS,
  PLAYBOOK_STEPS,
  PlaybookSaveInput,
  type Playbook,
  type PlaybookDetails,
  type PlaybookQuestion,
  type WordsPlatform,
} from '@hfos/core/addons/outreach/playbooks';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Archive, Check, Plus, RotateCcw, Sparkles, Trash } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
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
import { workerPost } from '@/lib/worker';

import { AiHelp, assistDraftOf, type AskAssist } from './ai-help';
import {
  NeedsSignal,
  Note,
  openOutreach,
  Part,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';
import { PHONE_WORDS } from './phone-words';

/**
 * One playbook on the phone (decision 44): each part of it, and for owners and admins, changing it a part at a time
 * in a sheet. Before each save the phone asks for the playbook again and puts only the part changed on what it finds,
 * so a change made meanwhile on the web isn't undone. The AI helps in the sheet as on the web (./ai-help.tsx: Improve,
 * Suggest more, Write it for me), and writes the short video's script there, part by part (`outreach.video.script`);
 * what it writes is only offered, and saved with the part. It needs signal. Its networks are one part: one playbook
 * for every network (Chris), at least one picked. Each network's own words, and whether its clients are online, show
 * on a customers' playbook while that network is ticked (decision 92).
 */

export type Section = keyof typeof W.playbookSections | 'name';

const A = PHONE_WORDS.aiHelp;

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
  // The short video (decision 69): its link, and its script, written by the AI and changed as the business likes.
  video: ['videoLink', 'videoScript'],
  tone: ['tone'],
  samples: ['samples'],
  openers: ['openerStyles', 'ownOpeners'],
  questions: ['questions'],
  avoid: ['avoid'],
  disclaimer: ['disclaimer'],
  tags: ['tags'],
  hashtags: ['hashtags'],
  postSearches: ['postSearches'],
  businessKinds: ['businessKinds'],
  worksOnline: ['worksOnline'],
};
const SECTIONS = Object.keys(SECTION_FIELDS) as Exclude<Section, 'name'>[];

/** The parts only a customers' playbook has, each shown while its network is ticked (decision 92). */
const NETWORK_SECTIONS: Partial<Record<Exclude<Section, 'name'>, WordsPlatform>> = {
  hashtags: 'instagram',
  postSearches: 'linkedin',
  businessKinds: 'alignable',
  worksOnline: 'alignable',
};

/** The parts a playbook shows: each network's own words only where `hasWordsOn` says. */
export function sectionsOf(details: PlaybookDetails): Exclude<Section, 'name'>[] {
  return SECTIONS.filter((section) => {
    const on = NETWORK_SECTIONS[section];
    return !on || hasWordsOn(details, on);
  });
}

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
          : V.none,
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
    case 'hashtags':
    case 'postSearches':
    case 'businessKinds': {
      const lines = details[section] ?? [];
      const platform = NETWORK_SECTIONS[section]!;
      if (lines.length) return list(section === 'hashtags' ? lines.map((t) => `#${t}`) : lines);
      // Emptied once the AI wrote it: that network looks at nothing for this playbook.
      return details.wordsWritten?.includes(platform) ? W.findWords.none[platform] : W.empty;
    }
    case 'worksOnline':
      return details.worksOnline ? W.worksOnline.yes : W.worksOnline.no;
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
  // The live main offer's version, as the web's builder has it: a script written for another one says so.
  const offer = useOutreachAnswer(
    ctx.manages
      ? async () =>
          unwrap(await api.POST('/v1/queries/main_offer.get', { body: { workspaceId: ws } })).live
            ?.version ?? null
      : null,
    `playbook-offer:${ws}`,
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
      onAssist={(part, mode, draft) =>
        workerPost<PlaybookAssistOutput>('/v1/addons/outreach/actions/outreach.playbook.assist', {
          workspaceId: ws,
          input: { part, mode, draft },
        })
      }
      onScript={(input) =>
        workerPost<VideoScript>('/v1/addons/outreach/actions/outreach.video.script', {
          workspaceId: ws,
          input,
        })
      }
      liveVersion={offer.data ?? null}
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
  onAssist,
  onScript,
  liveVersion = null,
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
  /** Asks the AI for help on a part (./ai-help.tsx). Without it, the sheet has none and says it's on the web. */
  onAssist?: AskAssist;
  /** Asks the AI to write the short video's script, or one part of it again. */
  onScript?: (input: VideoScriptInput) => Promise<VideoScript>;
  /** The live main offer's version: a script written for another one says so. */
  liveVersion?: number | null;
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
      {manages ? onAssist ? null : <Note>{W.aiOnTheWeb}</Note> : <Note>{W.readOnly}</Note>}
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
      {sectionsOf(playbook.details).map((section) => (
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
        onAssist={onAssist}
        onScript={onScript}
        liveVersion={liveVersion}
      />
    </Screen>
  );
}

/** What the AI does in the sheet: help on a part, and the short video's script. */
interface SheetAi {
  onAssist?: AskAssist;
  onScript?: (input: VideoScriptInput) => Promise<VideoScript>;
  liveVersion: number | null;
}

function SectionSheet({
  playbook,
  section,
  onClose,
  onSave,
  ...ai
}: {
  playbook: Playbook;
  section: Section | null;
  onClose: () => void;
  onSave: (
    loaded: Playbook,
    draft: Pick<Playbook, 'name' | 'details'>,
    section: Section,
  ) => Promise<string | null>;
} & SheetAi) {
  const [draft, setDraft] = React.useState<Pick<Playbook, 'name' | 'details'>>(playbook);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const keyboard = useKeyboardHeight();
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
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="gap-3">
        {section ? (
          <SectionEditor section={section} draft={draft} set={set} setDraft={setDraft} {...ai} />
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
  // Changed from outside, by the AI's lines: the box follows them. What's typed stays as typed.
  const [seen, setSeen] = React.useState(value);
  if (value !== seen) {
    setSeen(value);
    if (linesOf(text).join('\n') !== value.join('\n')) setText(value.join('\n'));
  }
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

/** The words parts the AI writes, or writes better. */
type WordsKey = 'offer' | 'audience' | 'area' | 'tone' | 'disclaimer';
/** The lists the AI adds lines to, or rewrites. */
type ListKey =
  | 'signs'
  | 'skip'
  | 'groupWords'
  | 'tags'
  | 'samples'
  | 'avoid'
  | 'hashtags'
  | 'postSearches'
  | 'businessKinds'
  | 'openerStyles'
  | 'ownOpeners';

function SectionEditor({
  section,
  draft,
  set,
  setDraft,
  onAssist,
  onScript,
  liveVersion,
}: {
  section: Section;
  draft: Pick<Playbook, 'name' | 'details'>;
  set: (part: Partial<PlaybookDetails>) => void;
  setDraft: React.Dispatch<React.SetStateAction<Pick<Playbook, 'name' | 'details'>>>;
} & SheetAi) {
  const d = draft.details;
  // The playbook as it stands in the sheet, so the AI's help fits the rest of it.
  const assistDraft = assistDraftOf(draft);
  /** AI help on words: what's picked goes in place of what's there. */
  const help = (part: WordsKey) =>
    onAssist ? (
      <AiHelp
        part={part}
        draft={assistDraft}
        written={Boolean(d[part]?.trim())}
        onAsk={onAssist}
        onWords={(words) => set({ [part]: words })}
      />
    ) : null;
  /** Adds a line the AI suggested to a list, unless it's there already or the list is full. */
  const addLine = (k: ListKey, line: string): boolean => {
    const lines = (d[k] ?? []).filter((x) => x.trim());
    if (lines.some((x) => x.toLowerCase() === line.toLowerCase())) return true;
    const { most } = PLAYBOOK_LIMITS[k];
    if (lines.length >= most) {
      toast.error(A.full(most));
      return false;
    }
    set({ [k]: [...lines, line] });
    return true;
  };
  /** AI help on a list: lines to add one by one, or the list rewritten to use instead. */
  const listHelp = (k: ListKey) =>
    onAssist ? (
      <AiHelp
        part={k}
        draft={assistDraft}
        written={assistDraft[k].length > 0}
        onAsk={onAssist}
        onAdd={(line) => addLine(k, line)}
        onReplace={(lines) => set({ [k]: lines })}
      />
    ) : null;
  /** Adds a question the AI suggested, while there's room for one. */
  const addQuestion = (q: AssistQuestion) =>
    setDraft((x) =>
      x.details.questions.length >= PLAYBOOK_LIMITS.questions.most
        ? x
        : {
            ...x,
            details: {
              ...x.details,
              questions: [
                ...x.details.questions,
                {
                  id: nextQuestionId(x.details.questions),
                  text: q.text,
                  answers: q.answers.map((a) => ({ ...a })),
                },
              ],
            },
          },
    );
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
          {help('offer')}
        </>
      );
    case 'video':
      return <VideoEditor draft={draft} set={set} onScript={onScript} liveVersion={liveVersion} />;
    case 'audience':
    case 'area':
    case 'tone':
    case 'disclaimer':
      return (
        <>
          <WordsInput
            value={d[section]}
            onChange={(v) => set({ [section]: v })}
            testID="playbook-words"
          />
          {help(section)}
        </>
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
          {listHelp('openerStyles')}
          <Text className="text-[14px] font-medium">{W.ownOpeners}</Text>
          <LinesInput value={d.ownOpeners} onChange={(ownOpeners) => set({ ownOpeners })} />
          {listHelp('ownOpeners')}
        </>
      );
    case 'questions':
      return (
        <>
          <QuestionsEditor
            questions={d.questions}
            tags={d.tags}
            onChange={(questions) => set({ questions })}
          />
          {onAssist ? (
            <AiHelp
              part="questions"
              draft={assistDraft}
              written={d.questions.length > 0}
              onAsk={onAssist}
              onQuestion={addQuestion}
            />
          ) : null}
        </>
      );
    case 'hashtags':
    case 'postSearches':
    case 'businessKinds': {
      const platform = NETWORK_SECTIONS[section]!;
      return (
        <>
          <LinesInput
            value={d[section] ?? []}
            onChange={(lines) => set({ [section]: lines })}
            testID="playbook-lines"
          />
          <Note testID="playbook-words-hint">{findWordsHint(d, platform)}</Note>
          {section === 'hashtags' ? <Note>{W.findWords.hashtagHint}</Note> : null}
          {listHelp(section)}
        </>
      );
    }
    case 'worksOnline':
      return (
        <View className="gap-3">
          <View className="flex-row items-center gap-3">
            <Text className="flex-1 text-[14.5px] font-medium">{W.worksOnline.label}</Text>
            <Switch
              label={W.worksOnline.label}
              checked={d.worksOnline === true}
              onCheckedChange={(worksOnline) => set({ worksOnline })}
              testID="playbook-works-online"
            />
          </View>
          <Note>{d.worksOnline ? W.worksOnline.yes : W.worksOnline.no}</Note>
        </View>
      );
    default:
      return (
        <>
          <LinesInput
            value={d[section]}
            onChange={(lines) => set({ [section]: lines })}
            testID="playbook-lines"
          />
          {listHelp(section)}
        </>
      );
  }
}

/**
 * The playbook's short video (decision 69), as the web's builder has it: its link, and its script, which the AI writes
 * from the main offer and the niche, part by part, each with what to say and what to show, and writes one part again
 * on Improve. The business changes the words as it likes; all of it is saved with the part.
 */
function VideoEditor({
  draft,
  set,
  onScript,
  liveVersion,
}: {
  draft: Pick<Playbook, 'name' | 'details'>;
  set: (part: Partial<PlaybookDetails>) => void;
} & Omit<SheetAi, 'onAssist'>) {
  const d = draft.details;
  const [busy, setBusy] = React.useState<'write' | VideoPart | null>(null);
  const script = d.videoScript ?? null;
  const older =
    script !== null &&
    script.version !== null &&
    liveVersion !== null &&
    script.version !== liveVersion;
  const ask = async (part: VideoPart | null) => {
    if (!onScript) return;
    const videoDraft: VideoDraft = {
      name: draft.name,
      niche: d.niche ?? '',
      problem: d.problem ?? '',
      proof: d.proof ?? [],
      offer: d.offer ?? '',
      tone: d.tone ?? '',
      avoid: d.avoid,
      disclaimer: d.disclaimer ?? '',
    };
    setBusy(part ?? 'write');
    try {
      set({
        videoScript: await onScript(
          part && script
            ? { draft: videoDraft, mode: 'improve', part, script }
            : { draft: videoDraft, mode: 'write' },
        ),
      });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const put = (part: VideoPart, key: 'say' | 'show', value: string) => {
    if (!script) return;
    set({
      videoScript: {
        ...script,
        parts: script.parts.map((p) => (p.part === part ? { ...p, [key]: value } : p)),
      },
    });
  };
  return (
    <View className="gap-3" testID="playbook-video">
      <Text className="text-[14px] font-medium">{V.link}</Text>
      <WordsInput
        value={d.videoLink ?? null}
        onChange={(link) => set({ videoLink: link?.trim() || null })}
        placeholder={V.linkPlaceholder}
        multiline={false}
        testID="playbook-video-link"
      />
      <Note>{V.linkHint}</Note>
      {script ? (
        <>
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <Text className="shrink text-[13px] text-text-2" testID="playbook-video-runs">
              {[
                V.runs(scriptMinutes(script)),
                script.version ? PHONE_WORDS.writtenFor(script.version) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {onScript ? (
              <Button
                size="sm"
                variant="secondary"
                icon={Sparkles}
                loading={busy === 'write'}
                disabled={busy !== null}
                onPress={() => void ask(null)}
                testID="playbook-video-again"
              >
                {V.again}
              </Button>
            ) : null}
          </View>
          {older ? (
            <Text
              className="rounded-menu bg-warning-soft px-3 py-2.5 text-[13px] leading-[18px] text-warning-text"
              testID="playbook-video-older"
            >
              {V.older(script.version!)}
            </Text>
          ) : null}
          {script.parts.map((p, i) => {
            const { title, shows } = VIDEO_PARTS[p.part];
            return (
              <Card
                key={p.part}
                className="gap-2 px-3 py-3"
                testID={`playbook-video-part-${p.part}`}
              >
                <View className="flex-row flex-wrap items-center justify-between gap-2">
                  <View className="shrink flex-row flex-wrap items-center gap-2">
                    <Text className="text-[14.5px] font-semibold">{`${i + 1} · ${title}`}</Text>
                    <Badge variant="gray">
                      <Text>{VIDEO_SHOWS[shows]}</Text>
                    </Badge>
                  </View>
                  {onScript ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Sparkles}
                      loading={busy === p.part}
                      disabled={busy !== null}
                      onPress={() => void ask(p.part)}
                      accessibilityLabel={`${V.improve}: ${title}`}
                      testID={`playbook-video-improve-${p.part}`}
                    >
                      {V.improve}
                    </Button>
                  ) : null}
                </View>
                <Text className="text-[13px] font-medium text-text-2">{V.say}</Text>
                <Input
                  value={p.say}
                  multiline
                  maxLength={VIDEO_LIMITS.say}
                  accessibilityLabel={`${V.say}: ${title}`}
                  onChangeText={(t) => put(p.part, 'say', t)}
                  className="h-28 py-3"
                  testID={`playbook-video-say-${p.part}`}
                />
                <Text className="text-[13px] font-medium text-text-2">{V.show}</Text>
                <Input
                  value={p.show}
                  maxLength={VIDEO_LIMITS.show}
                  accessibilityLabel={`${V.show}: ${title}`}
                  onChangeText={(t) => put(p.part, 'show', t)}
                  testID={`playbook-video-show-${p.part}`}
                />
              </Card>
            );
          })}
        </>
      ) : (
        <Card className="items-start gap-3 border-dashed bg-card-2 px-4 py-4">
          <Note>{onScript ? V.none : V.onComputer}</Note>
          {onScript ? (
            <Button
              icon={Sparkles}
              loading={busy === 'write'}
              onPress={() => void ask(null)}
              testID="playbook-video-write"
            >
              {V.write}
            </Button>
          ) : null}
        </Card>
      )}
      {busy ? <Note testID="playbook-video-writing">{V.writing}</Note> : null}
      <Text className="text-[14px] font-medium">{V.tips}</Text>
      <View className="gap-1.5">
        {VIDEO_TIPS.map((tip) => (
          <View key={tip} className="flex-row gap-2">
            <Icon as={Check} className="mt-0.5 size-4 text-accent-text" />
            <Text className="flex-1 text-[13px] leading-[18px] text-text-2">{tip}</Text>
          </View>
        ))}
      </View>
    </View>
  );
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
