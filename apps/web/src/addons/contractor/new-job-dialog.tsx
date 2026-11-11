'use client';
/**
 * New job (docs/contractor.md, "Jobs"): a service call or a project (the owner's decision 2), for a customer at one
 * of their properties or a new address (decision 3), with its trade, lead, start day, deadline and the work to do.
 * A project starts with the business's starter phases, which can be changed on its page.
 */
import type { JobKind } from '@hfos/core/addons/contractor/progress';
import {
  phasesForNewProject,
  TRADE_NAMES,
  TRADES,
  type Trade,
} from '@hfos/core/addons/contractor/trades';
import { CONTRACTOR_WORDS, JOB_KIND_WORDS } from '@hfos/core/addons/contractor/words';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CustomerPicker, type PickedCustomer } from '@/components/calendar/customer-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { jobHref } from './bits';
import { PropertyPicker, propertyInput, type PickedProperty } from './property-picker';
import type { Overview } from './types';
import { useAct } from './use-act';

const W = CONTRACTOR_WORDS.newJob;

export function NewJobDialog({
  open,
  onOpenChange,
  workspaceId,
  overview,
  myUserId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  overview: Overview;
  myUserId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={W.title}
        className="max-h-[92dvh] w-[min(600px,calc(100vw-32px))] overflow-y-auto"
      >
        {open ? (
          <NewJobForm
            workspaceId={workspaceId}
            overview={overview}
            myUserId={myUserId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NewJobForm({
  workspaceId,
  overview,
  myUserId,
  onClose,
}: {
  workspaceId: string;
  overview: Overview;
  myUserId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const trades: readonly Trade[] = overview.settings.trades.length
    ? overview.settings.trades
    : TRADES;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<JobKind>('service');
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [property, setProperty] = useState<PickedProperty | null>(null);
  const [trade, setTrade] = useState<Trade | ''>(
    overview.settings.trades.length === 1 ? overview.settings.trades[0]! : '',
  );
  const [lead, setLead] = useState(myUserId);
  const [startsOn, setStartsOn] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [details, setDetails] = useState('');
  const { busy, errors, act } = useAct();
  const starters = phasesForNewProject(overview.settings, trade || null);
  const people = overview.people;
  return (
    <form
      className="mt-4 space-y-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          'open',
          async () => {
            const out = unwrap(
              await apiBrowser().POST('/v1/commands/contractor.job.open', {
                body: {
                  workspaceId,
                  name: name.trim(),
                  kind,
                  ...(customer ? { customerPersonId: customer.id } : {}),
                  ...propertyInput(property),
                  ...(trade ? { trade } : {}),
                  leadUserId: lead || null,
                  ...(startsOn ? { startsOn } : {}),
                  ...(dueOn ? { dueOn } : {}),
                  ...(details.trim() ? { details: details.trim() } : {}),
                },
              }),
            );
            onClose();
            router.push(jobHref(workspaceId, out.jobId));
          },
          W.created(name.trim()),
        );
      }}
    >
      <Field label={W.name} htmlFor="job-name" error={errors.name}>
        <Input
          id="job-name"
          value={name}
          autoFocus
          maxLength={200}
          placeholder={W.namePlaceholder}
          onChange={(e) => setName(e.target.value)}
          data-testid="job-name"
        />
      </Field>
      <Field label={W.kind} htmlFor="job-kind" hint={W.kindHints[kind]}>
        <div id="job-kind">
          <Segmented<JobKind>
            value={kind}
            onChange={setKind}
            ariaLabel={W.kind}
            options={[
              { value: 'service', label: JOB_KIND_WORDS.service, testId: 'job-kind-service' },
              { value: 'project', label: JOB_KIND_WORDS.project, testId: 'job-kind-project' },
            ]}
          />
        </div>
      </Field>
      <Field label={W.customer} htmlFor="job-customer" error={errors.customerPersonId}>
        <CustomerPicker
          id="job-customer"
          workspaceId={workspaceId}
          value={customer}
          onChange={setCustomer}
        />
      </Field>
      <Field
        label={W.property}
        htmlFor="job-property"
        error={errors.propertyId ?? errors.newPropertyAddress}
        hint={
          property?.kind === 'new'
            ? 'It’s added to your properties, tied to the customer.'
            : 'Search your properties by address, or type a new one.'
        }
      >
        <PropertyPicker
          id="job-property"
          workspaceId={workspaceId}
          value={property}
          onChange={setProperty}
          customerPersonId={customer?.id ?? null}
          placeholder={W.propertyPlaceholder}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={W.trade} htmlFor="job-trade" error={errors.trade}>
          <Select
            id="job-trade"
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
          htmlFor="job-lead"
          error={errors.leadUserId}
          hint={
            overview.may.assign ? undefined : 'An owner or admin can put someone else in charge.'
          }
        >
          <Select
            id="job-lead"
            value={lead}
            disabled={!overview.may.assign}
            onChange={(e) => setLead(e.target.value)}
          >
            <option value="">Nobody yet</option>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.userId === myUserId ? `${p.name} (me)` : p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={W.startsOn} htmlFor="job-starts" error={errors.startsOn}>
          <Input
            id="job-starts"
            type="date"
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
          />
        </Field>
        <Field label={W.dueOn} htmlFor="job-due" error={errors.dueOn}>
          <Input
            id="job-due"
            type="date"
            value={dueOn}
            min={startsOn || undefined}
            onChange={(e) => setDueOn(e.target.value)}
          />
        </Field>
      </div>
      <Field label={W.details} htmlFor="job-details" error={errors.details}>
        <Textarea
          id="job-details"
          value={details}
          maxLength={4000}
          placeholder={W.detailsPlaceholder}
          onChange={(e) => setDetails(e.target.value)}
          className="min-h-[84px]"
        />
      </Field>
      {kind === 'project' ? (
        <p
          className="rounded-card bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2"
          data-testid="job-starters"
        >
          It starts with {starters.length} phases: {starters.join(', ')}. You can change them on the
          project’s page.
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          loading={busy === 'open'}
          disabled={!name.trim()}
          data-testid="job-create"
        >
          {W.create}
        </Button>
      </div>
    </form>
  );
}
