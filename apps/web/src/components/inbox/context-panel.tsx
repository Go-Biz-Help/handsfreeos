'use client';
import {
  ArrowRight,
  Clock,
  Link as LinkIcon,
  Mail,
  MapPin,
  Phone,
  Plus,
  UserPlus,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { NextActionChip, StageBadge, TagChip } from '@/components/crm/chips';
import { LeadDialog } from '@/components/crm/lead-dialog';
import { TaskDialog } from '@/components/tasks/task-dialog';
import { Button, ButtonLink } from '@/components/ui/button';
import { useCalls } from '@/lib/calls/call-provider';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ConversationGet, Pipeline } from '@/lib/api/types';
import { addressLine, formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ContactAvatar, Pill } from './bits';

const Label = ({ children }: { children: string }) => (
  <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
    {children}
  </div>
);

function Row({ icon: Icon, children }: { icon: typeof Phone; children: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-text-2">
      <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
      <span className="truncate">{children}</span>
    </div>
  );
}

/**
 * Who this is, beside the conversation: the customer's card, their open lead and tasks, and what arrives
 * later. A number nobody has linked gets "add" and "link" instead.
 */
export function ContextPanel({
  data,
  workspaceId,
  myUserId,
  members,
  pipelines,
  onAddPerson,
  onLinkPerson,
  extra,
}: {
  data: ConversationGet;
  workspaceId: string;
  myUserId: string;
  members: { id: string; fullName: string }[];
  pipelines: Pipeline[];
  onAddPerson: () => void;
  onLinkPerson: () => void;
  /** What the AI teammate is doing in this conversation. */
  extra?: ReactNode;
}) {
  const router = useRouter();
  const { person, conversation: c } = data;
  const [newLead, setNewLead] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [completing, setCompleting] = useState<string | null>(null);
  const calls = useCalls();

  async function complete(taskId: string) {
    setCompleting(taskId);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/task.complete', { body: { workspaceId, taskId } }),
      );
      toast.success('Task completed.');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCompleting(null);
    }
  }

  if (!person)
    return (
      <div className="flex flex-col gap-3" data-testid="context-panel">
        <div className="flex items-center gap-3">
          <ContactAvatar person={null} size="panel" />
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold">{c.counterpartDisplay}</h3>
            <div className="text-xs text-text-3">
              {c.channel === 'chat' ? 'First wrote in the website chat' : 'First texted'}{' '}
              {formatDate(c.createdAt, { time: true })}
            </div>
          </div>
        </div>
        <p className="text-[13px] text-text-2">
          {c.channel === 'chat'
            ? 'This visitor doesn’t match anyone in Customers. Once you add or link them, this chat shows on their timeline.'
            : 'This number doesn’t match anyone in Customers. Once you add or link them, this conversation and any calls show on their timeline.'}
        </p>
        <Button size="sm" onClick={onAddPerson} data-testid="context-add-person">
          <UserPlus className="h-3.5 w-3.5" strokeWidth={1.5} />
          Add as a new person
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onLinkPerson}
          data-testid="context-link-person"
        >
          <LinkIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
          Link to an existing customer
        </Button>
        {extra}
      </div>
    );

  const lead = c.openLead;
  const address = addressLine(person.address);
  return (
    <div className="flex flex-col gap-[18px]" data-testid="context-panel">
      <section className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <ContactAvatar person={person} size="panel" />
          <div className="min-w-0 pt-0.5">
            <h3 className="truncate text-[15px] font-semibold">{person.fullName}</h3>
            <div className="text-xs text-text-3">
              Customer since {new Date(person.customerSince).getFullYear()}
            </div>
          </div>
        </div>
        <div className="mt-1 flex flex-col gap-1.5">
          {person.phone ? <Row icon={Phone}>{person.phone}</Row> : null}
          {person.email ? <Row icon={Mail}>{person.email}</Row> : null}
          {address ? <Row icon={MapPin}>{address}</Row> : null}
        </div>
        {person.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {person.tags.map((t) => (
              <TagChip key={t.id} name={t.name} color={t.color} />
            ))}
          </div>
        ) : null}
        <div className="mt-1 flex gap-2">
          {calls.available ? (
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              data-testid="context-call"
              onClick={() =>
                calls.openDialer({
                  name: person.fullName,
                  phone: c.counterpart,
                  personId: person.id,
                  conversationId: c.id,
                })
              }
            >
              <Phone className="h-3.5 w-3.5" strokeWidth={1.5} />
              Call
            </Button>
          ) : null}
          <ButtonLink
            href={`/app/w/${workspaceId}/customers/people/${person.id}`}
            size="sm"
            className="flex-1"
          >
            Open customer
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} />
          </ButtonLink>
        </div>
      </section>

      <div className="h-px bg-border" />

      <section className="flex flex-col gap-2">
        <Label>Open lead</Label>
        {lead ? (
          <div className="rounded-[10px] border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[13px] font-medium">{lead.title}</span>
              <StageBadge name={lead.stageName} kind="open" className="h-5 text-[11.5px]" />
            </div>
            <div className="mt-0.5 text-xs text-text-2">{formatMoney(lead.valueCents)}</div>
            {lead.nextAction ? (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-text-2">
                <Clock className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
                <span className="truncate">
                  {lead.nextAction}
                  {lead.nextActionAt ? ` · ${formatDate(lead.nextActionAt)}` : ''}
                </span>
              </div>
            ) : (
              <NextActionChip text={null} className="mt-2" />
            )}
          </div>
        ) : (
          <div className="text-[13px] text-text-3">
            No open lead.{' '}
            <button
              type="button"
              className="font-medium text-accent-text hover:underline"
              onClick={() => setNewLead(true)}
            >
              Start one
            </button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <Label>Open tasks</Label>
        {data.openTasks.length === 0 ? (
          <div className="text-[13px] text-text-3">Nothing due.</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.openTasks.map((t) => (
              <li key={t.id} className="flex items-start gap-2.5">
                <button
                  type="button"
                  aria-label={`Complete ${t.title}`}
                  disabled={completing === t.id}
                  onClick={() => void complete(t.id)}
                  className="mt-px h-[18px] w-[18px] flex-none rounded-full border-[1.5px] border-border-strong hover:border-accent disabled:opacity-50"
                />
                <div className="min-w-0">
                  <div className="text-[13px]">{t.title}</div>
                  {t.dueAt ? (
                    <div
                      className={cn(
                        'text-xs',
                        t.overdue ? 'font-medium text-danger-text' : 'text-text-3',
                      )}
                    >
                      {t.overdue ? 'Due ' : ''}
                      {formatDate(t.dueAt, { time: !t.allDay })}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5 self-start"
          onClick={() => setNewTask(true)}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          Add task
        </Button>
      </section>

      {extra}

      <div className="h-px bg-border" />

      <section className="flex flex-col gap-1">
        <Label>Coming later</Label>
        {['Appointments', 'Balance and invoices', 'AI summary of this customer'].map((label) => (
          <div
            key={label}
            className="flex h-[26px] items-center justify-between text-[13px] text-text-3"
          >
            {label}
            <Pill>Later</Pill>
          </div>
        ))}
      </section>

      <LeadDialog
        workspaceId={workspaceId}
        open={newLead}
        onOpenChange={setNewLead}
        pipelines={pipelines}
        members={members}
        myUserId={myUserId}
        record={{ personId: person.id, name: person.fullName }}
        onCreated={() => router.refresh()}
      />
      <TaskDialog
        workspaceId={workspaceId}
        open={newTask}
        onOpenChange={setNewTask}
        members={members}
        myUserId={myUserId}
        relation={{ personId: person.id }}
      />
    </div>
  );
}
