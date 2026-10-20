import { TASK_WORDS, tasksSummary, type TaskOut } from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { SectionList, View } from 'react-native';

import { addTask, completeTask, reopenTask } from '@/tasks/actions';
import { useTasks, type TaskScope } from '@/tasks/use-tasks';
import { TaskSheet } from '@/components/customers/sheets';
import { TaskRow } from '@/components/tasks/task-row';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useMembers } from '@/customers/names';
import { cn } from '@/lib/utils';
import { stateOf } from '@/customers/outbox';

/**
 * Tasks, reached from More: the web's own groups — overdue, today, this week, later, no due date — then what was
 * finished lately. A search result opens a task here (`?task=`). The circle completes a task with no signal and the
 * change waits in the queue; the red, blue and quiet due words are core's, worked out where the business is.
 */
export default function Tasks() {
  const { business, me } = useBusiness();
  const params = useLocalSearchParams<{ task?: string }>();
  // A task a search found (`?task=`) may be anyone's.
  const [scope, setScope] = React.useState<TaskScope>(params.task ? 'all' : 'mine');
  const [adding, setAdding] = React.useState(false);
  const list = useTasks(scope);
  const members = useMembers();

  const sections = React.useMemo(
    () => [
      ...list.groups.map((g) => ({
        key: g.key,
        title: `${g.label} · ${g.items.length}`,
        tone: g.tone,
        data: [...g.items],
      })),
      ...(list.done.length > 0
        ? [
            {
              key: 'done',
              title: `${TASK_WORDS.doneLately} · ${list.done.length}`,
              tone: 'muted' as const,
              data: [...list.done],
            },
          ]
        : []),
    ],
    [list.groups, list.done],
  );

  const toggle = React.useCallback(
    async (task: TaskOut) => {
      if (task.doneAt) await reopenTask(business.id, task.id);
      else {
        await completeTask(business.id, task.id, me.user.id);
        toast.show(TASK_WORDS.completed);
      }
    },
    [business.id, me.user.id],
  );

  const openRecord = React.useCallback(
    (task: TaskOut) => {
      const href = task.lead
        ? `leads/${task.lead.id}`
        : task.person
          ? `customers/people/${task.person.id}`
          : task.company
            ? `customers/companies/${task.company.id}`
            : null;
      if (href) router.push(businessHref(business.id, href) as Href);
    },
    [business.id],
  );

  // A task a search found (`?task=`) opens as tapping it would, once it's in the copy: its customer, company or lead,
  // or the list it's in when it's on none of them.
  const openedTask = React.useRef<string | null>(null);
  React.useEffect(() => {
    const id = params.task;
    if (!id || openedTask.current === id) return;
    const found = [...list.groups.flatMap((g) => g.items), ...list.done].find((t) => t.id === id);
    if (!found) return;
    openedTask.current = id;
    openRecord(found);
  }, [params.task, list.groups, list.done, openRecord]);

  return (
    <Screen title={TASK_WORDS.title} leading="back" testID="tasks" scroll={false}>
      <View className="gap-3 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <Text className="text-[13px] text-text-2" testID="tasks-summary">
          {tasksSummary(scope === 'mine' ? list.counts.mine : list.counts.all, list.timeZone)}
        </Text>
        <Segmented
          value={scope}
          onChange={setScope}
          label="Whose tasks"
          options={[
            {
              value: 'mine',
              label: `${TASK_WORDS.mine} · ${list.counts.mine}`,
              testID: 'tasks-mine',
            },
            {
              value: 'all',
              label: `${TASK_WORDS.everyone} · ${list.counts.all}`,
              testID: 'tasks-everyone',
            },
          ]}
        />
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(task) => task.id}
        renderItem={({ item }) => (
          <TaskRow
            task={item}
            showRelated
            waiting={stateOf(list.changes, item.id).waiting > 0}
            onToggle={(t) => void toggle(t)}
            onPress={openRecord}
          />
        )}
        renderSectionHeader={({ section }) => (
          <Text
            className={cn(
              'bg-bg pb-1 pt-4 text-xs font-semibold uppercase tracking-wide',
              section.tone === 'danger'
                ? 'text-danger-text'
                : section.tone === 'accent'
                  ? 'text-accent-text'
                  : 'text-text-3',
            )}
            testID={`tasks-group-${section.key}`}
          >
            {section.title}
          </Text>
        )}
        contentContainerClassName="px-3.5 pb-8"
        initialNumToRender={14}
        windowSize={7}
        stickySectionHeadersEnabled={false}
        testID="tasks-list"
        ListEmptyComponent={
          list.loading ? null : (
            <View className="items-center gap-1 py-10" testID="tasks-empty">
              <Text className="text-[15px] font-semibold">
                {scope === 'mine' ? TASK_WORDS.nothingOnYourList : TASK_WORDS.noOpenTasks}
              </Text>
              <Text className="px-6 text-center text-[13px] text-text-2">
                {TASK_WORDS.emptyPageBody}
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          <View className="pt-4">
            <Button
              variant="secondary"
              size="md"
              onPress={() => setAdding(true)}
              className="min-h-11 self-start"
              testID="tasks-new"
            >
              {TASK_WORDS.newTask}
            </Button>
          </View>
        }
      />

      <TaskSheet
        open={adding}
        members={members}
        myUserId={me.user.id}
        onClose={() => setAdding(false)}
        onSave={async (task) => {
          await addTask(business.id, task, me.user.id);
          toast.show('Task added.');
        }}
      />
    </Screen>
  );
}
