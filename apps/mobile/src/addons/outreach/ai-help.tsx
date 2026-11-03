import {
  PLAYBOOK_ASSIST_PARTS,
  type AssistDraft,
  type AssistQuestion,
  type PlaybookAssistMode,
  type PlaybookAssistOutput,
  type PlaybookAssistPart,
} from '@hfos/core/addons/outreach/playbook-assist';
import type { Playbook } from '@hfos/core/addons/outreach/playbooks';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Plus, Sparkles, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

import { Note } from './kit';
import { PHONE_WORDS } from './phone-words';

/**
 * AI help on one of a playbook's parts, in its sheet on the phone, as the web's builder has it (ai-help.tsx): Improve
 * rewrites what's written, Suggest more offers more (Write it for me, for words not written yet). What comes back is
 * only offered: words to use in place of what's there, lines to add one by one (or a rewritten list to use instead),
 * or questions to add. The worker asks the AI (`outreach.playbook.assist`) with the whole playbook as it stands in the
 * sheet, so the help fits the rest of it. Nothing is saved until the sheet's Save. It needs signal.
 */

const A = PHONE_WORDS.aiHelp;

/** Asks the AI for help on a part: what it offers, or throws with why not. */
export type AskAssist = (
  part: PlaybookAssistPart,
  mode: PlaybookAssistMode,
  draft: AssistDraft,
) => Promise<PlaybookAssistOutput>;

/** The playbook as the AI reads it: as it stands in the sheet, every part the builder has. */
export function assistDraftOf(playbook: Pick<Playbook, 'name' | 'details'>): AssistDraft {
  const d = playbook.details;
  return {
    name: playbook.name,
    goal: d.goal,
    niche: d.niche ?? '',
    problem: d.problem ?? '',
    offer: d.offer ?? '',
    audience: d.audience ?? '',
    area: d.area ?? '',
    tone: d.tone ?? '',
    disclaimer: d.disclaimer ?? '',
    signs: d.signs,
    skip: d.skip,
    groupWords: d.groupWords,
    facebookSearches: d.facebookSearches ?? [],
    hashtags: d.hashtags ?? [],
    postSearches: d.postSearches ?? [],
    businessKinds: d.businessKinds ?? [],
    worksOnline: d.worksOnline ?? null,
    tags: d.tags,
    samples: d.samples.filter((m) => m.trim()),
    openerStyles: d.openerStyles,
    ownOpeners: d.ownOpeners.filter((m) => m.trim()),
    avoid: d.avoid,
    questions: d.questions.map((q) => ({
      text: q.text,
      answers: q.answers.map((a) => ({ label: a.label })),
    })),
  };
}

export function AiHelp({
  part,
  draft,
  written,
  onAsk,
  onWords,
  onAdd,
  onReplace,
  onQuestion,
}: {
  part: PlaybookAssistPart;
  /** The whole playbook as it stands in the sheet. */
  draft: AssistDraft;
  /** Whether anything's written in the part yet: Improve needs something to improve. */
  written: boolean;
  onAsk: AskAssist;
  /** Words: use these in place of what's there. */
  onWords?: (words: string) => void;
  /** A list: add this line. Whether it went in. */
  onAdd?: (line: string) => boolean;
  /** A list: use these lines instead. */
  onReplace?: (lines: string[]) => void;
  /** The conversation: add this question. */
  onQuestion?: (question: AssistQuestion) => void;
}) {
  const { kind, label } = PLAYBOOK_ASSIST_PARTS[part];
  const [busy, setBusy] = React.useState<PlaybookAssistMode | null>(null);
  const [got, setGot] = React.useState<
    (PlaybookAssistOutput & { mode: PlaybookAssistMode }) | null
  >(null);
  const [used, setUsed] = React.useState<ReadonlySet<string>>(new Set());
  const ask = async (mode: PlaybookAssistMode) => {
    setBusy(mode);
    try {
      const out = await onAsk(part, mode, draft);
      if (!out.options.length && !out.questions.length) toast.show(A.nothingNew);
      setGot({ ...out, mode });
      setUsed(new Set());
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const take = (key: string) => setUsed((u) => new Set(u).add(key));
  const shown = got && (got.options.length || got.questions.length) ? got : null;
  const suggestWords =
    kind === 'questions'
      ? A.suggestQuestions
      : kind === 'words' && !written
        ? A.writeIt
        : A.suggestMore;
  return (
    <View className="gap-2" testID={`ai-help-${part}`}>
      <View className="flex-row flex-wrap items-center gap-1.5">
        <View className="flex-row items-center gap-1">
          <Icon as={Sparkles} className="size-3.5 text-text-3" />
          <Text className="text-[13px] text-text-3">{A.title}</Text>
        </View>
        {written ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'improve'}
            disabled={busy !== null}
            onPress={() => void ask('improve')}
            accessibilityLabel={A.improveLabel(label)}
            testID={`ai-improve-${part}`}
          >
            {A.improve}
          </Button>
        ) : null}
        {kind === 'words' && written ? null : (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'suggest'}
            disabled={busy !== null}
            onPress={() => void ask('suggest')}
            accessibilityLabel={A.suggestLabel(label, kind === 'words')}
            testID={`ai-suggest-${part}`}
          >
            {suggestWords}
          </Button>
        )}
      </View>
      {shown ? (
        <View
          className="gap-2 rounded-card border border-accent-soft bg-card-2 p-3"
          testID={`ai-help-${part}-options`}
        >
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-[13px] font-medium text-text-2">
              {kind === 'words'
                ? A.pickOne
                : kind === 'questions'
                  ? A.addFits
                  : shown.mode === 'improve'
                    ? A.rewritten
                    : A.tapToAdd}
            </Text>
            <Button
              size="sm"
              variant="ghost"
              icon={X}
              accessibilityLabel={A.close}
              onPress={() => setGot(null)}
              testID={`ai-close-${part}`}
            />
          </View>
          {kind === 'words'
            ? shown.options.map((o) => (
                <Pressable
                  key={o}
                  role="button"
                  onPress={() => {
                    onWords?.(o);
                    setGot(null);
                  }}
                  className="rounded-menu border border-border bg-card px-3 py-2.5 active:border-accent"
                  testID="ai-option"
                >
                  <Text className="text-[14px] leading-[20px]">{o}</Text>
                </Pressable>
              ))
            : null}
          {kind === 'list' && shown.mode === 'suggest' ? (
            <View className="flex-row flex-wrap gap-1.5">
              {shown.options
                .filter((o) => !used.has(o))
                .map((o) => (
                  <Pressable
                    key={o}
                    role="button"
                    onPress={() => {
                      if (onAdd?.(o) !== false) take(o);
                    }}
                    className={cn(
                      'min-h-9 flex-row items-center gap-1 border border-dashed border-border-strong bg-card px-3 py-1.5',
                      part === 'samples' || part === 'ownOpeners' || part === 'openerStyles'
                        ? 'rounded-menu'
                        : 'rounded-full',
                    )}
                    testID="ai-option"
                  >
                    <Icon as={Plus} className="size-3.5 text-text-2" />
                    <Text className="shrink text-[13.5px] text-text-2">{o}</Text>
                  </Pressable>
                ))}
            </View>
          ) : null}
          {kind === 'list' && shown.mode === 'improve' ? (
            <View className="gap-2">
              {shown.options.map((o) => (
                <Text key={o} className="text-[14px] leading-[20px]" testID="ai-option">
                  {`• ${o}`}
                </Text>
              ))}
              <Button
                size="sm"
                className="self-start"
                onPress={() => {
                  onReplace?.(shown.options);
                  setGot(null);
                }}
                testID={`ai-replace-${part}`}
              >
                {A.useThese}
              </Button>
            </View>
          ) : null}
          {kind === 'questions'
            ? shown.questions
                .filter((q) => !used.has(q.text))
                .map((q) => (
                  <View
                    key={q.text}
                    className="gap-1.5 rounded-menu border border-border bg-card p-3"
                    testID="ai-question"
                  >
                    <Text className="text-[14px] font-medium">{q.text}</Text>
                    {q.answers.map((a) => (
                      <Note key={a.label}>{A.answer(a.label, a.next, a.tag)}</Note>
                    ))}
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={Plus}
                      className="self-start"
                      onPress={() => {
                        onQuestion?.(q);
                        take(q.text);
                      }}
                      testID="ai-question-add"
                    >
                      {A.add}
                    </Button>
                  </View>
                ))
            : null}
        </View>
      ) : null}
    </View>
  );
}
