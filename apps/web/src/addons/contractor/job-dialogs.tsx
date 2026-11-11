'use client';
/**
 * The job page's dialogs: why a job is on hold or cancelled, changing its details, its budget and price, a phase's
 * name and dates, and asking before something goes. Each runs one of the add-on's commands; refusals say what to do
 * in their own words.
 */
import { TRADE_NAMES, TRADES, type Trade } from '@hfos/core/addons/contractor/trades';
import { CONTRACTOR_WORDS } from '@hfos/core/addons/contractor/words';
import { money, parseMoney } from '@hfos/core';
import { useCallback, useState, type ReactNode } from 'react';
import { CustomerPicker, type PickedCustomer } from '@/components/calendar/customer-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { PropertyPicker, type PickedProperty } from './property-picker';
import type { JobDetail, JobMoney, JobPhase, Overview } from './types';
import { useAct } from './use-act';

const J = CONTRACTOR_WORDS.job;

type Open = { open: boolean; onOpenChange: (open: boolean) => void };

function Foot({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}

/** A move that needs words: on hold or cancelled, and why. */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  submit,
  danger,
  run,
  done,
}: Open & {
  title: string;
  description?: ReactNode;
  placeholder?: string;
  submit: string;
  danger?: boolean;
  run: (reason: string) => Promise<unknown>;
  done: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        {open ? (
          <ReasonForm
            placeholder={placeholder}
            submit={submit}
            danger={danger}
            run={run}
            done={done}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  placeholder,
  submit,
  danger,
  run,
  done,
  onClose,
}: {
  placeholder?: string;
  submit: string;
  danger?: boolean;
  run: (reason: string) => Promise<unknown>;
  done: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const { busy, errors, act } = useAct(onClose);
  return (
    <form
      className="mt-3 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void act('go', () => run(reason.trim()), done);
      }}
    >
      <Field label={J.reason} htmlFor="job-reason" error={errors.reason}>
        <Textarea
          id="job-reason"
          value={reason}
          autoFocus
          maxLength={300}
          placeholder={placeholder}
          onChange={(e) => setReason(e.target.value)}
          className="min-h-[72px]"
          data-testid="job-reason"
        />
      </Field>
      <Foot>
        <Button variant="ghost" onClick={onClose}>
          {J.cancel}
        </Button>
        <Button
          type="submit"
          variant={danger ? 'danger' : 'primary'}
          loading={busy === 'go'}
          disabled={!reason.trim()}
          data-testid="job-reason-submit"
        >
          {submit}
        </Button>
      </Foot>
    </form>
  );
}

/** Asking before something goes (a phase). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  submit,
  run,
  done,
}: Open & {
  title: string;
  description: ReactNode;
  submit: string;
  run: () => Promise<unknown>;
  done: string;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <Foot>
          <Button variant="ghost" onClick={close}>
            {J.cancel}
          </Button>
          <Button
            variant="danger"
            loading={busy === 'go'}
            onClick={() => void act('go', run, done)}
            data-testid="confirm-submit"
          >
            {submit}
          </Button>
        </Foot>
      </DialogContent>
    </Dialog>
  );
}

/** Changing a job: its name, trade, dates, lead, customer, property and the work to do. */
export function EditJobDialog({
  open,
  onOpenChange,
  workspaceId,
  job,
  overview,
  myUserId,
}: Open & { workspaceId: string; job: JobDetail; overview: Overview; myUserId: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`${J.edit} “${job.name}”`}
        className="max-h-[92dvh] w-[min(600px,calc(100vw-32px))] overflow-y-auto"
      >
        {open ? (
          <EditJobForm
            workspaceId={workspaceId}
            job={job}
            overview={overview}
            myUserId={myUserId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EditJobForm({
  workspaceId,
  job,
  overview,
  myUserId,
  onClose,
}: {
  workspaceId: string;
  job: JobDetail;
  overview: Overview;
  myUserId: string;
  onClose: () => void;
}) {
  const W = CONTRACTOR_WORDS.newJob;
  const trades: readonly Trade[] = overview.settings.trades.length
    ? [...new Set([...overview.settings.trades, ...(job.trade ? [job.trade] : [])])]
    : TRADES;
  const [name, setName] = useState(job.name);
  const [trade, setTrade] = useState<Trade | ''>(job.trade ?? '');
  const [lead, setLead] = useState(job.lead?.userId ?? '');
  const [startsOn, setStartsOn] = useState(job.startsOn ?? '');
  const [dueOn, setDueOn] = useState(job.dueOn ?? '');
  const [details, setDetails] = useState(job.details ?? '');
  const [customer, setCustomer] = useState<PickedCustomer | null>(
    job.customer ? { id: job.customer.personId, fullName: job.customer.name } : null,
  );
  const [property, setProperty] = useState<PickedProperty | null>(
    job.property
      ? { kind: 'existing', propertyId: job.property.recordId, name: job.property.name }
      : null,
  );
  const { busy, errors, act } = useAct(onClose);
  // Only what changed is sent, so a field someone else changed meanwhile isn't put back.
  const changes = () => {
    const body: Record<string, unknown> = {};
    if (name.trim() !== job.name) body.name = name.trim();
    if ((trade || null) !== job.trade) body.trade = trade || null;
    if ((lead || null) !== (job.lead?.userId ?? null)) body.leadUserId = lead || null;
    if ((startsOn || null) !== job.startsOn) body.startsOn = startsOn || null;
    if ((dueOn || null) !== job.dueOn) body.dueOn = dueOn || null;
    if ((details.trim() || null) !== (job.details ?? null)) body.details = details.trim() || null;
    if ((customer?.id ?? null) !== (job.customer?.personId ?? null))
      body.customerPersonId = customer?.id ?? null;
    if (!property) {
      if (job.property) body.propertyId = null;
    } else if (property.kind === 'new') body.newPropertyAddress = property.address;
    else if (property.propertyId !== job.property?.recordId) body.propertyId = property.propertyId;
    return body;
  };
  return (
    <form
      className="mt-4 space-y-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        const body = changes();
        if (!Object.keys(body).length) return onClose();
        void act(
          'save',
          async () =>
            unwrap(
              await apiBrowser().POST('/v1/commands/contractor.job.update', {
                body: { workspaceId, jobId: job.id, ...body },
              }),
            ),
          J.saved,
        );
      }}
    >
      <Field label={W.name} htmlFor="edit-name" error={errors.name}>
        <Input
          id="edit-name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label={W.customer} htmlFor="edit-customer" error={errors.customerPersonId}>
        <CustomerPicker
          id="edit-customer"
          workspaceId={workspaceId}
          value={customer}
          onChange={setCustomer}
        />
      </Field>
      <Field
        label={W.property}
        htmlFor="edit-property"
        error={errors.propertyId ?? errors.newPropertyAddress}
      >
        <PropertyPicker
          id="edit-property"
          workspaceId={workspaceId}
          value={property}
          onChange={setProperty}
          customerPersonId={customer?.id ?? null}
          placeholder={W.propertyPlaceholder}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={W.trade} htmlFor="edit-trade" error={errors.trade}>
          <Select
            id="edit-trade"
            value={trade}
            onChange={(e) => setTrade(e.target.value as Trade | '')}
          >
            <option value="">Not set</option>
            {trades.map((t) => (
              <option key={t} value={t}>
                {TRADE_NAMES[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={W.lead}
          htmlFor="edit-lead"
          error={errors.leadUserId}
          hint={
            overview.may.assign ? undefined : 'An owner or admin can put someone else in charge.'
          }
        >
          <Select
            id="edit-lead"
            value={lead}
            onChange={(e) => setLead(e.target.value)}
            disabled={!overview.may.assign && !!job.lead && job.lead.userId !== myUserId}
          >
            <option value="">Nobody yet</option>
            {overview.people
              .filter(
                (p) =>
                  overview.may.assign || p.userId === myUserId || p.userId === job.lead?.userId,
              )
              .map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.userId === myUserId ? `${p.name} (me)` : p.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={W.startsOn} htmlFor="edit-starts" error={errors.startsOn}>
          <Input
            id="edit-starts"
            type="date"
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
          />
        </Field>
        <Field label={W.dueOn} htmlFor="edit-due" error={errors.dueOn}>
          <Input
            id="edit-due"
            type="date"
            value={dueOn}
            min={startsOn || undefined}
            onChange={(e) => setDueOn(e.target.value)}
          />
        </Field>
      </div>
      <Field label={W.details} htmlFor="edit-details" error={errors.details}>
        <Textarea
          id="edit-details"
          value={details}
          maxLength={4000}
          placeholder={W.detailsPlaceholder}
          onChange={(e) => setDetails(e.target.value)}
          className="min-h-[96px]"
        />
      </Field>
      <Foot>
        <Button variant="ghost" onClick={onClose}>
          {J.cancel}
        </Button>
        <Button
          type="submit"
          loading={busy === 'save'}
          disabled={!name.trim()}
          data-testid="job-save"
        >
          {J.save}
        </Button>
      </Foot>
    </form>
  );
}

const M = J.money;

/** The job's price to the customer and its budget: labor, materials, other costs and labor hours. */
export function MoneyDialog({
  open,
  onOpenChange,
  workspaceId,
  jobId,
  value,
}: Open & { workspaceId: string; jobId: string; value: JobMoney }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={M.edit} description={M.hint}>
        {open ? (
          <MoneyForm
            workspaceId={workspaceId}
            jobId={jobId}
            value={value}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const asDollars = (cents: number | null) => (cents === null ? '' : money(cents).replace('$', ''));

function MoneyForm({
  workspaceId,
  jobId,
  value,
  onClose,
}: {
  workspaceId: string;
  jobId: string;
  value: JobMoney;
  onClose: () => void;
}) {
  const [price, setPrice] = useState(asDollars(value.priceCents));
  const [labor, setLabor] = useState(asDollars(value.laborCents));
  const [materials, setMaterials] = useState(asDollars(value.materialsCents));
  const [other, setOther] = useState(asDollars(value.otherCents));
  const [hours, setHours] = useState(value.laborHours === null ? '' : String(value.laborHours));
  const { busy, errors, setErrors, act } = useAct(onClose);
  const amount = (text: string): number | null | 'bad' => {
    if (!text.trim()) return null;
    const c = parseMoney(text);
    return c === null ? 'bad' : c;
  };
  const fields = [
    { key: 'priceCents', label: M.price, value: price, set: setPrice },
    { key: 'laborCents', label: M.labor, value: labor, set: setLabor },
    { key: 'materialsCents', label: M.materials, value: materials, set: setMaterials },
    { key: 'otherCents', label: M.other, value: other, set: setOther },
  ] as const;
  return (
    <form
      className="mt-4 space-y-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        const body: Record<string, number | null> = {};
        const bad: Record<string, string> = {};
        for (const f of fields) {
          const c = amount(f.value);
          if (c === 'bad') bad[f.key] = 'Type an amount, like 1,250 or 1250.50.';
          else body[f.key] = c;
        }
        const h = hours.trim() ? Number(hours) : null;
        if (h !== null && (!Number.isFinite(h) || h < 0))
          bad.laborHours = 'Type the hours, like 12 or 12.5.';
        else body.laborHours = h;
        if (Object.keys(bad).length) return setErrors(bad);
        void act(
          'save',
          async () =>
            unwrap(
              await apiBrowser().POST('/v1/commands/contractor.job.set_money', {
                body: { workspaceId, jobId, ...body },
              }),
            ),
          M.saved,
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`money-${f.key}`} error={errors[f.key]}>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-3">
                $
              </span>
              <Input
                id={`money-${f.key}`}
                inputMode="decimal"
                value={f.value}
                placeholder={M.notSet}
                className="pl-6"
                onChange={(e) => f.set(e.target.value)}
                data-testid={`money-${f.key}`}
              />
            </div>
          </Field>
        ))}
        <Field label={M.hours} htmlFor="money-hours" error={errors.laborHours}>
          <Input
            id="money-hours"
            inputMode="decimal"
            value={hours}
            placeholder={M.notSet}
            onChange={(e) => setHours(e.target.value)}
          />
        </Field>
      </div>
      <Foot>
        <Button variant="ghost" onClick={onClose}>
          {J.cancel}
        </Button>
        <Button type="submit" loading={busy === 'save'} data-testid="money-save">
          {J.save}
        </Button>
      </Foot>
    </form>
  );
}

/** A phase's name and dates. */
export function PhaseDialog({
  open,
  onOpenChange,
  workspaceId,
  phase,
}: Open & { workspaceId: string; phase: JobPhase | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={phase ? `${J.edit} “${phase.name}”` : J.edit}>
        {open && phase ? (
          <PhaseForm workspaceId={workspaceId} phase={phase} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PhaseForm({
  workspaceId,
  phase,
  onClose,
}: {
  workspaceId: string;
  phase: JobPhase;
  onClose: () => void;
}) {
  const P = J.phases;
  const [name, setName] = useState(phase.name);
  const [startsOn, setStartsOn] = useState(phase.startsOn ?? '');
  const [dueOn, setDueOn] = useState(phase.dueOn ?? '');
  const { busy, errors, act } = useAct(onClose);
  return (
    <form
      className="mt-4 space-y-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          'save',
          async () =>
            unwrap(
              await apiBrowser().POST('/v1/commands/contractor.phase.update', {
                body: {
                  workspaceId,
                  phaseId: phase.id,
                  ...(name.trim() !== phase.name ? { name: name.trim() } : {}),
                  startsOn: startsOn || null,
                  dueOn: dueOn || null,
                },
              }),
            ),
          J.saved,
        );
      }}
    >
      <Field label="Name" htmlFor="phase-name" error={errors.name}>
        <Input
          id="phase-name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={P.startsOn} htmlFor="phase-starts" error={errors.startsOn}>
          <Input
            id="phase-starts"
            type="date"
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
          />
        </Field>
        <Field label={P.dueOn} htmlFor="phase-due" error={errors.dueOn}>
          <Input
            id="phase-due"
            type="date"
            value={dueOn}
            min={startsOn || undefined}
            onChange={(e) => setDueOn(e.target.value)}
          />
        </Field>
      </div>
      <Foot>
        <Button variant="ghost" onClick={onClose}>
          {J.cancel}
        </Button>
        <Button type="submit" loading={busy === 'save'} disabled={!name.trim()}>
          {J.save}
        </Button>
      </Foot>
    </form>
  );
}
