'use client';
import { CONTACT_EDIT_WORDS, splitName, THREAD_NOTE_WORDS } from '@hfos/core';
import {
  ArrowRight,
  CalendarPlus,
  Clock,
  FileText,
  Link as LinkIcon,
  Mail,
  MapPin,
  Phone,
  Plus,
  Receipt,
  UserRound,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { AppointmentDialog } from '@/components/calendar/appointment-dialog';
import { firstName } from '@/components/calendar/appt';
import { NextActionChip, StageBadge } from '@/components/crm/chips';
import { LeadDialog } from '@/components/crm/lead-dialog';
import { NextActionDialog } from '@/components/crm/next-action-dialog';
import { InboxOwed, useRecordMoney } from '@/components/crm/record-money';
import { TagPicker } from '@/components/crm/tag-picker';
import { TaskDialog } from '@/components/tasks/task-dialog';
import { Button, ButtonLink } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { useCalls } from '@/lib/calls/call-provider';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { orNull, saveTagChanges } from '@/lib/api/edits';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import type { ConversationGet, Ok, Pipeline, Tag } from '@/lib/api/types';
import { addressLine, formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ContactAvatar } from './bits';
import { AddPersonInline, InlineField, NoteBox } from './contact-fields';

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

type Visit = Ok<'/v1/queries/appointment.list'>['items'][number];

/**
 * The details the panel edits one at a time. The rest of the customer is the full form's.
 *
 * A name is cleared to empty rather than to nothing, the way `person.update` takes it; a number or an address
 * that is gone is null.
 */
interface PersonEdit {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  email?: string | null;
}

/** The same details as the panel showed them, which every edit sends so the merge keeps the newest of each. */
type PersonSeen = Partial<Record<keyof PersonEdit, string | null>>;

/** How far ahead the panel looks. A year is past anything a small business books. */
const AHEAD_MS = 365 * 24 * 60 * 60_000;

/**
 * This customer's next visits (M17).
 *
 * Asked for here rather than added to `conversation.get`, which every keystroke in the inbox already
 * reloads — the same reason `useRecordMoney` next to it fetches its own. A null person asks nothing, so the
 * hook is safe to run before the unknown-contact branch returns.
 */
function useUpcomingVisits(workspaceId: string, personId: string | null): readonly Visit[] {
  const version = useLiveVersion(['appointment']);
  const [items, setItems] = useState<readonly Visit[]>([]);
  const load = useCallback(async () => {
    if (!personId) {
      setItems([]);
      return;
    }
    try {
      const now = Date.now();
      const got = unwrap(
        await apiBrowser().POST('/v1/queries/appointment.list', {
          body: {
            workspaceId,
            personId,
            from: new Date(now).toISOString(),
            to: new Date(now + AHEAD_MS).toISOString(),
          },
        }),
      );
      setItems(got.items);
    } catch {
      // A panel that cannot reach the calendar shows no visits rather than an error beside the customer.
      setItems([]);
    }
  }, [workspaceId, personId]);
  useEffect(() => {
    void load();
  }, [load, version]);
  return items;
}

/**
 * Who this is, beside the conversation: the customer's card, their open lead, tasks and next visits — and, since
 * M10 step 15 continued, the place you change any of it without leaving the thread.
 *
 * What can be edited here is what you learn mid-conversation: their name, their number, their email, a tag, a note,
 * where the lead stands. Address, company, owner and source are a click further on in the full form, which
 * `onEditPerson` opens — it fetches the customer's details then, rather than making `conversation.get` carry them
 * on every keystroke.
 *
 * A number nobody has linked gets named right here instead, with "link" beside it for when it is somebody you
 * already have.
 */
export function ContextPanel({
  data,
  workspaceId,
  myUserId,
  members,
  pipelines,
  tags,
  canMoney,
  onAddPerson,
  onLinkPerson,
  onEditPerson,
  onPersonCreated,
  extra,
}: {
  data: ConversationGet;
  workspaceId: string;
  myUserId: string;
  members: { id: string; fullName: string }[];
  pipelines: Pipeline[];
  tags: Tag[];
  /**
   * Whether estimates and invoices are this person's to write. Everything else here is `records.write`, which
   * everyone who can open the inbox normally has; money is for whoever the business lets bill (`money.bill`, 0103),
   * and its editor 404s for anyone else — so the links are the one thing the panel hides rather than offers and
   * then refuses.
   */
  canMoney: boolean;
  onAddPerson: () => void;
  onLinkPerson: () => void;
  /** Opens the whole customer form over the conversation. */
  onEditPerson: () => void;
  /** A customer named here: the conversation is linked to them. */
  onPersonCreated: (personId: string) => void;
  /** What the AI teammate is doing in this conversation. */
  extra?: ReactNode;
}) {
  const router = useRouter();
  const { person, conversation: c } = data;
  const [newLead, setNewLead] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [booking, setBooking] = useState(false);
  const [nextAction, setNextAction] = useState(false);
  const [completing, setCompleting] = useState<string | null>(null);
  const [movingStage, setMovingStage] = useState(false);
  const calls = useCalls();
  /** What this customer owes. Hooks run before the unknown-contact branch returns; a null id asks nothing. */
  const owed = useRecordMoney(workspaceId, 'person', data.person?.id ?? null);
  const visits = useUpcomingVisits(workspaceId, data.person?.id ?? null);

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

  /**
   * One detail of the customer, saved on its own.
   *
   * `base` is what the panel showed, so a detail somebody else changed meanwhile is not written back over — the
   * same field-merge rule the full form follows. The number travels as it is stored (E.164), not as it is shown.
   */
  async function saveField(changes: PersonEdit, base: PersonSeen): Promise<boolean> {
    if (!person) return false;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/person.update', {
          body: { workspaceId, personId: person.id, ...changes, base },
        }),
      );
      toast.success(CONTACT_EDIT_WORDS.saved);
      router.refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  }

  async function saveTags(next: string[]) {
    if (!person) return;
    try {
      const changed = await saveTagChanges(
        workspaceId,
        'person',
        person.id,
        person.tags.map((t) => t.id),
        next,
      );
      if (changed) router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
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
        <AddPersonInline
          workspaceId={workspaceId}
          phone={c.channel === 'sms' ? c.counterpartDisplay : (data.chat?.phone ?? null)}
          email={c.channel === 'email' ? c.counterpart : null}
          defaultName={c.channel === 'chat' ? (data.chat?.name ?? undefined) : undefined}
          onCreated={onPersonCreated}
          onMoreDetails={onAddPerson}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={onLinkPerson}
          data-testid="context-link-person"
        >
          <LinkIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
          {CONTACT_EDIT_WORDS.linkInstead}
        </Button>
        {extra}
      </div>
    );

  const lead = c.openLead;
  const address = addressLine(person.address);
  /**
   * The open stages only. Won and Lost are decisions, not a step along: `lead.move_stage` refuses a lost stage
   * without a reason, and the place that asks for one is the lead's own page. From a conversation you move the
   * lead along; you close it out where closing it out is spelled properly.
   */
  const stages = lead
    ? (pipelines.find((p) => p.id === lead.pipelineId)?.stages ?? []).filter(
        (s) => s.kind === 'open',
      )
    : [];

  async function moveStage(stageId: string) {
    if (!lead || stageId === lead.stageId) return;
    setMovingStage(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/lead.move_stage', {
          body: { workspaceId, leadId: lead.id, stageId },
        }),
      );
      toast.success(
        CONTACT_EDIT_WORDS.moved(stages.find((s) => s.id === stageId)?.name ?? 'the next stage'),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setMovingStage(false);
    }
  }

  return (
    <div className="flex flex-col gap-[18px]" data-testid="context-panel">
      <section className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <ContactAvatar person={person} size="panel" />
          <div className="min-w-0 flex-1 pt-0.5">
            <InlineField
              icon={UserRound}
              label={CONTACT_EDIT_WORDS.editName}
              value={person.fullName}
              empty={CONTACT_EDIT_WORDS.namePlaceholder}
              placeholder={CONTACT_EDIT_WORDS.namePlaceholder}
              className="text-[15px] font-semibold text-text"
              testId="context-name"
              onSave={(next) =>
                saveField(splitName(next), {
                  firstName: person.firstName,
                  lastName: person.lastName,
                })
              }
            />
            <div className="text-xs text-text-3">
              Customer since {new Date(person.customerSince).getFullYear()}
            </div>
          </div>
        </div>
        <div className="mt-1 flex flex-col gap-1.5">
          <InlineField
            icon={Phone}
            type="tel"
            label={CONTACT_EDIT_WORDS.editPhone}
            value={person.phone ?? ''}
            empty={CONTACT_EDIT_WORDS.noPhone}
            placeholder={CONTACT_EDIT_WORDS.phonePlaceholder}
            testId="context-phone"
            onSave={(next) =>
              saveField({ phone: orNull(next) }, { phone: person.phoneE164 ?? person.phone })
            }
          />
          <InlineField
            icon={Mail}
            type="email"
            label={CONTACT_EDIT_WORDS.editEmail}
            value={person.email ?? ''}
            empty={CONTACT_EDIT_WORDS.noEmail}
            placeholder={CONTACT_EDIT_WORDS.emailPlaceholder}
            testId="context-email"
            onSave={(next) => saveField({ email: orNull(next) }, { email: person.email })}
          />
          {/* The address is set in the full form, where its four lines have room. */}
          {address ? <Row icon={MapPin}>{address}</Row> : null}
        </div>
        {/* Compact: the chips are the tags, and the one next to them adds another. */}
        <TagPicker
          workspaceId={workspaceId}
          tags={tags}
          selected={person.tags.map((t) => t.id)}
          onChange={(ids) => void saveTags(ids)}
          compact
        />
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
        <button
          type="button"
          onClick={onEditPerson}
          className="-ml-0.5 self-start text-[12.5px] font-medium text-accent-text hover:underline"
          data-testid="context-edit-all"
        >
          {CONTACT_EDIT_WORDS.editAll}
        </button>
      </section>

      <div className="h-px bg-border" />

      {/* What they owe, before the lead: it changes how you answer, and only shows when there is something. */}
      <InboxOwed workspaceId={workspaceId} personId={person.id} found={owed} />

      <section className="flex flex-col gap-2">
        <Label>Open lead</Label>
        {lead ? (
          <div className="rounded-[10px] border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[13px] font-medium">{lead.title}</span>
              <StageBadge name={lead.stageName} kind="open" className="h-5 text-[11.5px]" />
            </div>
            <div className="mt-0.5 text-xs text-text-2">{formatMoney(lead.valueCents)}</div>
            {stages.length > 1 ? (
              <Select
                selectSize="sm"
                className="mt-2"
                aria-label={CONTACT_EDIT_WORDS.stage}
                value={lead.stageId}
                disabled={movingStage}
                onChange={(e) => void moveStage(e.target.value)}
                data-testid="context-stage"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            ) : null}
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
            <button
              type="button"
              onClick={() => setNextAction(true)}
              className="mt-2 text-[12.5px] font-medium text-accent-text hover:underline"
              data-testid="context-next-action"
            >
              {CONTACT_EDIT_WORDS.nextAction}
            </button>
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
        <Label>{THREAD_NOTE_WORDS.add}</Label>
        <NoteBox workspaceId={workspaceId} personId={person.id} onAdded={() => router.refresh()} />
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

      <section className="flex flex-col gap-2">
        <Label>Next visits</Label>
        {visits.length === 0 ? (
          <div className="text-[13px] text-text-3">Nothing booked.</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {visits.slice(0, 3).map((v) => (
              <li key={v.id} className="flex items-start gap-2.5">
                <span
                  aria-hidden
                  className="mt-[5px] h-2 w-2 flex-none rounded-full"
                  style={{ backgroundColor: v.calendar.color }}
                />
                <div className="min-w-0">
                  <div className="truncate text-[13px]">{v.service?.name ?? v.title}</div>
                  <div className="text-xs text-text-3">
                    {formatDate(v.startsAt, { time: true })}
                    {v.staff.length
                      ? ` · ${v.staff.map((p) => firstName(p.fullName)).join(', ')}`
                      : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5 self-start"
          onClick={() => setBooking(true)}
          data-testid="context-book-visit"
        >
          <CalendarPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
          Book a visit
        </Button>
      </section>

      {/*
       * Estimates and invoices are written in the real editor, which is a page, not a panel. `?person=` fills the
       * customer in, so this is one click and the same document everyone else's is.
       */}
      {canMoney ? (
        <section className="flex flex-col gap-1">
          <Label>Money</Label>
          <ButtonLink
            href={`/app/w/${workspaceId}/money/estimates/new?person=${person.id}`}
            variant="ghost"
            size="sm"
            className="-ml-2.5 self-start"
            data-testid="context-new-estimate"
          >
            <FileText className="h-3.5 w-3.5" strokeWidth={1.75} />
            {CONTACT_EDIT_WORDS.newEstimate}
          </ButtonLink>
          <ButtonLink
            href={`/app/w/${workspaceId}/money/invoices/new?person=${person.id}`}
            variant="ghost"
            size="sm"
            className="-ml-2.5 self-start"
            data-testid="context-new-invoice"
          >
            <Receipt className="h-3.5 w-3.5" strokeWidth={1.75} />
            {CONTACT_EDIT_WORDS.newInvoice}
          </ButtonLink>
        </section>
      ) : null}

      {extra}

      <AppointmentDialog
        workspaceId={workspaceId}
        timeZone={data.timezone}
        open={booking}
        onOpenChange={setBooking}
        people={members.map((m) => ({ userId: m.id, fullName: m.fullName }))}
        myUserId={myUserId}
        // Locked: this panel is about this customer, and a picker here would let somebody book a visit for
        // the wrong person while reading someone else's conversation.
        prefill={{ person: { id: person.id, fullName: person.fullName } }}
        lockCustomer
        onBooked={() => {
          setBooking(false);
          router.refresh();
        }}
      />
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
      {lead ? (
        <NextActionDialog
          workspaceId={workspaceId}
          leadId={lead.id}
          leadTitle={lead.title}
          open={nextAction}
          onOpenChange={setNextAction}
          current={{ text: lead.nextAction, at: lead.nextActionAt }}
          onSaved={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}
