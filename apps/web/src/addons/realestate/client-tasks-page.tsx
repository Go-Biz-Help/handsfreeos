'use client';
/**
 * What a deal's clients do themselves in their portal (board 24, design/realestate/ClientTasks.dc.html): each task,
 * who it's waiting on and what each client did; letting a client into the portal; and marking a task done for a
 * client who did it another way, with a note.
 *
 * `?invite=1` opens the invitation for the first client not in the portal yet.
 */
import { fmtMonthDay } from '@hfos/core';
import {
  CLIENT_TASK_KIND_KEYS,
  CLIENT_TASK_KINDS,
  CLIENT_TASK_PRESETS,
  presetsFor,
  withAgent,
  type ClientTaskPreset,
} from '@hfos/core/addons/realestate/client-words';
import { Check, Circle, Mail } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { CardHead } from './bits';

/** The kinds an agent adds by hand (a questionnaire is asked from the listing). */
type AddableKind = (typeof CLIENT_TASK_KIND_KEYS)[number];
import { DealCrumb, firstNames } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import type { ClientTask, ClientTaskList, DealClient } from './types';
import { useAct } from './use-act';

const thisYear = () => new Date().getFullYear();

const PORTAL_WORDS: Readonly<Record<DealClient['portal'], string>> = {
  none: 'Not in the portal',
  invited: 'Invited, not signed in yet',
  signed_in: 'In the portal',
  revoked: 'Portal turned off',
};

export function ClientTasksPage({
  workspaceId,
  dealId,
  dealName,
  side,
  agentName,
  data,
  files,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  side: 'buyer' | 'listing';
  agentName: string | null;
  data: ClientTaskList;
  files: readonly { readonly id: string; readonly name: string }[];
  live: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { clients, tasks } = data;
  const notIn = clients.filter((c) => c.portal === 'none' || c.portal === 'revoked');
  // Opened from the deal page's card: the first client not in the portal yet.
  const [inviting, setInviting] = useState<DealClient | null>(() =>
    params.get('invite') === '1' ? (notIn[0] ?? null) : null,
  );
  const closeInvite = () => {
    setInviting(null);
    if (params.get('invite')) router.replace(pathname, { scroll: false });
  };
  const [adding, setAdding] = useState(false);
  const [marking, setMarking] = useState<ClientTask | null>(null);
  const [canceling, setCanceling] = useState<ClientTask | null>(null);
  const [revoking, setRevoking] = useState<DealClient | null>(null);
  const who = firstNames(clients.map((c) => c.name)) || 'the clients';
  const nameOf = (personId: string | null) =>
    personId ? (clients.find((c) => c.personId === personId)?.name ?? 'A client') : null;
  return (
    <div data-testid="realestate-client-tasks">
      <DealCrumb
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={dealName}
        here="Client’s to-do"
      />
      <PageHeader
        title="Client’s to-do"
        description={`${dealName} · what ${who} ${clients.length === 1 ? 'does' : 'do'} themselves, in their portal`}
        actions={
          live ? (
            <>
              <Button
                variant="secondary"
                onClick={() => setAdding(true)}
                data-testid="client-task-add"
              >
                Add a task for them
              </Button>
              {notIn.length ? (
                <Button onClick={() => setInviting(notIn[0]!)} data-testid="portal-invite">
                  Invite to the portal
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">
        <Card className="p-0" data-testid="client-tasks">
          {tasks.length === 0 ? (
            <p className="px-5 py-6 text-[13.5px] text-text-2">
              Nothing asked of {who} yet. Ask for their preapproval letter or ID, and they do it in
              their portal.
            </p>
          ) : (
            <ul>
              {tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3.5 last:border-b-0 md:px-5"
                >
                  {t.status === 'done' ? (
                    <span className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-success text-on-solid">
                      <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                    </span>
                  ) : (
                    <Circle
                      className="mt-0.5 h-6 w-6 flex-none text-border-strong"
                      strokeWidth={1.5}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        'text-[14px] font-medium',
                        t.status !== 'open' && 'text-text-2',
                      )}
                    >
                      {t.title}
                    </div>
                    <div className="text-[12.5px] text-text-3">
                      {[
                        CLIENT_TASK_KINDS[t.kind],
                        t.forPersonId ? `For ${nameOf(t.forPersonId)}` : 'For every client',
                        t.dueOn ? `by ${fmtMonthDay(t.dueOn, thisYear())}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    {t.completions.map((c) => (
                      <div key={c.personId} className="text-[12.5px] text-text-2">
                        {c.recordedBy
                          ? `${c.recordedBy.fullName} marked it done for ${firstNames([c.name])}`
                          : `${firstNames([c.name])} did it`}
                        {c.file ? ` · ${c.file.name}` : ''}
                        {c.signedWords ? ' · signed off' : ''}
                        {c.note ? `: ${c.note}` : ''}
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-none items-center gap-1.5">
                    {t.status === 'done' ? (
                      <Badge variant="ok">Done</Badge>
                    ) : t.status === 'canceled' ? (
                      <Badge variant="gray">Canceled</Badge>
                    ) : (
                      <Badge variant="pending">{t.waiting ?? 'Open'}</Badge>
                    )}
                    {live && t.status === 'open' ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setMarking(t)}>
                          Mark done
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setCanceling(t)}>
                          Cancel
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="h-fit p-4 md:p-5" data-testid="client-portal">
          <CardHead title="Their portal" />
          {clients.length === 0 ? (
            <p className="text-[13.5px] text-text-2">
              No clients on the deal yet. Add them under People on the deal.
            </p>
          ) : (
            <ul className="space-y-3">
              {clients.map((c) => (
                <li key={c.personId} className="text-[13.5px]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={`/app/w/${workspaceId}/customers/people/${c.personId}`}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                      <div className="text-[12.5px] text-text-2">
                        {PORTAL_WORDS[c.portal]}
                        {c.portalSince && c.portal !== 'revoked'
                          ? ` · since ${fmtMonthDay(c.portalSince.slice(0, 10), thisYear())}`
                          : ''}
                      </div>
                    </div>
                    {live ? (
                      c.portal === 'none' || c.portal === 'revoked' ? (
                        <Button size="sm" variant="secondary" onClick={() => setInviting(c)}>
                          Invite
                        </Button>
                      ) : (
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setInviting(c)}>
                            Send again
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setRevoking(c)}>
                            Turn off
                          </Button>
                        </div>
                      )
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {inviting ? (
        <InviteDialog
          client={inviting}
          onClose={closeInvite}
          workspaceId={workspaceId}
          agentName={agentName}
        />
      ) : null}
      {adding ? (
        <AddTaskDialog
          onClose={() => setAdding(false)}
          workspaceId={workspaceId}
          dealId={dealId}
          side={side}
          clients={clients}
          agentName={agentName}
        />
      ) : null}
      {marking ? (
        <MarkDoneDialog
          task={marking}
          onClose={() => setMarking(null)}
          workspaceId={workspaceId}
          clients={clients}
          files={files}
        />
      ) : null}
      <ReasonDialog
        open={!!canceling}
        onOpenChange={(o) => !o && setCanceling(null)}
        title="Cancel the task?"
        description="It comes off their to-do. What they already did is kept."
        submit="Cancel it"
        done="Canceled."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.client_task.cancel', {
              body: { workspaceId, taskId: canceling!.id, reason },
            }),
          )
        }
      />
      <TurnOffDialog
        client={revoking}
        onClose={() => setRevoking(null)}
        workspaceId={workspaceId}
      />
    </div>
  );
}

function InviteDialog({
  client: c,
  onClose,
  workspaceId,
  agentName,
}: {
  client: DealClient;
  onClose: () => void;
  workspaceId: string;
  agentName: string | null;
}) {
  const first = firstNames([c.name]);
  const again = c.portal === 'invited' || c.portal === 'signed_in';
  const { busy, act } = useAct(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={again ? `Send ${first} the link again?` : `Invite ${first} to the portal?`}
      >
        <div className="mt-3 space-y-3 text-[14px]" data-testid="invite-dialog">
          {c.email ? (
            <>
              <p className="text-text-2">
                We’ll email <span className="font-semibold text-text">{c.email}</span> a private
                link. The first time {first} opens it on a device, they type a 6-digit code we email
                them. No password.
              </p>
              <div className="rounded-menu bg-card-2 px-3.5 py-3 text-[13px]">
                They’ll see where the deal stands, its key dates, their to-do, the homes and tours,
                and can message {agentName ? firstNames([agentName]) : 'you'}. They won’t see your
                notes, duties or other clients.
              </div>
            </>
          ) : (
            <Callout tone="warning" icon={Mail}>
              {c.name} has no email address, so there’s nowhere to send the link or the code. Add
              their email on{' '}
              <Link
                href={`/app/w/${workspaceId}/customers/people/${c.personId}`}
                className="underline"
              >
                their page
              </Link>{' '}
              first.
            </Callout>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!c.email}
              loading={busy === 'give'}
              onClick={() =>
                void act(
                  'give',
                  async () =>
                    unwrap(
                      await apiBrowser().POST('/v1/commands/portal_access.give', {
                        body: { workspaceId, personId: c.personId },
                      }),
                    ),
                  `Sent to ${c.email}.`,
                )
              }
              data-testid="invite-send"
            >
              {again ? 'Send it again' : 'Send the invite'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TurnOffDialog({
  client,
  onClose,
  workspaceId,
}: {
  client: DealClient | null;
  onClose: () => void;
  workspaceId: string;
}) {
  const { busy, act } = useAct(onClose);
  return (
    <Dialog open={!!client} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Turn off ${client ? firstNames([client.name]) : 'their'}’s portal?`}
        description="Every device they signed in on is signed out, and every link sent stops working. You can invite them again later."
      >
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy === 'off'}
            onClick={() =>
              void act(
                'off',
                async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/portal_access.revoke', {
                      body: { workspaceId, personId: client!.personId },
                    }),
                  ),
                'Turned off.',
              )
            }
          >
            Turn it off
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddTaskDialog({
  onClose,
  workspaceId,
  dealId,
  side,
  clients,
  agentName,
}: {
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  side: 'buyer' | 'listing';
  clients: readonly DealClient[];
  agentName: string | null;
}) {
  const agent = agentName ? firstNames([agentName]) : 'your agent';
  const presets = presetsFor(side);
  const [preset, setPreset] = useState<ClientTaskPreset | ''>(presets[0] ?? '');
  const p = preset ? CLIENT_TASK_PRESETS[preset] : null;
  const [kind, setKind] = useState<AddableKind>('upload');
  const [title, setTitle] = useState(p?.title ?? '');
  const [detail, setDetail] = useState(p ? withAgent(p.detail, agent) : '');
  const [signOff, setSignOff] = useState('');
  const [forPerson, setForPerson] = useState('');
  const [due, setDue] = useState('');
  const pick = (k: ClientTaskPreset | '') => {
    setPreset(k);
    const x = k ? CLIENT_TASK_PRESETS[k] : null;
    setKind(x?.kind ?? 'do');
    setTitle(x?.title ?? '');
    setDetail(x ? withAgent(x.detail, agent) : '');
    setSignOff(x && 'signOffWords' in x ? withAgent(x.signOffWords, agent) : '');
  };
  const { busy, errors, act } = useAct(onClose);
  const k = p?.kind ?? kind;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Add a task for them"
        description="It shows on their to-do in the portal."
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'add',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.client_task.add', {
                    body: {
                      workspaceId,
                      dealId,
                      preset: preset || undefined,
                      kind: preset ? undefined : kind,
                      title: title.trim() || undefined,
                      detail: detail.trim() || undefined,
                      signOffWords: k === 'sign_off' ? signOff.trim() || undefined : undefined,
                      forPersonId: forPerson || undefined,
                      dueOn: due || undefined,
                    },
                  }),
                ),
              'Added to their to-do.',
            );
          }}
        >
          <Field label="Task" htmlFor="ct-preset">
            <Select
              id="ct-preset"
              value={preset}
              onChange={(e) => pick(e.target.value as ClientTaskPreset | '')}
            >
              {presets.map((x) => (
                <option key={x} value={x}>
                  {CLIENT_TASK_PRESETS[x].title}
                </option>
              ))}
              <option value="">Something else…</option>
            </Select>
          </Field>
          {!preset ? (
            <Field label="What kind" htmlFor="ct-kind">
              <Select
                id="ct-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as AddableKind)}
              >
                {CLIENT_TASK_KIND_KEYS.map((x) => (
                  <option key={x} value={x}>
                    {CLIENT_TASK_KINDS[x]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Title" htmlFor="ct-title" error={errors.title}>
            <Input id="ct-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="What to do" htmlFor="ct-detail" error={errors.detail}>
            <Textarea
              id="ct-detail"
              rows={3}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              className="min-h-[72px]"
            />
          </Field>
          {k === 'sign_off' ? (
            <Field
              label="The words they sign off on"
              htmlFor="ct-sign"
              hint="Kept exactly as they read them."
              error={errors.signOffWords}
            >
              <Textarea
                id="ct-sign"
                rows={2}
                value={signOff}
                onChange={(e) => setSignOff(e.target.value)}
                className="min-h-[60px]"
              />
            </Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {clients.length > 1 ? (
              <Field label="For" htmlFor="ct-for">
                <Select
                  id="ct-for"
                  value={forPerson}
                  onChange={(e) => setForPerson(e.target.value)}
                >
                  <option value="">Every client</option>
                  {clients.map((c) => (
                    <option key={c.personId} value={c.personId}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="By (optional)" htmlFor="ct-due">
              <Input id="ct-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'add'} data-testid="client-task-save">
              Add it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MarkDoneDialog({
  task,
  onClose,
  workspaceId,
  clients,
  files,
}: {
  task: ClientTask;
  onClose: () => void;
  workspaceId: string;
  clients: readonly DealClient[];
  files: readonly { readonly id: string; readonly name: string }[];
}) {
  const due = task.forPersonId ? clients.filter((c) => c.personId === task.forPersonId) : clients;
  const left = due.filter((c) => !task.completions.some((x) => x.personId === c.personId));
  const [personId, setPersonId] = useState(left[0]?.personId ?? due[0]?.personId ?? '');
  const [note, setNote] = useState('');
  const [fileId, setFileId] = useState('');
  const { busy, errors, act } = useAct(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Mark it done for them"
        description={`${task.title}. For when they did it another way, like handing it over at the office.`}
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'done',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.client_task.mark_done', {
                    body: {
                      workspaceId,
                      taskId: task.id,
                      personId,
                      note,
                      fileId: fileId || undefined,
                    },
                  }),
                ),
              'Marked done.',
            );
          }}
        >
          {due.length > 1 ? (
            <Field label="For" htmlFor="md-who">
              <Select id="md-who" value={personId} onChange={(e) => setPersonId(e.target.value)}>
                {due.map((c) => (
                  <option key={c.personId} value={c.personId}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="How it was done" htmlFor="md-note" error={errors.note}>
            <Input
              id="md-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="She brought it to the office"
            />
          </Field>
          {task.kind === 'upload' && files.length ? (
            <Field label="The file (optional)" htmlFor="md-file">
              <Select id="md-file" value={fileId} onChange={(e) => setFileId(e.target.value)}>
                <option value="">None</option>
                {files.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'done'} disabled={!personId || !note.trim()}>
              Mark done
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
