'use client';
/**
 * A visit's work order (docs/contractor.md, "Crews and work orders"): when it is and where it stands, what to do and
 * what to bring, the job's materials it needs, the crew and the people going, its subcontractors (texted the job's
 * details, and marked done by the office), its checklist of boxes to tick and photos to add, and the notes the crew
 * left on it from the field. The job can't be marked Done while a required item is left (the owner's decision 8).
 *
 * Who on the team is going is the visit's own people (core's): picking a crew changes them through core, with its
 * warnings when someone isn't free. A done or cancelled job's work orders are read-only, as the job is.
 */
import { LIMITS } from '@hfos/core/addons/contractor/schemas';
import { ITEM_KINDS, type ItemKind } from '@hfos/core/addons/contractor/checklists';
import {
  CONTRACTOR_WORDS,
  ITEM_KIND_WORDS,
  JOB_STATUS_WORDS,
  namesWords,
} from '@hfos/core/addons/contractor/words';
import { ATTACHMENT_TYPES, formatDate } from '@hfos/core';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  MessageSquare,
  MoreHorizontal,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CustomerPicker } from '@/components/calendar/customer-picker';
import { uploadFile } from '@/components/files/upload-zone';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { ChecklistLine, jobHref, jobRecordHref, StageBadge, StatusBadge } from './bits';
import { ConfirmDialog } from './job-dialogs';
import { MaterialsCard, type MaterialProduct } from './materials-card';
import { FieldNotesCard } from './notes-card';
import { TimeCard } from './time-card';
import type {
  ChecklistItem,
  Crew,
  NoteList,
  Teammate,
  TimeList,
  VisitSub,
  WorkOrder,
} from './types';
import { useAct } from './use-act';

const W = CONTRACTOR_WORDS.workOrder;
const PHOTO_TYPES = ATTACHMENT_TYPES.filter((t) => t.startsWith('image/')).join(',');

export function WorkOrderPage({
  workspaceId,
  order,
  crews,
  time,
  notes,
  people,
  products,
  myUserId,
  timeZone,
}: {
  workspaceId: string;
  order: WorkOrder;
  /** The business's crews in use, to put one on the visit. */
  crews: readonly Crew[];
  /** The time tracked on this visit: never with what it cost. */
  time: TimeList;
  /** The notes the crew left on this visit, the newest first. */
  notes: NoteList;
  /** The people time can be added for, by someone who may fix time. */
  people: readonly Teammate[];
  /** The price list to pick a material from; empty for someone who can't see it. */
  products: readonly MaterialProduct[];
  myUserId: string;
  timeZone: string;
}) {
  // Time that starts or stops, and a note from the field, arrive as the add-on's own news about the job's record.
  useLiveRefresh(['custom_record', 'appointment']);
  const { busy, act } = useAct();
  const { job, visit } = order;
  const jobClosed = job.status === 'done' || job.status === 'cancelled';
  const cancelled = visit.status === 'cancelled';
  const readOnly = jobClosed || cancelled;
  return (
    <div data-testid="contractor-work-order">
      <Link
        href={jobHref(workspaceId, job.id)}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-text-2 hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" />
        {job.name}
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
            {W.title}: {formatDate(visit.startsAt, { time: true, timeZone })}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-text-2">
            <StageBadge stage={visit.stage} />
            <span className="truncate">{visit.title}</span>
            {order.started ? <ChecklistLine checklist={order.progress} /> : null}
          </div>
        </div>
        <ButtonLink
          href={`/app/w/${workspaceId}/calendar?appt=${order.appointmentId}`}
          variant="secondary"
        >
          {W.openInCalendar}
        </ButtonLink>
      </div>

      {readOnly ? (
        <p
          className="mb-4 rounded-card bg-card-2 px-4 py-3 text-[13.5px] text-text-2"
          data-testid="work-order-read-only"
        >
          {cancelled ? W.cancelled : W.closed(JOB_STATUS_WORDS[job.status])}
        </p>
      ) : !order.started ? (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-dashed border-border-strong px-4 py-3 text-[13.5px]"
          data-testid="work-order-not-started"
        >
          <span>
            <span className="font-medium">{W.notStarted}</span>{' '}
            <span className="text-text-2">{W.startHint}</span>
          </span>
          <Button
            size="sm"
            loading={busy === 'start'}
            onClick={() =>
              void act(
                'start',
                async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/contractor.work_order.start', {
                      body: { workspaceId, appointmentId: order.appointmentId },
                    }),
                  ),
                W.started,
              )
            }
            data-testid="work-order-start"
          >
            {W.start}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Card className="p-0" data-testid="work-order-job">
            <div className="border-b border-border px-5 py-3.5">
              <h2 className="text-[15px] font-semibold">{W.job}</h2>
            </div>
            <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[13.5px] sm:grid-cols-2">
              <Fact label={W.job}>
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={jobHref(workspaceId, job.id)} className="font-medium hover:underline">
                    {job.name}
                  </Link>
                  <StatusBadge status={job.status} />
                </span>
              </Fact>
              <Fact label={CONTRACTOR_WORDS.job.customer}>
                {job.customer ? (
                  <Link
                    href={`/app/w/${workspaceId}/customers/people/${job.customer.personId}`}
                    className="font-medium hover:underline"
                  >
                    {job.customer.name}
                  </Link>
                ) : (
                  <span className="text-text-3">{CONTRACTOR_WORDS.job.noCustomer}</span>
                )}
              </Fact>
              <Fact label={CONTRACTOR_WORDS.job.property}>
                {job.property ? (
                  <Link
                    href={`/app/w/${workspaceId}/customers/records/${job.property.recordId}`}
                    className="font-medium hover:underline"
                  >
                    {job.property.name}
                  </Link>
                ) : (
                  <span className="text-text-3">{CONTRACTOR_WORDS.job.noProperty}</span>
                )}
              </Fact>
              <div className="sm:col-span-2">
                <dt className="text-[12px] font-medium uppercase tracking-wide text-text-3">
                  {W.workToDo}
                </dt>
                <dd className="mt-1 whitespace-pre-wrap">
                  {job.details || (
                    <span className="text-text-3">{CONTRACTOR_WORDS.job.noDetails}</span>
                  )}
                </dd>
              </div>
            </dl>
          </Card>
          <NotesCard workspaceId={workspaceId} order={order} readOnly={readOnly} />
          <MaterialsCard
            workspaceId={workspaceId}
            jobId={job.id}
            materials={order.materials}
            visits={[
              {
                appointmentId: order.appointmentId,
                label: formatDate(visit.startsAt, { time: true, timeZone }),
              },
            ]}
            products={products}
            // A work order never carries costs: they're on the job's page, for people who may see them.
            mayCost={false}
            readOnly={readOnly}
            forVisit={order.appointmentId}
          />
          <TimeCard
            workspaceId={workspaceId}
            jobId={job.id}
            time={time}
            visits={[
              {
                appointmentId: order.appointmentId,
                label: formatDate(visit.startsAt, { time: true, timeZone }),
              },
            ]}
            people={people}
            timeZone={timeZone}
            forVisit={order.appointmentId}
          />
          <ChecklistCard workspaceId={workspaceId} order={order} readOnly={readOnly} />
          <FieldNotesCard
            workspaceId={workspaceId}
            jobId={job.id}
            notes={notes}
            visits={[]}
            myUserId={myUserId}
            timeZone={timeZone}
            forVisit={order.appointmentId}
          />
        </div>
        <div className="space-y-4">
          <CrewCard workspaceId={workspaceId} order={order} crews={crews} readOnly={readOnly} />
          <SubsCard workspaceId={workspaceId} order={order} readOnly={readOnly} />
        </div>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-medium uppercase tracking-wide text-text-3">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

type Part = { workspaceId: string; order: WorkOrder; readOnly: boolean };

/** What to do on this visit, and what to bring. */
function NotesCard({ workspaceId, order, readOnly }: Part) {
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState(order.instructions ?? '');
  const [bring, setBring] = useState(order.bring ?? '');
  const { busy, errors, act } = useAct(() => setEditing(false));
  const open = () => {
    setInstructions(order.instructions ?? '');
    setBring(order.bring ?? '');
    setEditing(true);
  };
  return (
    <Card className="p-0" data-testid="work-order-notes">
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h2 className="text-[15px] font-semibold">{W.instructions}</h2>
        {readOnly || editing ? null : (
          <Button size="sm" variant="ghost" onClick={open} data-testid="work-order-edit">
            {W.edit}
          </Button>
        )}
      </div>
      {editing ? (
        <form
          className="space-y-4 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'save',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/contractor.work_order.update', {
                    body: {
                      workspaceId,
                      appointmentId: order.appointmentId,
                      instructions: instructions.trim() || null,
                      bring: bring.trim() || null,
                    },
                  }),
                ),
              W.saved,
            );
          }}
        >
          <Field label={W.instructions} htmlFor="wo-instructions" error={errors.instructions}>
            <Textarea
              id="wo-instructions"
              value={instructions}
              maxLength={LIMITS.instructions}
              placeholder={W.instructionsPlaceholder}
              onChange={(e) => setInstructions(e.target.value)}
              className="min-h-[110px]"
              data-testid="work-order-instructions"
            />
          </Field>
          <Field label={W.bring} htmlFor="wo-bring" error={errors.bring}>
            <Textarea
              id="wo-bring"
              value={bring}
              maxLength={LIMITS.bring}
              placeholder={W.bringPlaceholder}
              onChange={(e) => setBring(e.target.value)}
              className="min-h-[72px]"
              data-testid="work-order-bring"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {W.cancel}
            </Button>
            <Button type="submit" loading={busy === 'save'} data-testid="work-order-save">
              {W.save}
            </Button>
          </div>
        </form>
      ) : (
        <dl className="space-y-4 px-5 py-4 text-[13.5px]">
          <div>
            <dd className="whitespace-pre-wrap">
              {order.instructions || <span className="text-text-3">{W.noInstructions}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-[12px] font-medium uppercase tracking-wide text-text-3">
              {W.bring}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap">
              {order.bring || <span className="text-text-3">{W.noBring}</span>}
            </dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

/** The visit's checklist: boxes to tick and photos to add, some of them required. */
function ChecklistCard({ workspaceId, order, readOnly }: Part) {
  const { busy, errors, act } = useAct();
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<ItemKind>('check');
  const [required, setRequired] = useState(false);
  const [removing, setRemoving] = useState<ChecklistItem | null>(null);
  const full = order.items.length >= LIMITS.checklist;
  const add = () => {
    const words = label.trim();
    if (!words) return;
    void act('add', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/contractor.work_order.item_add', {
          body: { workspaceId, appointmentId: order.appointmentId, label: words, kind, required },
        }),
      );
      setLabel('');
      setRequired(false);
    });
  };
  return (
    <Card className="p-0" data-testid="work-order-checklist">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <h2 className="text-[15px] font-semibold">{W.checklist}</h2>
        {order.items.length ? (
          <span
            className={cn(
              'text-[12.5px]',
              order.progress.requiredLeft ? 'text-danger-text' : 'text-text-2',
            )}
            data-testid="checklist-progress"
          >
            {order.progress.requiredLeft ? W.left(order.progress.requiredLeft) : W.ready}
          </span>
        ) : null}
      </div>
      {order.items.length === 0 ? (
        <p className="px-5 py-4 text-[13.5px] text-text-2">{W.checklistNone}</p>
      ) : (
        <ul>
          {order.items.map((item) => (
            <ItemRow
              key={item.id}
              workspaceId={workspaceId}
              order={order}
              item={item}
              readOnly={readOnly}
              onRemove={() => setRemoving(item)}
            />
          ))}
        </ul>
      )}
      {readOnly || full ? null : (
        <div className="border-t border-border px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={label}
              inputSize="sm"
              className="min-w-[180px] flex-1"
              maxLength={LIMITS.itemLabel}
              placeholder={W.addItemPlaceholder}
              aria-label={W.addItem}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
              data-testid="checklist-new-label"
            />
            <Select
              selectSize="sm"
              className="w-[120px]"
              value={kind}
              aria-label={W.itemKind}
              onChange={(e) => setKind(e.target.value as ItemKind)}
              data-testid="checklist-new-kind"
            >
              {ITEM_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ITEM_KIND_WORDS[k]}
                </option>
              ))}
            </Select>
            <Checkbox
              label={W.required}
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
              data-testid="checklist-new-required"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!label.trim()}
              loading={busy === 'add'}
              onClick={add}
              data-testid="checklist-add"
            >
              {W.addItem}
            </Button>
          </div>
          <p className="mt-2 text-[12.5px] text-text-3">{W.requiredHint}</p>
          {errors.label ? (
            <p className="mt-1 text-[13px] text-danger-text">{errors.label}</p>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={W.removeItem}
        description={removing ? W.removeItemAsk(removing.label) : ''}
        submit={W.removeItem}
        done={removing ? W.itemRemoved(removing.label) : ''}
        run={async () =>
          removing &&
          unwrap(
            await apiBrowser().POST('/v1/commands/contractor.work_order.item_remove', {
              body: { workspaceId, itemId: removing.id },
            }),
          )
        }
      />
    </Card>
  );
}

function ItemRow({
  workspaceId,
  order,
  item,
  readOnly,
  onRemove,
}: Part & { item: ChecklistItem; onRemove: () => void }) {
  const { busy, act } = useAct();
  const picker = useRef<HTMLInputElement>(null);
  const set = (done: boolean, fileId?: string) =>
    apiBrowser()
      .POST('/v1/commands/contractor.work_order.item_set', {
        body: { workspaceId, itemId: item.id, done, ...(fileId ? { fileId } : {}) },
      })
      .then(unwrap);
  const update = (change: { required?: boolean }) =>
    act('update', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/contractor.work_order.item_update', {
          body: { workspaceId, itemId: item.id, ...change },
        }),
      ),
    );
  const working = busy !== null;
  return (
    <li
      className="flex items-start gap-3 border-b border-border px-5 py-3 text-[13.5px] last:border-b-0"
      data-testid="checklist-item"
      data-done={item.done}
    >
      {item.kind === 'check' ? (
        <input
          type="checkbox"
          className="mt-0.5 h-[18px] w-[18px] flex-none cursor-pointer rounded-[5px] border border-border-strong accent-accent disabled:cursor-not-allowed"
          checked={item.done}
          disabled={readOnly || working}
          aria-label={item.done ? W.untick(item.label) : W.tick(item.label)}
          onChange={(e) => void act('set', () => set(e.target.checked))}
          data-testid="checklist-tick"
        />
      ) : (
        <span
          className={cn(
            'mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border',
            item.done
              ? 'border-transparent bg-success-soft text-success-text'
              : 'border-border-strong text-text-3',
          )}
          aria-hidden
        >
          {item.done ? <Check className="h-3 w-3" /> : <Camera className="h-3 w-3" />}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn(item.done && 'text-text-2')}>{item.label}</span>
          {item.required ? (
            <Badge variant={item.done ? 'gray' : 'pending'}>{W.required}</Badge>
          ) : null}
        </div>
        {item.done ? (
          <div className="mt-0.5 text-[12.5px] text-text-3">{W.doneBy(item.doneBy)}</div>
        ) : item.skipped ? (
          <div className="mt-0.5 text-[12.5px] text-warning-text" data-testid="checklist-skipped">
            {W.skipped(item.skipped.by, item.skipped.reason)}
          </div>
        ) : null}
        {item.kind === 'photo' ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {item.file ? (
              <Link
                href={`${jobRecordHref(workspaceId, order.job.id)}?file=${item.file.id}`}
                className="text-[13px] font-medium text-accent-text hover:underline"
                data-testid="checklist-photo"
              >
                {W.seePhoto}
              </Link>
            ) : null}
            {readOnly ? null : (
              <>
                <input
                  ref={picker}
                  type="file"
                  accept={PHOTO_TYPES}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    void act(
                      'photo',
                      async () =>
                        set(
                          true,
                          await uploadFile(workspaceId, 'custom_record', order.job.id, file),
                        ),
                      W.photoAdded,
                    );
                  }}
                  data-testid="checklist-photo-file"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'photo'}
                  disabled={working}
                  onClick={() => picker.current?.click()}
                  data-testid="checklist-add-photo"
                >
                  <Camera className="h-3.5 w-3.5" />
                  {busy === 'photo' ? W.uploading : item.file ? W.replacePhoto : W.addPhoto}
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
      {readOnly ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded p-1 text-text-3 hover:bg-card-2 hover:text-text"
              aria-label={W.itemMenu(item.label)}
              data-testid="checklist-item-menu"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => void update({ required: !item.required })}>
              {item.required ? W.makeOptional : W.makeRequired}
            </DropdownMenuItem>
            {item.kind === 'photo' && item.done ? (
              <DropdownMenuItem onSelect={() => void act('set', () => set(false))}>
                {W.untick(item.label)}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem danger onSelect={onRemove}>
              {W.removeItem}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

interface Warning {
  readonly message: string;
}

/** The crew on the visit, and the people on the business's team going. */
function CrewCard({ workspaceId, order, readOnly, crews }: Part & { crews: readonly Crew[] }) {
  const { busy, act } = useAct();
  /** The crew someone in which isn't free then, and why: asked before they're put on anyway. */
  const [held, setHeld] = useState<{ crew: Crew; warnings: readonly Warning[] } | null>(null);
  // An archived crew that's still on this visit keeps its name in the list.
  const options =
    order.crew && !crews.some((c) => c.id === order.crew!.id)
      ? [{ id: order.crew.id, name: order.crew.name }, ...crews]
      : crews;
  const put = (crewId: string | null, anyway = false) =>
    apiBrowser()
      .POST('/v1/commands/contractor.work_order.set_crew', {
        body: {
          workspaceId,
          appointmentId: order.appointmentId,
          crewId,
          acknowledgeWarnings: anyway,
        },
      })
      .then(unwrap);
  const pick = (crewId: string) => {
    if (!crewId) return void act('crew', () => put(null), W.crewCleared);
    const crew = crews.find((c) => c.id === crewId);
    if (!crew) return;
    void act(
      'crew',
      async () => {
        try {
          await put(crew.id);
        } catch (e) {
          if (!(e instanceof ApiError) || e.rule !== 'needs_confirmation') throw e;
          setHeld({
            crew,
            warnings: (e.details as { warnings?: Warning[] } | undefined)?.warnings ?? [],
          });
          return;
        }
        toast.success(W.crewSet(crew.name));
      },
      undefined,
    );
  };
  return (
    <Card className="p-5" data-testid="work-order-crew">
      <h2 className="text-[15px] font-semibold">{W.whoGoes}</h2>
      <div className="mt-3">
        <label
          className="text-[12px] font-medium uppercase tracking-wide text-text-3"
          htmlFor="wo-crew"
        >
          {W.crew}
        </label>
        <Select
          id="wo-crew"
          selectSize="sm"
          className="mt-1"
          value={order.crew?.id ?? ''}
          disabled={readOnly || busy !== null || (!options.length && !order.crew)}
          onChange={(e) => pick(e.target.value)}
          data-testid="work-order-crew-pick"
        >
          <option value="">{W.noCrew}</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {readOnly ? null : (
          <p className="mt-1.5 text-[12.5px] text-text-3">
            {options.length ? W.crewHint : CONTRACTOR_WORDS.crews.none}
          </p>
        )}
      </div>
      <div className="mt-4 text-[12px] font-medium uppercase tracking-wide text-text-3">
        {W.people}
      </div>
      <ul className="mt-1 space-y-1 text-[13.5px]" data-testid="work-order-people">
        {order.people.length === 0 ? <li className="text-text-3">{W.peopleNone}</li> : null}
        {order.people.map((p) => (
          <li key={p.userId}>{p.name}</li>
        ))}
      </ul>
      <Dialog open={held !== null} onOpenChange={(o) => !o && setHeld(null)}>
        <DialogContent title={W.crewAnywayTitle} description={held?.crew.name}>
          <div className="mt-3 flex flex-col gap-2" data-testid="crew-warnings">
            {(held?.warnings ?? []).map((w, i) => (
              <div
                key={i}
                className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3 py-2.5 text-[13px] text-warning-text"
              >
                <AlertTriangle className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
                <span>{w.message}</span>
              </div>
            ))}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setHeld(null)}>
              {W.cancel}
            </Button>
            <Button
              loading={busy === 'anyway'}
              onClick={() => {
                const crew = held?.crew;
                if (!crew) return;
                void act(
                  'anyway',
                  async () => {
                    await put(crew.id, true);
                    setHeld(null);
                  },
                  W.crewSet(crew.name),
                );
              }}
              data-testid="crew-anyway"
            >
              {W.crewAnyway}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** The visit's subcontractors: contacts who don't sign in, texted the job's details and marked done by the office. */
function SubsCard({ workspaceId, order, readOnly }: Part) {
  const { busy, act } = useAct();
  /** Who the text is for: everyone on the visit, or one of them. */
  const [telling, setTelling] = useState<readonly VisitSub[] | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const body = (personId: string) => ({
    workspaceId,
    appointmentId: order.appointmentId,
    personId,
  });
  const canTell = order.subs.filter((s) => s.canText);
  return (
    <Card className="p-5" data-testid="work-order-subs">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">{W.subs}</h2>
        {!readOnly && canTell.length > 1 ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setTelling(canTell)}
            data-testid="subs-tell-all"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {W.tellSubs}
          </Button>
        ) : null}
      </div>
      <p className="mt-0.5 text-[12.5px] text-text-3">{W.subsHint}</p>
      <ul className="mt-3 space-y-3 text-[13.5px]">
        {order.subs.length === 0 ? <li className="text-text-3">{W.subsNone}</li> : null}
        {order.subs.map((s) => (
          <li key={s.personId} data-testid="work-order-sub">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <Link
                  href={`/app/w/${workspaceId}/customers/people/${s.personId}`}
                  className="font-medium hover:underline"
                >
                  {s.name}
                </Link>
                {s.company ? <span className="text-text-3"> · {s.company}</span> : null}
                <span className="block text-[12.5px] text-text-3">
                  {!s.canText
                    ? W.noMobile
                    : s.toldAt
                      ? `${W.toldAt} ${formatDate(s.toldAt, { time: true })}`
                      : W.notTold}
                </span>
              </span>
              {readOnly ? (
                s.done ? (
                  <Badge variant="ok">{W.subWorkDone}</Badge>
                ) : null
              ) : (
                <button
                  type="button"
                  className="rounded p-1 text-text-3 hover:bg-card-2 hover:text-text disabled:opacity-40"
                  aria-label={`${W.removeSub}: ${s.name}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      `off:${s.personId}`,
                      async () =>
                        unwrap(
                          await apiBrowser().POST('/v1/commands/contractor.work_order.sub_remove', {
                            body: body(s.personId),
                          }),
                        ),
                      W.subRemoved(s.name),
                    )
                  }
                  data-testid="sub-remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {readOnly ? null : (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <Checkbox
                  label={<span className="text-[13px]">{W.subWorkDone}</span>}
                  checked={s.done}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const done = e.target.checked;
                    void act(
                      `done:${s.personId}`,
                      async () =>
                        unwrap(
                          await apiBrowser().POST('/v1/commands/contractor.work_order.sub_set', {
                            body: { ...body(s.personId), done },
                          }),
                        ),
                      done ? W.subDoneSaved(s.name) : W.subUndone(s.name),
                    );
                  }}
                  data-testid="sub-done"
                />
                {s.canText ? (
                  <button
                    type="button"
                    className="text-[13px] font-medium text-accent-text hover:underline"
                    onClick={() => setTelling([s])}
                    data-testid="sub-tell"
                  >
                    {W.tellOne}
                  </button>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
      {readOnly || order.subs.length >= LIMITS.subs ? null : (
        <div className="mt-3">
          <div className="mb-1 text-[12.5px] font-medium text-text-2">{W.addSub}</div>
          <CustomerPicker
            key={pickerKey}
            workspaceId={workspaceId}
            value={null}
            onChange={(picked) => {
              if (!picked) return;
              setPickerKey((k) => k + 1);
              void act(
                'add',
                async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/contractor.work_order.sub_add', {
                      body: body(picked.id),
                    }),
                  ),
                W.subAdded(picked.fullName),
              );
            }}
          />
        </div>
      )}
      {telling ? (
        <TellDialog
          workspaceId={workspaceId}
          appointmentId={order.appointmentId}
          subs={telling}
          everyone={telling.length === order.subs.length}
          onClose={() => setTelling(null)}
        />
      ) : null}
    </Card>
  );
}

/** Texting subcontractors the job's details, with a line of your own. The server says who couldn't be, and why. */
function TellDialog({
  workspaceId,
  appointmentId,
  subs,
  everyone,
  onClose,
}: {
  workspaceId: string;
  appointmentId: string;
  subs: readonly VisitSub[];
  everyone: boolean;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Said once, in quiet hours: the next press sends anyway. */
  const [quiet, setQuiet] = useState(false);
  const [missed, setMissed] = useState<readonly { name: string; why: string }[] | null>(null);
  const { act } = useAct();
  async function send() {
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/contractor.work_order.tell_subs', {
          body: {
            workspaceId,
            appointmentId,
            ...(everyone ? {} : { personIds: subs.map((s) => s.personId) }),
            ...(note.trim() ? { note: note.trim() } : {}),
            acknowledgeQuietHours: quiet,
          },
        }),
      );
      if (out.told.length) toast.success(W.told(namesWords(out.told.map((t) => t.name))));
      // Draws the page again, so who was texted shows.
      void act('told', async () => undefined);
      if (out.notTold.length) setMissed(out.notTold);
      else onClose();
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'quiet_hours' && !quiet) {
        setQuiet(true);
        setError(`${e.message} ${W.quietAgain}`);
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={missed ? W.notToldTitle : subs.length === 1 ? W.tellOne : W.tellSubs}
        description={missed ? undefined : namesWords(subs.map((s) => s.name))}
      >
        {missed ? (
          <>
            <ul className="mt-3 space-y-2 text-[13.5px]" data-testid="subs-not-told">
              {missed.map((m) => (
                <li
                  key={m.name}
                  className="rounded-menu bg-warning-soft px-3 py-2.5 text-warning-text"
                >
                  {m.why}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end">
              <Button onClick={onClose}>{CONTRACTOR_WORDS.job.notReady.close}</Button>
            </div>
          </>
        ) : (
          <form
            className="mt-3 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Field label={W.tellNote} htmlFor="wo-tell-note" error={error}>
              <Textarea
                id="wo-tell-note"
                value={note}
                maxLength={300}
                placeholder={W.tellNotePlaceholder}
                onChange={(e) => setNote(e.target.value)}
                className="min-h-[72px]"
                data-testid="subs-tell-note"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {W.cancel}
              </Button>
              <Button type="submit" loading={busy} data-testid="subs-tell-send">
                {W.tellSend}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
