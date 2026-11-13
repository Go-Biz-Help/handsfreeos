import type { PlaybookGoal } from '@hfos/core/addons/outreach/playbooks';
import {
  LOCKED_RULES,
  partChanged,
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
  type PlaybookScript,
  type ScriptDraft,
} from '@hfos/core/addons/outreach/script';
import * as React from 'react';
import { View } from 'react-native';

import { Lock, Plus, RotateCcw, Trash } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

import { Note } from './kit';

/**
 * What a playbook says (docs/outreach.md, decision 164), on the phone as the web's builder has it: its own words for
 * every message the AI writes, grouped by when they go. The first message has up to three versions that take turns;
 * a part nobody changed shows the starting words and follows them. Under them, the words in brackets the AI fills in
 * for each person, and the rules no playbook changes, shown locked. The parts, their words and what a save sends are
 * core's (packages/core/src/addons/outreach/script.ts).
 */

/** What it says, read: every part with its words, the first message's versions numbered when there are more. */
export function scriptWords(details: {
  readonly goal: PlaybookGoal;
  readonly script?: PlaybookScript | undefined;
}): string {
  const says = scriptOf(details);
  return SCRIPT_GROUPS.flatMap((group) =>
    group.parts.map((part) => {
      const words =
        part === 'first'
          ? says.first.length > 1
            ? says.first.map((m, i) => `${i + 1}. ${m}`).join('\n')
            : says.first[0]
          : says[part];
      return `${SCRIPT_INFO[part].label}\n${words}`;
    }),
  ).join('\n\n');
}

export function ScriptEditor({
  goal,
  script,
  onChange,
  firstsHelp,
}: {
  goal: PlaybookGoal;
  /** The playbook's own words as typed. */
  script: ScriptDraft;
  onChange: (script: ScriptDraft) => void;
  /** AI help on the first message (./ai-help.tsx). */
  firstsHelp?: React.ReactNode;
}) {
  const firsts = typedFirsts(goal, script);
  return (
    <View className="gap-4" testID="playbook-script">
      <Note>{SW.blurb}</Note>
      {SCRIPT_GROUPS.map((group) => (
        <View key={group.key} className="gap-2">
          <Text className="px-1 text-[13px] font-semibold text-text-2">{group.title}</Text>
          {group.parts.map((part) => {
            const info = SCRIPT_INFO[part];
            const changed = partChanged(goal, script, part);
            return (
              <Card key={part} className="gap-2 px-3 py-3" testID={`playbook-script-${part}`}>
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="text-[14.5px] font-semibold">{info.label}</Text>
                  {changed ? (
                    <Badge variant="accent" testID={`playbook-script-changed-${part}`}>
                      <Text>{SW.changed}</Text>
                    </Badge>
                  ) : null}
                </View>
                <Note>{`${SW.when}: ${info.when}`}</Note>
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
                        part === 'first' ? withFirsts(script, null) : withPart(script, part, null),
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
      ))}
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
