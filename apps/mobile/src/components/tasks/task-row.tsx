import { dueLabel, taskRelatedLine, TASK_WORDS, type TaskOut } from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Check } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * One task. The circle completes it, as the canvas draws it: a 44 px target, filled the instant it is pressed, with
 * the change waiting in the queue if there's no signal. The due words and their colour are core's, so the phone and
 * the web agree about what "overdue" means where the business is.
 */
export function TaskRow({
  task,
  showRelated,
  waiting,
  onToggle,
  onPress,
}: {
  task: TaskOut;
  showRelated?: boolean;
  /** This phone made a change to it that hasn't gone yet. */
  waiting?: boolean;
  onToggle: (task: TaskOut) => void;
  onPress?: (task: TaskOut) => void;
}) {
  const due = dueLabel(task);
  const related = showRelated ? taskRelatedLine(task) : '';
  const sub = [task.assignee?.fullName ?? TASK_WORDS.unassigned, related]
    .filter(Boolean)
    .join(' · ');
  return (
    <View
      className="flex-row items-start gap-3 border-b border-border py-2.5"
      testID={`task-row-${task.id}`}
    >
      <Pressable
        role="checkbox"
        accessibilityState={{ checked: !!task.doneAt }}
        accessibilityLabel={task.doneAt ? TASK_WORDS.reopen : TASK_WORDS.complete}
        onPress={() => onToggle(task)}
        hitSlop={10}
        className="min-h-11 w-11 items-center justify-center"
        testID="task-toggle"
      >
        <View
          className={cn(
            'size-[22px] items-center justify-center rounded-full border-[1.5px]',
            task.doneAt ? 'border-success bg-success' : 'border-border-strong',
          )}
        >
          {task.doneAt ? <Icon as={Check} className="size-3.5 text-white" /> : null}
        </View>
      </Pressable>
      <Pressable
        role={onPress ? 'button' : undefined}
        onPress={onPress ? () => onPress(task) : undefined}
        disabled={!onPress}
        className="min-w-0 flex-1 gap-0.5 py-0.5"
      >
        <Text
          className={cn('text-[14.5px] font-medium', task.doneAt && 'text-text-2 line-through')}
          testID="task-title"
        >
          {task.title}
        </Text>
        <Text className="text-[12px] text-text-3" numberOfLines={1}>
          {sub}
        </Text>
        {waiting ? (
          <Text className="text-[11.5px] text-text-3" testID="task-waiting">
            Waiting to send
          </Text>
        ) : null}
      </Pressable>
      <Text
        className={cn(
          'flex-none pt-1 text-[12.5px]',
          due.tone === 'danger'
            ? 'font-medium text-danger-text'
            : due.tone === 'accent'
              ? 'font-medium text-accent-text'
              : 'text-text-3',
        )}
        testID="task-due"
      >
        {due.text}
      </Text>
    </View>
  );
}
