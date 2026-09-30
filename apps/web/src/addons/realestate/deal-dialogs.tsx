'use client';
/**
 * The deal page's dialogs: a reason for a move that needs one, a moment recorded, closing (and the lead won too),
 * a changed wire, the duty list's newest version, a duty written by hand, the team, outside parties, the property and
 * the commission. Each runs one of the add-on's commands; refusals say what to do in their own words.
 */
import { MATERIALITIES } from '@hfos/core/addons/realestate/catalog/types';
import { MATERIALITY_LABELS } from '@hfos/core/addons/realestate/rule-words';
import { RECORDED_EVENTS } from '@hfos/core/addons/realestate/schemas';
import {
  DEAL_ROLE_LABELS,
  EVENT_WORDS,
  PARTY_ROLES,
  PARTY_ROLES_LIST,
  TEAM_ROLES,
  type PartyRole,
} from '@hfos/core/addons/realestate/words';
import { money, parseMoney } from '@hfos/core';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Callout } from '@/components/crm/chips';
import { RecordPicker, type PickedRecord } from '@/components/crm/record-picker';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { DealGet, TemplateDiff, Teammate } from './types';
import { useAct } from './use-act';

type Open = { open: boolean; onOpenChange: (open: boolean) => void };

function Foot({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}

/** A move that needs a reason: terminate, offer lost, end, reopen, archive. */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label = 'Why',
  submit,
  danger,
  children,
  run,
  done,
}: Open & {
  title: string;
  description?: ReactNode;
  label?: string;
  submit: string;
  danger?: boolean;
  children?: ReactNode;
  run: (reason: string) => Promise<unknown>;
  done: string;
}) {
  const [reason, setReason] = useState('');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, errors, act } = useAct(close);
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act('go', () => run(reason.trim()), done);
          }}
        >
          {children}
          <Field label={label} htmlFor="reason" error={errors.reason}>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="min-h-[72px]"
              data-testid="reason-input"
            />
          </Field>
          <Foot>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={danger ? 'danger' : 'primary'}
              loading={busy === 'go'}
              disabled={!reason.trim()}
              data-testid="reason-submit"
            >
              {submit}
            </Button>
          </Foot>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Something happened on the deal that brings its own duties: an offer, the inspection report, an amendment. */
export function MomentDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
}: Open & { workspaceId: string; dealId: string }) {
  const [event, setEvent] = useState<(typeof RECORDED_EVENTS)[number]>('offer_received');
  const [note, setNote] = useState('');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  useEffect(() => {
    if (open) setNote('');
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Record what happened"
        description="The duties that come with it are added, due from when it happened."
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'go',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.deal.record_event', {
                    body: {
                      workspaceId,
                      dealId,
                      event,
                      ...(note.trim() ? { note: note.trim() } : {}),
                    },
                  }),
                ),
              'Recorded.',
            );
          }}
        >
          <Field label="What happened" htmlFor="moment">
            <Select
              id="moment"
              value={event}
              onChange={(e) => setEvent(e.target.value as (typeof RECORDED_EVENTS)[number])}
            >
              {RECORDED_EVENTS.map((ev) => (
                <option key={ev} value={ev}>
                  {EVENT_WORDS[ev][0]!.toUpperCase() + EVENT_WORDS[ev].slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note (optional)" htmlFor="moment-note">
            <Input id="moment-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Foot>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'go'}>
              Record it
            </Button>
          </Foot>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Closing: the deal's closing duties begin, and its Pipeline lead can be marked won in the same step. */
export function CloseDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  hasLead,
}: Open & { workspaceId: string; dealId: string; hasLead: boolean }) {
  const [won, setWon] = useState(true);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Close the deal?"
        description="It moves to closed, and its after-closing duties are added. Anything still open stays open."
      >
        {hasLead ? (
          <div className="mt-3">
            <Checkbox
              label="Mark the lead won on the Pipeline too"
              checked={won}
              onChange={(e) => setWon(e.target.checked)}
              data-testid="close-lead-won"
            />
          </div>
        ) : null}
        <Foot>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="success"
            loading={busy === 'go'}
            onClick={() =>
              void act(
                'go',
                async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.deal.close', {
                      body: { workspaceId, dealId, markLeadWon: hasLead && won },
                    }),
                  ),
                hasLead && won ? 'Closed, and the lead marked won.' : 'Closed.',
              )
            }
            data-testid="close-deal-submit"
          >
            Close the deal
          </Button>
        </Foot>
      </DialogContent>
    </Dialog>
  );
}

/** Wiring instructions changed: a critical alert at once, and a duty to check by phone before money moves. */
export function WireDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
}: Open & { workspaceId: string; dealId: string }) {
  const [how, setHow] = useState<'email' | 'text' | 'phone' | 'other'>('email');
  const [from, setFrom] = useState('');
  const [note, setNote] = useState('');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Report changed wiring instructions"
        description="Everyone on the deal and your alert person hear at once. Nobody sends money until someone calls the title company at a number already on file."
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(
              'go',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.deal.report_wire_change', {
                    body: {
                      workspaceId,
                      dealId,
                      how,
                      ...(from.trim() ? { from: from.trim() } : {}),
                      ...(note.trim() ? { note: note.trim() } : {}),
                    },
                  }),
                ),
              'Reported. Everyone on the deal has been told.',
            );
          }}
        >
          <Field label="How it came in" htmlFor="wire-how">
            <Select
              id="wire-how"
              value={how}
              onChange={(e) => setHow(e.target.value as typeof how)}
            >
              <option value="email">Email</option>
              <option value="text">Text</option>
              <option value="phone">Phone call</option>
              <option value="other">Some other way</option>
            </Select>
          </Field>
          <Field label="Who it said it was from" htmlFor="wire-from">
            <Input id="wire-from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Note (optional)" htmlFor="wire-note">
            <Input id="wire-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Foot>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={busy === 'go'}>
              Report it
            </Button>
          </Foot>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Apply to this deal": what the newest duty list would change on it, then moving it there. */
export function ApplyVersionDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
}: Open & { workspaceId: string; dealId: string }) {
  const [diff, setDiff] = useState<TemplateDiff | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  useEffect(() => {
    if (!open) return;
    setDiff(null);
    setTrouble(null);
    apiBrowser()
      .POST('/v1/queries/realestate.template.diff', { body: { workspaceId, dealId } })
      .then(unwrap)
      .then(setDiff)
      .catch((e: Error) => setTrouble(e.message));
  }, [open, workspaceId, dealId]);
  const c = diff?.changes;
  const nothing = c && !c.cancel.length && !c.redefine.length && !c.add.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={diff ? `Move this deal to version ${diff.toVersion}?` : 'Newest duty list'}
        description={
          diff
            ? `It follows ${diff.fromVersion ? `version ${diff.fromVersion}` : 'the list it started with'}. Finished duties and ones added by hand stay as they are.`
            : undefined
        }
        className="w-[min(600px,calc(100vw-32px))]"
      >
        {trouble ? (
          <Callout tone="warning" className="mt-3">
            {trouble}
          </Callout>
        ) : !c ? (
          <p className="mt-3 text-[13px] text-text-3">Working out what would change…</p>
        ) : nothing ? (
          <p className="mt-3 text-[13.5px] text-text-2">Nothing on this deal would change.</p>
        ) : (
          <div className="mt-3 space-y-3 text-[13.5px]">
            {c.cancel.length ? (
              <Change
                title={`Cancelled (${c.cancel.length})`}
                items={c.cancel.map((x) => x.title)}
              />
            ) : null}
            {c.redefine.length ? (
              <Change
                title={`Changed (${c.redefine.length})`}
                items={c.redefine.map((x) => `${x.title}: ${x.changes.join(', ')}`)}
              />
            ) : null}
            {c.add.length ? (
              <Change title={`Added (${c.add.length})`} items={c.add.map((x) => x.title)} />
            ) : null}
          </div>
        )}
        <Foot>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!diff}
            loading={busy === 'go'}
            onClick={() =>
              diff &&
              void act(
                'go',
                async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.deal.apply_template_version', {
                      body: { workspaceId, dealId, templateSetId: diff.templateSetId },
                    }),
                  ),
                `Moved to version ${diff.toVersion}.`,
              )
            }
          >
            Apply to this deal
          </Button>
        </Foot>
      </DialogContent>
    </Dialog>
  );
}

function Change({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-3">{title}</div>
      <ul className="list-disc space-y-0.5 pl-5">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

/** A duty of this deal's own, beyond its list. */
export function AddDutyDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  members,
}: Open & { workspaceId: string; dealId: string; members: readonly Teammate[] }) {
  const blank = {
    title: '',
    details: '',
    dueDate: '',
    dueTime: '',
    proof: 'none' as 'none' | 'note' | 'file' | 'attestation',
    attestation: '',
    materiality: 'standard' as (typeof MATERIALITIES)[number],
    accountable: '',
  };
  const [f, setF] = useState(blank);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, errors, act } = useAct(close);
  useEffect(() => {
    if (open) setF(blank);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a duty to this deal" className="w-[min(560px,calc(100vw-32px))]">
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'go',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.duty.add', {
                    body: {
                      workspaceId,
                      dealId,
                      title: f.title.trim(),
                      tracker: 'HEALTH',
                      materiality: f.materiality,
                      proof: f.proof,
                      ...(f.details.trim() ? { details: f.details.trim() } : {}),
                      ...(f.dueDate ? { dueDate: f.dueDate } : {}),
                      ...(f.dueDate && f.dueTime ? { dueTime: f.dueTime } : {}),
                      ...(f.proof === 'attestation' && f.attestation.trim()
                        ? { attestation: f.attestation.trim() }
                        : {}),
                      ...(f.accountable ? { accountableUserId: f.accountable } : {}),
                    },
                  }),
                ),
              'Duty added.',
            );
          }}
        >
          <Field label="Duty" htmlFor="nd-title" error={errors.title}>
            <Input
              id="nd-title"
              value={f.title}
              maxLength={80}
              onChange={(e) => setF({ ...f, title: e.target.value })}
              data-testid="add-duty-title"
            />
          </Field>
          <Field label="Details (optional)" htmlFor="nd-details">
            <Input
              id="nd-details"
              value={f.details}
              onChange={(e) => setF({ ...f, details: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Due (optional)" htmlFor="nd-date" error={errors.dueDate}>
              <Input
                id="nd-date"
                type="date"
                value={f.dueDate}
                onChange={(e) => setF({ ...f, dueDate: e.target.value })}
              />
            </Field>
            <Field label="Time (optional)" htmlFor="nd-time" hint="None: 11:59 PM.">
              <Input
                id="nd-time"
                type="time"
                value={f.dueTime}
                disabled={!f.dueDate}
                onChange={(e) => setF({ ...f, dueTime: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="What finishes it" htmlFor="nd-proof">
              <Select
                id="nd-proof"
                value={f.proof}
                onChange={(e) => setF({ ...f, proof: e.target.value as typeof f.proof })}
              >
                <option value="none">Saying it’s done</option>
                <option value="note">A note of what was done</option>
                <option value="file">A file</option>
                <option value="attestation">Someone’s word</option>
              </Select>
            </Field>
            <Field label="How much it matters" htmlFor="nd-mat">
              <Select
                id="nd-mat"
                value={f.materiality}
                onChange={(e) =>
                  setF({ ...f, materiality: e.target.value as typeof f.materiality })
                }
              >
                {MATERIALITIES.map((m) => (
                  <option key={m} value={m}>
                    {MATERIALITY_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {f.proof === 'attestation' ? (
            <Field
              label="In these words"
              htmlFor="nd-att"
              hint="“I walked the property with the buyers.”"
            >
              <Input
                id="nd-att"
                value={f.attestation}
                onChange={(e) => setF({ ...f, attestation: e.target.value })}
              />
            </Field>
          ) : null}
          <Field label="Accountable" htmlFor="nd-who">
            <Select
              id="nd-who"
              value={f.accountable}
              onChange={(e) => setF({ ...f, accountable: e.target.value })}
            >
              <option value="">The main agent</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName}
                </option>
              ))}
            </Select>
          </Field>
          <Foot>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy === 'go'}
              disabled={!f.title.trim()}
              data-testid="add-duty-submit"
            >
              Add the duty
            </Button>
          </Foot>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Someone from the business on the deal: a co-agent, the coordinator or an assistant. */
export function TeamDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  members,
  team,
  canChooseMain,
}: Open & {
  workspaceId: string;
  dealId: string;
  members: readonly Teammate[];
  team: DealGet['team'];
  canChooseMain: boolean;
}) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'agent' | (typeof TEAM_ROLES)[number]>('coordinator');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  const onIt = new Set(team.map((t) => t.userId));
  useEffect(() => {
    if (open) {
      setUserId('');
      setRole('coordinator');
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add someone to the deal"
        description="They see the deal, its duties and documents. Only the people on a deal see it; owners and admins see every deal."
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'go',
              async () =>
                role === 'agent'
                  ? unwrap(
                      await apiBrowser().POST('/v1/commands/realestate.deal.set_role', {
                        body: { workspaceId, dealId, userId, role },
                      }),
                    )
                  : unwrap(
                      await apiBrowser().POST('/v1/commands/realestate.deal.add_person', {
                        body: { workspaceId, dealId, userId, role },
                      }),
                    ),
              'Added to the deal.',
            );
          }}
        >
          <Field label="Who" htmlFor="team-who">
            <Select id="team-who" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Pick someone</option>
              {members
                .filter((m) => !onIt.has(m.id) || canChooseMain)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.fullName}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Their part" htmlFor="team-role">
            <Select
              id="team-role"
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
            >
              {TEAM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {DEAL_ROLE_LABELS[r]}
                </option>
              ))}
              {canChooseMain ? (
                <option value="agent">Main agent (the current one stays as co-agent)</option>
              ) : null}
            </Select>
          </Field>
          <Foot>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'go'} disabled={!userId}>
              Add
            </Button>
          </Foot>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Someone from outside with a part in the deal: the client, the lender, title, the other side's agent. */
export function PartyDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
}: Open & { workspaceId: string; dealId: string }) {
  const [role, setRole] = useState<PartyRole>('client');
  const [who, setWho] = useState<PickedRecord | null>(null);
  const [note, setNote] = useState('');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, errors, act } = useAct(close);
  useEffect(() => {
    if (open) {
      setRole('client');
      setWho(null);
      setNote('');
    }
  }, [open]);
  const end = PARTY_ROLES[role].end;
  const wrongKind = who && who.kind !== end;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add someone from outside"
        description="From the business’s contacts. They’re linked to the deal, not told about it."
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!who || wrongKind) return;
            void act(
              'go',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.party.add', {
                    body: {
                      workspaceId,
                      dealId,
                      role,
                      ...(who.kind === 'person' ? { personId: who.id } : { companyId: who.id }),
                      ...(note.trim() ? { note: note.trim() } : {}),
                    },
                  }),
                ),
              'Added.',
            );
          }}
        >
          <Field label="Their part" htmlFor="party-role">
            <Select
              id="party-role"
              value={role}
              onChange={(e) => setRole(e.target.value as PartyRole)}
            >
              {PARTY_ROLES_LIST.map((r) => (
                <option key={r} value={r}>
                  {PARTY_ROLES[r].label}
                  {PARTY_ROLES[r].end === 'company' ? ' (a company)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Who"
            htmlFor="party-who"
            error={
              wrongKind
                ? end === 'person'
                  ? 'Pick a person for this part.'
                  : 'Pick a company for this part.'
                : (errors.personId ?? errors.companyId)
            }
          >
            <RecordPicker id="party-who" workspaceId={workspaceId} value={who} onChange={setWho} />
          </Field>
          <Field
            label="Note (optional)"
            htmlFor="party-note"
            hint="“Loan officer at Summit Lending”"
          >
            <Input
              id="party-note"
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <Foot>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'go'} disabled={!who || !!wrongKind}>
              Add
            </Button>
          </Foot>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The home the deal is about: one already here by its address, or a new one. */
export function PropertyDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
}: Open & { workspaceId: string; dealId: string }) {
  const [address, setAddress] = useState('');
  const [matches, setMatches] = useState<{ propertyId: string; address: string; deals: number }[]>(
    [],
  );
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  useEffect(() => {
    if (open) setAddress('');
  }, [open]);
  useEffect(() => {
    const q = address.trim();
    if (q.length < 3) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      apiBrowser()
        .POST('/v1/queries/realestate.property.search', { body: { workspaceId, q, limit: 5 } })
        .then(unwrap)
        .then((o) => !cancelled && setMatches(o.properties))
        .catch(() => !cancelled && setMatches([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [address, workspaceId]);
  const set = (body: { propertyId: string } | { newPropertyAddress: string }) =>
    void act(
      'go',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.deal.set_property', {
            body: { workspaceId, dealId, ...body },
          }),
        ),
      'Property set.',
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="The property" description="Both sides of one sale share one property.">
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (address.trim()) set({ newPropertyAddress: address.trim() });
          }}
        >
          <Field label="Address" htmlFor="prop-address">
            <Input
              id="prop-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              autoComplete="off"
            />
          </Field>
          {matches.length ? (
            <ul className="rounded-menu border border-border p-1.5">
              {matches.map((m) => (
                <li key={m.propertyId}>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center justify-between rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2"
                    onClick={() => set({ propertyId: m.propertyId })}
                  >
                    <span className="truncate font-medium">{m.address}</span>
                    <span className="text-xs text-text-3">
                      Already here · {m.deals === 1 ? '1 deal' : `${m.deals} deals`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <Foot>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'go'} disabled={!address.trim()}>
              Add as a new property
            </Button>
          </Foot>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const pct = (bp: number | null) => (bp === null ? '' : String(bp / 100));
const toBp = (s: string) => (s.trim() === '' ? null : Math.round(Number(s) * 100));

/** What the agent expects to earn: a rate or a flat amount, a credit to the client, and the brokerage split. */
export function CommissionDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  commission,
}: Open & { workspaceId: string; dealId: string; commission: DealGet['commission'] }) {
  const [kind, setKind] = useState<'rate' | 'flat'>('rate');
  const [rate, setRate] = useState('');
  const [flat, setFlat] = useState('');
  const [credit, setCredit] = useState('');
  const [split, setSplit] = useState('');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, errors, act } = useAct(close);
  useEffect(() => {
    if (!open) return;
    setKind(commission.flatCents !== null ? 'flat' : 'rate');
    setRate(pct(commission.rateBp));
    setFlat(commission.flatCents !== null ? money(commission.flatCents) : '');
    setCredit(commission.creditCents ? money(commission.creditCents) : '');
    setSplit(pct(commission.splitBp));
  }, [open, commission]);
  const bad =
    (kind === 'rate' && rate && Number.isNaN(Number(rate))) ||
    (split && Number.isNaN(Number(split)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Commission"
        description="The expected amount is worked out from the price once it’s confirmed."
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'go',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.deal.set_commission', {
                    body: {
                      workspaceId,
                      dealId,
                      rateBp: kind === 'rate' ? toBp(rate) : null,
                      flatCents: kind === 'flat' ? parseMoney(flat) : null,
                      creditCents: parseMoney(credit) ?? 0,
                      splitBp: toBp(split),
                    },
                  }),
                ),
              'Commission saved.',
            );
          }}
        >
          <Field label="Agreed as" htmlFor="com-kind">
            <Select
              id="com-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'rate' | 'flat')}
            >
              <option value="rate">A share of the price</option>
              <option value="flat">A flat amount</option>
            </Select>
          </Field>
          {kind === 'rate' ? (
            <Field label="Rate (%)" htmlFor="com-rate" error={errors.rateBp}>
              <Input
                id="com-rate"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="2.5"
              />
            </Field>
          ) : (
            <Field label="Amount" htmlFor="com-flat" error={errors.flatCents}>
              <Input
                id="com-flat"
                inputMode="decimal"
                value={flat}
                onChange={(e) => setFlat(e.target.value)}
                placeholder="$8,000"
              />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Credit to the client"
              htmlFor="com-credit"
              hint="Taken off before the split."
            >
              <Input
                id="com-credit"
                inputMode="decimal"
                value={credit}
                onChange={(e) => setCredit(e.target.value)}
                placeholder="$0"
              />
            </Field>
            <Field
              label="Your share of the split (%)"
              htmlFor="com-split"
              hint="70 for a 70/30 split."
              error={errors.splitBp}
            >
              <Input
                id="com-split"
                inputMode="decimal"
                value={split}
                onChange={(e) => setSplit(e.target.value)}
                placeholder="70"
              />
            </Field>
          </div>
          <Foot>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'go'} disabled={!!bad}>
              Save
            </Button>
          </Foot>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The final commission, once it's paid: owners and admins set it. */
export function FinalCommissionDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  expectedCents,
}: Open & { workspaceId: string; dealId: string; expectedCents: number | null }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  useEffect(() => {
    if (open) {
      setAmount(expectedCents !== null ? money(expectedCents) : '');
      setNote('');
    }
  }, [open, expectedCents]);
  const cents = parseMoney(amount);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Final commission"
        description="What was actually paid. Owners and admins set it; it’s kept in the deal’s history."
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (cents === null) return;
            void act(
              'go',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.deal.set_final_commission', {
                    body: {
                      workspaceId,
                      dealId,
                      cents,
                      ...(note.trim() ? { note: note.trim() } : {}),
                    },
                  }),
                ),
              'Final commission saved.',
            );
          }}
        >
          <Field label="Amount" htmlFor="final-amount">
            <Input
              id="final-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Note (optional)" htmlFor="final-note">
            <Input id="final-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Foot>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'go'} disabled={cents === null}>
              Save
            </Button>
          </Foot>
        </form>
      </DialogContent>
    </Dialog>
  );
}
