import { addDays, fmtMonthDay, localDayOf } from '@hfos/core';
import {
  CLIENT_TASK_PRESETS,
  presetsFor,
  withAgent,
  type ClientTaskPreset,
} from '@hfos/core/addons/realestate/client-words';
import {
  firstNamesOf,
  RE_CLIENT_TODO_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-closing';
import {
  clientTasksOfCopy,
  type ClientTasksView,
} from '@hfos/core/addons/realestate/views/closing';
import * as React from 'react';
import { View } from 'react-native';

import { Plus } from '@/components/icons';
import { List } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { addClientTask, invitePortal, markClientTaskDone } from './closing-actions';
import { SignalButton } from './kit';
import {
  ChangeButton,
  CheckRow,
  Chips,
  DealSubpage,
  FieldError,
  FieldLabel,
  SignalNote,
  SummaryAnswer,
  useDealPage,
  useSummaryAnswer,
} from './subpage';

/**
 * What a deal's clients still have to do (board 85, last panel), as they see it in their portal. A new one reaches
 * their portal, so it goes on its own while fresh and asks again after 30 minutes with no signal. A task the client
 * did another way is marked done for them, with how. `?invite=1` (the deal page's card) asks the first client not in
 * the portal yet in, which emails them and so needs signal.
 */

type Task = ClientTasksView['tasks'][number];
type Client = ClientTasksView['clients'][number];

export function ClientTasksScreen({ dealId, invite }: { dealId: string; invite?: boolean }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const view = React.useMemo(
    () => clientTasksOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () => ({
      ...unwrap(
        await api.POST('/v1/queries/realestate.client_tasks', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ),
      full: true,
    }),
    `client-tasks:${dealId}`,
    'to-do',
  );
  const side = deal?.data.side === 'listing' ? 'listing' : 'buyer';
  const agent = deal?.ownerUserId ? copy.user(deal.ownerUserId) : null;
  const agentFirst = agent?.split(/\s+/)[0] ?? 'your agent';
  const clients = view?.clients ?? [];
  const who = firstNamesOf(clients.map((c) => c.name));
  const [adding, setAdding] = React.useState(false);
  const [marking, setMarking] = React.useState<Task | null>(null);
  const [inviting, setInviting] = React.useState<Client | null>(null);
  // Opened from the deal page's card: the first client not in the portal yet, once.
  const asked = React.useRef(false);
  React.useEffect(() => {
    if (!invite || asked.current || !view) return;
    asked.current = true;
    const first = view.clients.find((c) => c.portal === 'none' || c.portal === 'revoked');
    if (first) setInviting(first);
  }, [invite, view]);
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={W.title}
      testID="re-client-tasks"
    >
      {whole && view ? (
        <ClientTasksBody
          view={view}
          today={ctx.today}
          timeZone={ctx.timeZone}
          onTask={setMarking}
          onAdd={() => setAdding(true)}
          onInvite={setInviting}
        />
      ) : (
        <SummaryAnswer answer={server} what="to-do">
          {(data) => <ClientTasksBody view={data} today={ctx.today} timeZone={ctx.timeZone} />}
        </SummaryAnswer>
      )}
      <AddTaskSheet
        open={adding}
        side={side}
        agentFirstName={agentFirst}
        clients={clients}
        today={ctx.today}
        onClose={() => setAdding(false)}
        onAdd={async (t) => {
          await addClientTask({ workspaceId: ctx.workspaceId, dealId, ...t });
          toast.show(W.addedIt(who));
        }}
      />
      <MarkDoneSheet
        task={marking}
        clients={clients}
        onClose={() => setMarking(null)}
        onDone={async (task, personId, note) => {
          await markClientTaskDone({
            workspaceId: ctx.workspaceId,
            dealId,
            userId: ctx.userId,
            taskId: task.id,
            personId,
            note,
          });
          toast.show(W.marked);
        }}
      />
      <InviteSheet
        client={inviting}
        agentFirstName={agentFirst}
        onClose={() => setInviting(null)}
        onSend={async (c) => {
          await invitePortal({ workspaceId: ctx.workspaceId, personId: c.personId });
          if (c.email) toast.show(W.sentTo(c.email));
        }}
      />
    </DealSubpage>
  );
}

/** "Due today", "Oct 12 · call Capitol Title first", "Done Sep 22 in the portal". */
export function taskLine(t: Task, today: string, timeZone: string): string {
  if (t.status === 'done') {
    const inPortal = t.completions.some((c) => !c.recordedBy);
    return t.doneAt
      ? W.done(fmtMonthDay(localDayOf(t.doneAt, timeZone)), inPortal)
      : W.done('', inPortal);
  }
  if (t.status === 'canceled') return W.canceled;
  return [!t.dueOn ? W.noDate : t.dueOn === today ? W.dueToday : fmtMonthDay(t.dueOn), t.detail]
    .filter(Boolean)
    .join(' · ');
}

export function ClientTasksBody({
  view,
  today,
  timeZone,
  onTask,
  onAdd,
  onInvite,
}: {
  view: ClientTasksView;
  today: string;
  timeZone: string;
  onTask?: (task: Task) => void;
  onAdd?: () => void;
  onInvite?: (client: Client) => void;
}) {
  const who = firstNamesOf(view.clients.map((c) => c.name));
  const tasks = view.tasks.filter((t) => t.status !== 'canceled');
  const open = tasks.filter((t) => t.status === 'open').length;
  const notIn = view.clients.filter((c) => c.portal === 'none' || c.portal === 'revoked');
  return (
    <View className="gap-3" testID="client-tasks-body">
      <View className="flex-row items-baseline gap-2 px-1 pt-2">
        <Text variant="group">{W.label(who)}</Text>
        <Text className="text-xs text-text-3">{W.open(open)}</Text>
      </View>
      {tasks.length ? (
        <List testID="client-tasks">
          {tasks.map((t) => (
            <CheckRow
              key={t.id}
              checked={t.status === 'done'}
              label={t.title}
              line={taskLine(t, today, timeZone)}
              onPress={onTask && t.status === 'open' ? () => onTask(t) : undefined}
              testID={`client-task-${t.id}`}
            />
          ))}
        </List>
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{W.none(who)}</Text>
        </Card>
      )}
      {onAdd ? (
        <>
          <Button variant="secondary" icon={Plus} onPress={onAdd} testID="client-task-add">
            {W.add}
          </Button>
          <SignalNote>{W.reaches}</SignalNote>
        </>
      ) : null}
      {onInvite && notIn.length ? (
        <List testID="client-portal">
          {notIn.map((c) => (
            <CheckRow
              key={c.personId}
              label={W.notIn(c.name.split(/\s+/)[0] ?? c.name)}
              end={
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => onInvite(c)}
                  testID={`client-invite-${c.personId}`}
                >
                  {W.invite}
                </Button>
              }
            />
          ))}
        </List>
      ) : null}
    </View>
  );
}

export interface NewClientTask {
  readonly preset: ClientTaskPreset | null;
  readonly kind: 'upload' | 'sign_off' | 'do' | 'questionnaire';
  readonly title: string;
  readonly detail: string | null;
  readonly forPersonId: string | null;
  readonly dueOn: string | null;
}

/** A task for the clients: one of the usual ones, or their own words; for whom, and by when. */
export function AddTaskSheet({
  open,
  side,
  agentFirstName,
  clients,
  today,
  onClose,
  onAdd,
}: {
  open: boolean;
  side: 'buyer' | 'listing';
  agentFirstName: string;
  clients: readonly Client[];
  today: string;
  onClose: () => void;
  onAdd: (task: NewClientTask) => Promise<void>;
}) {
  const presets = presetsFor(side);
  const [preset, setPreset] = React.useState<ClientTaskPreset | 'other'>(presets[0] ?? 'other');
  const [title, setTitle] = React.useState('');
  const [forWhom, setForWhom] = React.useState<string>('all');
  const [due, setDue] = React.useState<'none' | 'today' | 'tomorrow' | 'week'>('none');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setPreset(presets[0] ?? 'other');
    setTitle('');
    setForWhom('all');
    setDue('none');
    setError(null);
    // The presets are fixed for a side.
  }, [open]);
  const add = async () => {
    const p = preset === 'other' ? null : CLIENT_TASK_PRESETS[preset];
    if (!p && !title.trim()) {
      setError(W.sayWhat);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd({
        preset: preset === 'other' ? null : preset,
        kind: p?.kind ?? 'do',
        title: p ? withAgent(p.title, agentFirstName) : title.trim(),
        detail: p ? withAgent(p.detail, agentFirstName) : null,
        forPersonId: forWhom === 'all' ? null : forWhom,
        dueOn:
          due === 'none' ? null : addDays(today, due === 'today' ? 0 : due === 'tomorrow' ? 1 : 7),
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={W.addTitle} testID="client-task-sheet">
      <View className="gap-3">
        <List>
          {[...presets, 'other' as const].map((k) => (
            <CheckRow
              key={k}
              checked={preset === k}
              label={
                k === 'other'
                  ? W.somethingElse
                  : withAgent(CLIENT_TASK_PRESETS[k].title, agentFirstName)
              }
              onPress={() => setPreset(k)}
              testID={`client-task-preset-${k}`}
            />
          ))}
        </List>
        {preset === 'other' ? (
          <>
            <FieldLabel>{W.taskTitle}</FieldLabel>
            <Input
              value={title}
              onChangeText={setTitle}
              invalid={!!error && !title.trim()}
              testID="client-task-title"
            />
          </>
        ) : null}
        {clients.length > 1 ? (
          <>
            <FieldLabel>{W.forWhom}</FieldLabel>
            <Chips
              value={forWhom}
              onChange={setForWhom}
              options={[
                ['all', W.everyone],
                ...clients.map((c) => [c.personId, c.name.split(/\s+/)[0] ?? c.name] as const),
              ]}
              testID="client-task-for"
            />
          </>
        ) : null}
        <FieldLabel>{W.due}</FieldLabel>
        <Chips
          value={due}
          onChange={setDue}
          options={[
            ['none', W.noDate],
            ['today', W.today],
            ['tomorrow', W.tomorrow],
            ['week', W.inAWeek],
          ]}
          testID="client-task-due"
        />
        <FieldError>{error}</FieldError>
        <Button loading={busy} onPress={() => void add()} testID="client-task-save">
          {W.addIt}
        </Button>
        <SignalNote>{W.reaches}</SignalNote>
      </View>
    </Sheet>
  );
}

/** Marking a task done for a client who did it another way: who, and how. */
export function MarkDoneSheet({
  task,
  clients,
  onClose,
  onDone,
}: {
  task: Task | null;
  clients: readonly Client[];
  onClose: () => void;
  onDone: (task: Task, personId: string, note: string) => Promise<void>;
}) {
  const [personId, setPersonId] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!task) return;
    setPersonId(task.forPersonId ?? clients[0]?.personId ?? '');
    setNote('');
    setError(null);
  }, [task, clients]);
  // A sign-off and a seller's questionnaire are the client's own.
  const theirs = task?.kind === 'sign_off' || task?.kind === 'questionnaire';
  const save = async () => {
    if (!task) return;
    setBusy(true);
    setError(null);
    try {
      await onDone(task, personId, note.trim());
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={!!task}
      onClose={onClose}
      title={task ? W.markTitle(task.title) : undefined}
      testID="client-task-done-sheet"
    >
      {theirs ? (
        <Text className="text-[14px] text-text-2">{W.theirOwn}</Text>
      ) : (
        <View className="gap-3">
          {clients.length > 1 && !task?.forPersonId ? (
            <>
              <FieldLabel>{W.markFor}</FieldLabel>
              <Chips
                value={personId}
                onChange={setPersonId}
                options={clients.map(
                  (c) => [c.personId, c.name.split(/\s+/)[0] ?? c.name] as const,
                )}
                testID="client-task-done-for"
              />
            </>
          ) : null}
          <FieldLabel>{W.how}</FieldLabel>
          <Input
            value={note}
            onChangeText={setNote}
            placeholder={W.howHint}
            testID="client-task-done-how"
          />
          <FieldError>{error}</FieldError>
          <ChangeButton
            command="realestate.client_task.mark_done"
            label={W.markDone}
            why={W.markWhy}
            loading={busy}
            disabled={!note.trim() || !personId}
            onPress={() => void save()}
            testID="client-task-done-save"
          />
        </View>
      )}
    </Sheet>
  );
}

/** Asking a client into their portal, or sending the link again: it emails them, so it needs signal. */
export function InviteSheet({
  client,
  agentFirstName,
  onClose,
  onSend,
}: {
  client: Client | null;
  agentFirstName: string;
  onClose: () => void;
  onSend: (client: Client) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => setError(null), [client]);
  const first = client?.name.split(/\s+/)[0] ?? '';
  const again = client?.portal === 'invited' || client?.portal === 'signed_in';
  return (
    <Sheet
      open={!!client}
      onClose={onClose}
      title={client ? W.inviteTitle(first, again) : undefined}
      testID="client-invite-sheet"
    >
      {client ? (
        <View className="gap-3">
          {client.email ? (
            <>
              <Text className="text-[14.5px] leading-[21px] text-text-2">
                {W.inviteAbout(client.email, first)}
              </Text>
              <Card className="bg-card-2 p-3">
                <Text className="text-[13px] leading-[19px]">{W.inviteSees(agentFirstName)}</Text>
              </Card>
            </>
          ) : (
            <Text className="text-[14.5px] leading-[21px] text-warning-text">
              {W.noEmail(client.name)}
            </Text>
          )}
          <FieldError>{error}</FieldError>
          <SignalButton
            label={W.send(again)}
            why={W.sendWhy}
            disabled={busy || !client.email}
            onPress={() => {
              setBusy(true);
              setError(null);
              onSend(client)
                .then(onClose)
                .catch((e: unknown) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
            testID="client-invite-send"
          />
        </View>
      ) : null}
    </Sheet>
  );
}
