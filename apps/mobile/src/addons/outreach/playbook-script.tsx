import type { PlaybookGoal } from '@hfos/core/addons/outreach/playbooks';
import {
  CHAT_DEMO,
  CHAT_QUESTIONS,
  CHAT_STORY,
  CHAT_WRAP_AFTER,
  chatOf,
  LOCKED_RULES,
  NETWORKING_KEYS,
  NETWORKING_ON,
  networkingOf,
  opensWithIntro,
  partChanged,
  partShown,
  PLAYBOOK_CHAT,
  PLAYBOOK_NETWORKING,
  PLAYBOOK_OPENS,
  PLAYBOOK_OPENS_KEYS,
  PLAYBOOK_REFER,
  refersOf,
  SCRIPT_BLANKS,
  SCRIPT_GROUPS,
  SCRIPT_INFO,
  SCRIPT_LIMITS,
  SCRIPT_WORDS as SW,
  scriptOf,
  typedFirsts,
  typedPart,
  withFirsts,
  withPart,
  type PlaybookChat,
  type PlaybookNetworking,
  type PlaybookOpens,
  type PlaybookScript,
  type ScriptDraft,
} from '@hfos/core/addons/outreach/script';
import * as React from 'react';
import { View } from 'react-native';

import { Check, Lock, Plus, RotateCcw, Trash } from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';

import { Note } from './kit';

/**
 * What a playbook says (docs/outreach.md, decision 164), on the phone as the web's builder has it: its own words for
 * every message the AI writes, grouped by when they go. The first message has up to three versions that take turns;
 * a part nobody changed shows the starting words and follows them. Under them, the words in brackets the AI fills in
 * for each person, and the rules no playbook changes, shown locked. The parts, their words and what a save sends are
 * core's (packages/core/src/addons/outreach/script.ts).
 */

/**
 * What it says, read: how the first message goes, then every part with its words, the first message's versions numbered
 * when there are more. The introduction and its chat show only for a playbook that starts with one (decisions 168 and
 * 173), with what the chat may offer and how it goes (decision 180); whether its people are referred on posts
 * (decision 174) before the referral's parts.
 */
export function scriptWords(details: {
  readonly goal: PlaybookGoal;
  readonly script?: PlaybookScript | undefined;
  readonly opens?: PlaybookOpens | undefined;
  readonly networking?: Partial<PlaybookNetworking> | undefined;
  readonly chat?: Partial<PlaybookChat> | undefined;
  readonly refer?: boolean | undefined;
}): string {
  const says = scriptOf(details);
  const intro = opensWithIntro(details);
  const on = networkingOf(details);
  const offers = NETWORKING_KEYS.filter((k) => on[k]).map((k) => PLAYBOOK_NETWORKING[k].label);
  const chat = chatOf(details);
  const C = PLAYBOOK_CHAT;
  const goes = [
    `${C.wrapAfter.label}: ${C.wrapAfter.option(chat.wrapAfter)}`,
    `${C.questions.label}: ${C.questions.options[chat.questions].label}`,
    `${C.story.label}: ${C.story.options[chat.story].label}`,
    ...(on.demo ? [`${C.demoWhen.label}: ${C.demoWhen.options[chat.demoWhen].label}`] : []),
  ];
  return [
    `${SW.opensTitle}\n${PLAYBOOK_OPENS[intro ? 'intro' : 'pitch'].label}`,
    ...(intro
      ? [
          `${SW.networkingTitle}\n${offers.length ? offers.join('\n') : 'Nothing'}`,
          `${C.title}\n${goes.join('\n')}`,
        ]
      : []),
    ...SCRIPT_GROUPS.flatMap((group) =>
      group.parts.flatMap((part) => {
        if (!partShown(part, intro)) return [];
        if (part === 'referComment' && !refersOf(details)) return [`${PLAYBOOK_REFER.label}\nOff`];
        if (part === 'referNote' && !refersOf(details)) return [];
        const words =
          part === 'first'
            ? says.first.length > 1
              ? says.first.map((m, i) => `${i + 1}. ${m}`).join('\n')
              : says.first[0]
            : says[part];
        return [
          `${part === 'first' && intro ? SW.pitchInIntro : SCRIPT_INFO[part].label}\n${words}`,
        ];
      }),
    ),
  ].join('\n\n');
}

/**
 * How the networking chat goes (decision 180), as the web's builder has it: the most times they write back before it
 * wraps up, how often it asks and shares the owner's story, and when it offers the demo, each a row of choices.
 */
function ChatChoices({
  chat,
  onChat,
  demo,
}: {
  chat: PlaybookChat;
  onChat: (chat: PlaybookChat) => void;
  /** Whether Offer a demo is on: when to offer it shows only then. */
  demo: boolean;
}) {
  const C = PLAYBOOK_CHAT;
  const wraps = Array.from(
    { length: CHAT_WRAP_AFTER.max - CHAT_WRAP_AFTER.min + 1 },
    (_, i) => CHAT_WRAP_AFTER.min + i,
  );
  const row = (key: string, label: string, hint: string, control: React.ReactNode) => (
    <View key={key} className="gap-1.5 px-1">
      <Text className="text-[14.5px] font-medium">{label}</Text>
      {control}
      <Note>{hint}</Note>
    </View>
  );
  return (
    <View className="mt-3 gap-3" testID="playbook-chat">
      <View className="gap-0.5">
        <Text className="px-1 text-[14.5px] font-semibold">{C.title}</Text>
        <Note>{C.blurb}</Note>
      </View>
      {row(
        'wrapAfter',
        C.wrapAfter.label,
        C.wrapAfter.hint,
        <Segmented
          label={C.wrapAfter.label}
          value={String(chat.wrapAfter)}
          onChange={(v) => onChat({ ...chat, wrapAfter: Number(v) })}
          options={wraps.map((n) => ({
            value: String(n),
            label: C.wrapAfter.option(n),
            testID: `playbook-chat-wrap-${n}`,
          }))}
        />,
      )}
      {row(
        'questions',
        C.questions.label,
        `${C.questions.options[chat.questions].hint}. ${C.questions.hint}`,
        <Segmented
          label={C.questions.label}
          value={chat.questions}
          onChange={(questions) => onChat({ ...chat, questions })}
          options={CHAT_QUESTIONS.map((k) => ({
            value: k,
            label: C.questions.options[k].label,
            testID: `playbook-chat-questions-${k}`,
          }))}
        />,
      )}
      {row(
        'story',
        C.story.label,
        `${C.story.options[chat.story].hint}. ${C.story.hint}`,
        <Segmented
          label={C.story.label}
          value={chat.story}
          onChange={(story) => onChat({ ...chat, story })}
          options={CHAT_STORY.map((k) => ({
            value: k,
            label: C.story.options[k].label,
            testID: `playbook-chat-story-${k}`,
          }))}
        />,
      )}
      {demo
        ? row(
            'demoWhen',
            C.demoWhen.label,
            `${C.demoWhen.options[chat.demoWhen].hint}. ${C.demoWhen.hint}`,
            <Segmented
              label={C.demoWhen.label}
              value={chat.demoWhen}
              onChange={(demoWhen) => onChat({ ...chat, demoWhen })}
              options={CHAT_DEMO.map((k) => ({
                value: k,
                label: C.demoWhen.options[k].label,
                testID: `playbook-chat-demo-${k}`,
              }))}
            />,
          )
        : null}
    </View>
  );
}

export function ScriptEditor({
  goal,
  script,
  onChange,
  opens,
  onOpens,
  networking,
  onNetworking,
  chat,
  onChat,
  refer,
  onRefer,
  firstsHelp,
}: {
  goal: PlaybookGoal;
  /** The playbook's own words as typed. */
  script: ScriptDraft;
  onChange: (script: ScriptDraft) => void;
  /** How the first message goes (decision 168). */
  opens: PlaybookOpens;
  onOpens: (opens: PlaybookOpens) => void;
  /** What the networking chat after an introduction may offer (decision 173); left out, everything. */
  networking?: Partial<PlaybookNetworking> | undefined;
  onNetworking: (networking: PlaybookNetworking) => void;
  /** How that chat goes (decision 180); left out, as it starts. */
  chat?: Partial<PlaybookChat> | undefined;
  onChat: (chat: PlaybookChat) => void;
  /** Whether its people are referred on posts asking for a recommendation (decision 174); left out, they are. */
  refer?: boolean | undefined;
  onRefer: (refer: boolean) => void;
  /** AI help on the first message (./ai-help.tsx). */
  firstsHelp?: React.ReactNode;
}) {
  const firsts = typedFirsts(goal, script);
  const intro = opens === 'intro';
  const offers: PlaybookNetworking = { ...NETWORKING_ON, ...(networking ?? {}) };
  return (
    <View className="gap-4" testID="playbook-script">
      <Note>{SW.blurb}</Note>
      {SCRIPT_GROUPS.filter((group) => group.parts.some((part) => partShown(part, intro))).map(
        (group) => (
          <View key={group.key} className="gap-2">
            <Text className="px-1 text-[13px] font-semibold text-text-2">{group.title}</Text>
            {group.key === 'networking' ? (
              // What the networking chat may offer, each once, when it fits (decision 173).
              <View className="gap-1.5" testID="playbook-networking">
                <Text className="px-1 text-[14.5px] font-semibold">{SW.networkingTitle}</Text>
                <Note>{SW.networkingBlurb}</Note>
                {NETWORKING_KEYS.map((k) => (
                  <View key={k} className="flex-row items-center gap-3 px-1">
                    <View className="flex-1">
                      <Text className="text-[14.5px] font-medium">
                        {PLAYBOOK_NETWORKING[k].label}
                      </Text>
                      <Note>{PLAYBOOK_NETWORKING[k].hint}</Note>
                    </View>
                    <Switch
                      label={PLAYBOOK_NETWORKING[k].label}
                      checked={offers[k]}
                      onCheckedChange={(v) => onNetworking({ ...offers, [k]: v })}
                      testID={`playbook-networking-${k}`}
                    />
                  </View>
                ))}
                <ChatChoices chat={chatOf({ chat })} onChat={onChat} demo={offers.demo} />
              </View>
            ) : null}
            {group.key === 'refer' ? (
              // Refer them on posts asking for a recommendation (decision 174): both wait for an OK on Today.
              <View className="flex-row items-center gap-3 px-1">
                <View className="flex-1">
                  <Text className="text-[14.5px] font-medium">{PLAYBOOK_REFER.label}</Text>
                  <Note>{PLAYBOOK_REFER.hint}</Note>
                </View>
                <Switch
                  label={PLAYBOOK_REFER.label}
                  checked={refer !== false}
                  onCheckedChange={onRefer}
                  testID="playbook-refer"
                />
              </View>
            ) : null}
            {group.key === 'start' ? (
              <View className="gap-1.5" testID="playbook-opens">
                <Text className="px-1 text-[14.5px] font-semibold">{SW.opensTitle}</Text>
                <Note>{SW.opensBlurb}</Note>
                <List>
                  {PLAYBOOK_OPENS_KEYS.map((k) => (
                    <ListRow
                      key={k}
                      label={PLAYBOOK_OPENS[k].label}
                      detail={PLAYBOOK_OPENS[k].hint}
                      end={
                        opens === k ? <Icon as={Check} className="size-5 text-accent" /> : undefined
                      }
                      chevron={false}
                      onPress={() => onOpens(k)}
                      testID={`playbook-opens-${k}`}
                    />
                  ))}
                </List>
              </View>
            ) : null}
            {group.parts.map((part) => {
              // The introduction and its chat's words show only for a playbook that starts with one (decisions 168 and
              // 173).
              if (!partShown(part, intro)) return null;
              const info = SCRIPT_INFO[part];
              const changed = partChanged(goal, script, part);
              const label = part === 'first' && intro ? SW.pitchInIntro : info.label;
              return (
                <Card key={part} className="gap-2 px-3 py-3" testID={`playbook-script-${part}`}>
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Text className="text-[14.5px] font-semibold">{label}</Text>
                    {changed ? (
                      <Badge variant="accent" testID={`playbook-script-changed-${part}`}>
                        <Text>{SW.changed}</Text>
                      </Badge>
                    ) : null}
                  </View>
                  <Note>{`${SW.when}: ${part === 'first' && intro ? SW.pitchInIntroWhen : info.when}`}</Note>
                  {part === 'first' ? (
                    <>
                      {firsts.map((m, i) => (
                        <View key={i} className="gap-1">
                          <Input
                            value={m}
                            multiline
                            maxLength={SCRIPT_LIMITS.first.line}
                            accessibilityLabel={
                              firsts.length > 1 ? `${info.label} ${i + 1}` : info.label
                            }
                            onChangeText={(t) =>
                              onChange(
                                withFirsts(
                                  script,
                                  firsts.map((x, j) => (j === i ? t : x)),
                                ),
                              )
                            }
                            className="h-28 py-3"
                            testID={`playbook-script-first-${i}`}
                          />
                          {firsts.length > 1 ? (
                            <Button
                              size="sm"
                              variant="ghostDanger"
                              icon={Trash}
                              className="self-start"
                              onPress={() =>
                                onChange(
                                  withFirsts(
                                    script,
                                    firsts.filter((_, j) => j !== i),
                                  ),
                                )
                              }
                              testID={`playbook-script-first-remove-${i}`}
                            >
                              {SW.removeFirst(i + 1)}
                            </Button>
                          ) : null}
                        </View>
                      ))}
                      <Note>{`${SW.messageHint} ${SW.firstHint(SCRIPT_LIMITS.first.most)}`}</Note>
                      {firsts.length < SCRIPT_LIMITS.first.most ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={Plus}
                          className="self-start"
                          onPress={() => onChange(withFirsts(script, [...firsts, '']))}
                          testID="playbook-script-first-add"
                        >
                          {SW.addFirst}
                        </Button>
                      ) : null}
                      {firstsHelp}
                    </>
                  ) : (
                    <>
                      <Input
                        value={typedPart(goal, script, part)}
                        multiline
                        maxLength={SCRIPT_LIMITS.text}
                        accessibilityLabel={info.label}
                        onChangeText={(t) => onChange(withPart(script, part, t))}
                        className="h-28 py-3"
                        testID={`playbook-script-words-${part}`}
                      />
                      {info.says === 'message' ? <Note>{SW.messageHint}</Note> : null}
                    </>
                  )}
                  {changed ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={RotateCcw}
                      className="self-start"
                      onPress={() =>
                        onChange(
                          part === 'first'
                            ? withFirsts(script, null)
                            : withPart(script, part, null),
                        )
                      }
                      testID={`playbook-script-starting-${part}`}
                    >
                      {SW.starting}
                    </Button>
                  ) : null}
                </Card>
              );
            })}
          </View>
        ),
      )}
      <View className="gap-1.5" testID="playbook-script-blanks">
        <Text className="px-1 text-[13px] font-semibold text-text-2">{SW.blanksTitle}</Text>
        <Card className="gap-1.5 px-3 py-3">
          {SCRIPT_BLANKS.map((b) => (
            <Text key={b.blank} className="text-[13px] leading-[18px] text-text-2">
              <Text className="text-[13px] font-medium text-text">{b.blank}</Text>
              {`  ${b.fills}`}
            </Text>
          ))}
        </Card>
      </View>
      <View className="gap-1.5" testID="playbook-locked-rules">
        <Text className="px-1 text-[13px] font-semibold text-text-2">{SW.lockedTitle}</Text>
        <Note>{SW.lockedBlurb}</Note>
        <Card className="gap-2 bg-card-2 px-3 py-3">
          {LOCKED_RULES.map((rule) => (
            <View key={rule} className="flex-row gap-2">
              <Icon as={Lock} className="mt-0.5 size-4 text-text-3" />
              <Text className="flex-1 text-[13px] leading-[18px] text-text-2">{rule}</Text>
            </View>
          ))}
        </Card>
      </View>
    </View>
  );
}
