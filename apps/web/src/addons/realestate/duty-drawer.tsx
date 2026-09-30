'use client';
/**
 * A duty (board 5, design/realestate/DutyDrawer.dc.html): what it is, when it's due and why, what finishes it and
 * the proof so far, who answers for it, and every change. It's done only with its proof; owners and admins
 * (`realestate.except`) may finish it without, or waive it, with a reason that stays in its history.
 */
import { ATTACHMENT_TYPES } from '@hfos/core';
import { KEY_DATES } from '@hfos/core/addons/realestate/dates/key-dates';
import { dutyLogWords } from '@hfos/core/addons/realestate/history-words';
import {
  ACCOUNTABLE_LABELS,
  dueWarningWords,
  dueWords,
  PERFORMER_LABELS,
  traceWords,
  trackerName,
  whenWords,
} from '@hfos/core/addons/realestate/rule-words';
import { isDoneDuty, isOpenDuty, type DutyStatus } from '@hfos/core/addons/realestate/states';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Callout } from '@/components/crm/chips';
import { uploadFile } from '@/components/files/upload-zone';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Sheet, SheetClose, SheetContent } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { DutyStatusBadge } from './bits';
import type { DealDocument, DutyGet, Teammate } from './types';
import { useAct } from './use-act';

type Form =
  | 'note'
  | 'attest'
  | 'file'
  | 'document'
  | 'waiting'
  | 'blocked'
  | 'except'
  | 'waive'
  | 'cancel'
  | 'reopen'
  | 'due'
  | null;

export function DutyDrawer({
  workspaceId,
  dutyId,
  onClose,
  timeZone,
  members,
}: {
  workspaceId: string;
  dutyId: string | null;
  onClose: () => void;
  timeZone: string;
  members: readonly Teammate[];
}) {
  const [data, setData] = useState<DutyGet | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const changes = useLiveVersion(['custom_record']);
  const load = useCallback(async () => {
    if (!dutyId) return;
    try {
      setData(
        unwrap(
          await apiBrowser().POST('/v1/queries/realestate.duty.get', {
            body: { workspaceId, dutyId },
          }),
        ),
      );
      setFailed(null);
    } catch (e) {
      setFailed(errorMessage(e, 'This duty couldn’t be opened. Try again in a minute.'));
    }
  }, [workspaceId, dutyId]);
  useEffect(() => {
    if (!dutyId) {
      setData(null);
      return;
    }
    void load();
  }, [dutyId, load, changes]);

  return (
    <Sheet open={!!dutyId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={data?.duty.title ?? 'Duty'} hideHeader className="sm:w-[560px]">
        {data && data.duty.dutyId === dutyId ? (
          <DutyBody
            workspaceId={workspaceId}
            data={data}
            timeZone={timeZone}
            members={members}
            reload={load}
          />
        ) : failed ? (
          <div className="flex items-start justify-between gap-3">
            <p className="text-[13.5px] text-text-2">{failed}</p>
            <SheetClose
              className="rounded-control p-1 text-text-2 hover:bg-card-2"
              aria-label="Close"
            >
              <X className="h-[18px] w-[18px]" />
            </SheetClose>
          </div>
        ) : (
          <p className="text-[13.5px] text-text-3">Opening the duty…</p>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DutyBody({
  workspaceId,
  data,
  timeZone,
  members,
  reload,
}: {
  workspaceId: string;
  data: DutyGet;
  timeZone: string;
  members: readonly Teammate[];
  reload: () => Promise<void>;
}) {
  const { duty, proof, evidence, log, can } = data;
  const [form, setForm] = useState<Form>(null);
  const [text, setText] = useState('');
  const [extra, setExtra] = useState({ owner: '', impact: '', review: '', date: '', time: '' });
  const [documents, setDocuments] = useState<DealDocument[] | null>(null);
  const [documentId, setDocumentId] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const after = useCallback(() => {
    setForm(null);
    setText('');
    void reload();
  }, [reload]);
  const { busy, errors, act } = useAct(after);
  const api = apiBrowser();
  const ids = { workspaceId, dutyId: duty.dutyId };
  const status = duty.status as DutyStatus;
  const open = isOpenDuty(status);
  const done = isDoneDuty(status);
  const thisYear = new Date().getFullYear();

  function show(next: Form, prefill = '') {
    setForm(next);
    setText(prefill);
    setExtra({ owner: '', impact: '', review: '', date: duty.dueDate ?? '', time: '' });
    if (next === 'document' && documents === null)
      void api
        .POST('/v1/queries/realestate.document.list', {
          body: { workspaceId, dealId: duty.dealId },
        })
        .then(unwrap)
        .then((d) => setDocuments(d.documents.filter((x) => x.status !== 'void')))
        .catch(() => setDocuments([]));
  }

  const addEvidence = (kind: 'note' | 'attestation', body: string) =>
    act(
      'evidence',
      async () =>
        unwrap(
          await api.POST('/v1/commands/realestate.duty.add_evidence', {
            body: { ...ids, kind, body },
          }),
        ),
      kind === 'note' ? 'Note added.' : 'Added.',
    );

  async function addFile(file: File) {
    await act(
      'file',
      async () => {
        const fileId = await uploadFile(workspaceId, 'custom_record', duty.dealId, file);
        unwrap(
          await api.POST('/v1/commands/realestate.duty.add_evidence', {
            body: { ...ids, kind: 'file', fileId },
          }),
        );
      },
      `${file.name} added as proof.`,
    );
  }

  const due =
    duty.dueState === 'due' && duty.dueDate
      ? whenWords(duty.dueDate, duty.dueTime, thisYear)
      : duty.dueState === 'waiting'
        ? 'When its dates are in'
        : 'No deadline';
  const performers = duty.performers.map(
    (p) => (PERFORMER_LABELS as Readonly<Record<string, string>>)[p] ?? p,
  );

  return (
    <div className="flex flex-col gap-4 text-[13.5px]" data-testid="duty-drawer">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-3">
            {trackerName(duty.tracker)} · {duty.key}
            {duty.pass > 1 ? ` · round ${duty.pass}` : ''}
          </div>
          <h2 className="mt-1 text-lg font-semibold tracking-tight">{duty.title}</h2>
          {duty.behavior ? <p className="mt-1 text-text-2">{duty.behavior}</p> : null}
          <p className="mt-1 text-[12.5px] text-text-3">{duty.dealName}</p>
        </div>
        <SheetClose
          className="rounded-control p-1 text-text-2 hover:bg-card-2 hover:text-text"
          aria-label="Close"
        >
          <X className="h-[18px] w-[18px]" />
        </SheetClose>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {duty.overdue && duty.dueAt ? (
          <Badge variant="danger">{dueWords(duty.dueAt, timeZone)}</Badge>
        ) : (
          <DutyStatusBadge status={status} />
        )}
        <Badge variant="gray">Accountable: {duty.accountable?.name ?? 'nobody yet'}</Badge>
        {performers.length ? <Badge variant="gray">Doing it: {performers.join(', ')}</Badge> : null}
        {duty.materiality !== 'standard' ? (
          <Badge variant={duty.materiality === 'critical' ? 'danger' : 'pending'}>
            {duty.materiality === 'critical' ? 'Could stop the closing' : 'Matters to the deal'}
          </Badge>
        ) : null}
        {duty.exception ? <Badge variant="pending">Done without its proof</Badge> : null}
      </div>

      <div>
        <p>
          <span className="text-text-2">Due </span>
          <span className="font-medium">{due}</span>
          {duty.dueState !== 'none' ? <span className="text-text-2"> · {duty.dueRule}</span> : null}
        </p>
        {traceWords(duty.dueTrace).map((l) => (
          <p key={l} className="text-[12.5px] text-text-3">
            {l}
          </p>
        ))}
        {dueWarningWords(duty.warnings).map((l) => (
          <p key={l} className="text-[12.5px] text-warning-text">
            {l}
          </p>
        ))}
        {duty.dueSetByHand ? (
          <p className="text-[12.5px] text-text-3">Moved by hand: {duty.dueSetByHand.reason}</p>
        ) : null}
        {duty.dueState === 'waiting' && duty.needsDates.length ? (
          <p className="text-[12.5px] text-text-3">
            It starts once these are confirmed on Key dates:{' '}
            {duty.needsDates
              .map((k) => (KEY_DATES as Readonly<Record<string, { label: string }>>)[k]?.label ?? k)
              .join(', ')}
            .
          </p>
        ) : null}
      </div>

      {duty.waitingOn && status === 'waiting_external' ? (
        <Callout tone="warning">Waiting on {duty.waitingOn}.</Callout>
      ) : null}
      {duty.blocker && status === 'blocked' ? (
        <Callout tone="danger">
          <div className="font-medium">Blocked: {duty.blocker.what}</div>
          <div>
            {duty.blocker.owner} to clear it
            {duty.blocker.impact ? ` · holds up ${duty.blocker.impact}` : ''}
            {duty.blocker.reviewAt
              ? ` · look again ${dueWords(duty.blocker.reviewAt, timeZone, { open: false }).replace(/^due /, '')}`
              : ''}
          </div>
        </Callout>
      ) : null}

      <section>
        <h3 className="mb-1.5 font-medium">Proof</h3>
        <p className="text-text-2">
          {proof.needs
            ? `It’s done with ${proof.needs}.`
            : 'Saying it’s done is enough. No proof needed.'}
        </p>
        {open && proof.missing ? (
          <p className="mt-1 text-[12.5px] text-warning-text" data-testid="duty-proof-missing">
            Still missing: {proof.missing}
          </p>
        ) : open && proof.needs ? (
          <p className="mt-1 text-[12.5px] text-success-text">All its proof is in.</p>
        ) : null}
        {evidence.length ? (
          <ul className="mt-2 divide-y divide-border rounded-menu border border-border">
            {evidence.map((e) => (
              <li key={e.evidenceId} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className={e.withdrawnAt ? 'text-text-3 line-through' : ''}>{e.label}</div>
                  <div className="text-[12px] text-text-3">
                    {e.addedBy?.name ?? 'HandsFreeOS'} ·{' '}
                    {whenWords(e.addedAt.slice(0, 10), null, thisYear)}
                    {e.withdrawnReason ? ` · withdrawn: ${e.withdrawnReason}` : ''}
                  </div>
                </div>
                {!e.withdrawnAt && open ? (
                  <button
                    type="button"
                    className="flex-none text-[12.5px] text-text-2 hover:text-text"
                    onClick={() => {
                      const why = window.prompt('Why take this proof back?');
                      if (why?.trim())
                        void act(
                          `withdraw-${e.evidenceId}`,
                          async () =>
                            unwrap(
                              await api.POST('/v1/commands/realestate.duty.withdraw_evidence', {
                                body: { ...ids, evidenceId: e.evidenceId, reason: why.trim() },
                              }),
                            ),
                          'Proof taken back.',
                        );
                    }}
                  >
                    Take back
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {open ? (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              void act(
                'complete',
                async () =>
                  unwrap(await api.POST('/v1/commands/realestate.duty.complete', { body: ids })),
                'Marked done.',
              )
            }
            loading={busy === 'complete'}
            data-testid="duty-complete"
          >
            Mark done
          </Button>
          <Button variant="secondary" onClick={() => show('note')} data-testid="duty-add-note">
            Add a note
          </Button>
          {proof.attestations.length ? (
            <Button variant="secondary" onClick={() => show('attest', proof.attestations[0])}>
              Give your word
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => fileInput.current?.click()}
            loading={busy === 'file'}
          >
            Add a file
          </Button>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept={ATTACHMENT_TYPES.join(',')}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void addFile(f);
            }}
            data-testid="duty-file-input"
          />
          <Button variant="secondary" onClick={() => show('document')}>
            Pick a document
          </Button>
          <Button variant="ghost" onClick={() => show('waiting', duty.waitingOn ?? '')}>
            Waiting on…
          </Button>
          <Button variant="ghost" onClick={() => show('blocked')}>
            Blocked
          </Button>
          {status !== 'in_progress' ? (
            <Button
              variant="ghost"
              loading={busy === 'progress'}
              onClick={() =>
                void act(
                  'progress',
                  async () =>
                    unwrap(
                      await api.POST('/v1/commands/realestate.duty.set_status', {
                        body: { ...ids, status: 'in_progress' },
                      }),
                    ),
                  'Marked in progress.',
                )
              }
            >
              In progress
            </Button>
          ) : null}
        </div>
      ) : null}

      {form === 'note' || form === 'attest' ? (
        <InlineForm
          label={form === 'note' ? 'What was done' : 'In your words'}
          hint={
            form === 'attest'
              ? 'Kept with your name, as your word that it happened.'
              : 'A note shows what happened. When this duty needs a document or a file, a note alone doesn’t finish it.'
          }
          value={text}
          onChange={setText}
          busy={busy === 'evidence'}
          submit={form === 'note' ? 'Add the note' : 'Add your word'}
          onCancel={() => setForm(null)}
          onSubmit={() => void addEvidence(form === 'note' ? 'note' : 'attestation', text.trim())}
          testId="duty-note"
        />
      ) : null}

      {form === 'document' ? (
        <div className="rounded-menu border border-border p-3">
          <Field
            label="A document on this deal"
            htmlFor="duty-doc"
            hint="Add documents on the deal’s Documents page."
          >
            <Select
              id="duty-doc"
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
            >
              <option value="">{documents === null ? 'Loading…' : 'Pick one'}</option>
              {(documents ?? []).map((d) => (
                <option key={d.documentId} value={d.documentId}>
                  {d.title} · {d.kindLabel} v{d.version}
                  {d.status === 'signed' ? ' · signed' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button
              disabled={!documentId}
              loading={busy === 'evidence'}
              onClick={() =>
                void act(
                  'evidence',
                  async () =>
                    unwrap(
                      await api.POST('/v1/commands/realestate.duty.add_evidence', {
                        body: { ...ids, kind: 'document', documentId },
                      }),
                    ),
                  'Document added as proof.',
                )
              }
            >
              Add it
            </Button>
          </div>
        </div>
      ) : null}

      {form === 'waiting' ? (
        <InlineForm
          label="Waiting on"
          hint="Who has to do something before this can move: the lender, the sellers, Capitol Title."
          value={text}
          onChange={setText}
          multiline={false}
          busy={busy === 'status'}
          submit="Save"
          error={errors.waitingOn}
          onCancel={() => setForm(null)}
          onSubmit={() =>
            void act(
              'status',
              async () =>
                unwrap(
                  await api.POST('/v1/commands/realestate.duty.set_status', {
                    body: { ...ids, status: 'waiting_external', waitingOn: text.trim() },
                  }),
                ),
              'Marked waiting.',
            )
          }
        />
      ) : null}

      {form === 'blocked' ? (
        <div className="space-y-3 rounded-menu border border-border p-3">
          <Field label="What’s in the way" htmlFor="blk-what" error={errors.what}>
            <Input id="blk-what" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label="Whose it is to clear" htmlFor="blk-owner" error={errors.owner}>
            <Input
              id="blk-owner"
              value={extra.owner}
              onChange={(e) => setExtra({ ...extra, owner: e.target.value })}
            />
          </Field>
          <Field label="What it holds up" htmlFor="blk-impact" error={errors.impact}>
            <Input
              id="blk-impact"
              value={extra.impact}
              onChange={(e) => setExtra({ ...extra, impact: e.target.value })}
            />
          </Field>
          <Field label="Look again on" htmlFor="blk-review" error={errors.reviewAt}>
            <Input
              id="blk-review"
              type="date"
              value={extra.review}
              onChange={(e) => setExtra({ ...extra, review: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button
              loading={busy === 'status'}
              onClick={() =>
                void act(
                  'status',
                  async () =>
                    unwrap(
                      await api.POST('/v1/commands/realestate.duty.set_status', {
                        body: {
                          ...ids,
                          status: 'blocked',
                          blocker: {
                            what: text.trim(),
                            owner: extra.owner.trim(),
                            impact: extra.impact.trim(),
                            reviewAt: extra.review
                              ? new Date(`${extra.review}T09:00:00`).toISOString()
                              : new Date(Date.now() + 86_400_000).toISOString(),
                          },
                        },
                      }),
                    ),
                  'Marked blocked.',
                )
              }
            >
              Mark blocked
            </Button>
          </div>
        </div>
      ) : null}

      {open && can.except ? (
        <section className="border-t border-border pt-4">
          <h3 className="mb-1 font-medium">
            {proof.missing ? `Finish without ${proof.missing}` : 'Finish it another way'}
          </h3>
          <p className="mb-2 text-[12.5px] text-text-3">
            Owners and admins only. The reason is kept in its history.
          </p>
          {form === 'except' || form === 'waive' ? (
            <InlineForm
              label="Reason (required)"
              value={text}
              onChange={setText}
              busy={busy === 'except'}
              submit={form === 'except' ? 'Complete with a reason' : 'Waive it'}
              error={errors.reason}
              onCancel={() => setForm(null)}
              onSubmit={() =>
                void act(
                  'except',
                  async () =>
                    form === 'except'
                      ? unwrap(
                          await api.POST('/v1/commands/realestate.duty.complete_with_exception', {
                            body: { ...ids, reason: text.trim() },
                          }),
                        )
                      : unwrap(
                          await api.POST('/v1/commands/realestate.duty.waive', {
                            body: { ...ids, reason: text.trim() },
                          }),
                        ),
                  form === 'except' ? 'Marked done, with your reason.' : 'Waived.',
                )
              }
              testId="duty-except"
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => show('except')}
                data-testid="duty-complete-except"
              >
                Complete with a reason
              </Button>
              <Button variant="ghost" onClick={() => show('waive')}>
                Waive it
              </Button>
            </div>
          )}
        </section>
      ) : null}

      <section className="border-t border-border pt-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Accountable" htmlFor="duty-assign">
            <Select
              id="duty-assign"
              value={duty.accountable?.userId ?? ''}
              disabled={!open || busy === 'assign'}
              onChange={(e) =>
                void act(
                  'assign',
                  async () =>
                    unwrap(
                      await api.POST('/v1/commands/realestate.duty.assign', {
                        body: { ...ids, userId: e.target.value || null },
                      }),
                    ),
                  'Handed over.',
                )
              }
            >
              <option value="">
                As its rule says (
                {(ACCOUNTABLE_LABELS as Readonly<Record<string, string>>)[duty.accountableRole] ??
                  duty.accountableRole}
                )
              </option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            {open ? (
              <Button variant="ghost" onClick={() => show('due')}>
                Move the due date
              </Button>
            ) : null}
            {open && duty.overdue && !duty.acknowledgedAt ? (
              <Button
                variant="ghost"
                loading={busy === 'ack'}
                onClick={() =>
                  void act(
                    'ack',
                    async () =>
                      unwrap(
                        await api.POST('/v1/commands/realestate.duty.acknowledge', { body: ids }),
                      ),
                    'Acknowledged. Its alerts stop climbing.',
                  )
                }
              >
                Acknowledge
              </Button>
            ) : null}
            {open ? (
              <Button variant="ghost" onClick={() => show('cancel')}>
                Cancel the duty
              </Button>
            ) : null}
            {done ? (
              <Button variant="secondary" onClick={() => show('reopen')} data-testid="duty-reopen">
                Reopen
              </Button>
            ) : null}
          </div>
        </div>
        {form === 'due' ? (
          <div className="mt-3 space-y-3 rounded-menu border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="New due date" htmlFor="due-date" error={errors.date}>
                <Input
                  id="due-date"
                  type="date"
                  value={extra.date}
                  onChange={(e) => setExtra({ ...extra, date: e.target.value })}
                />
              </Field>
              <Field
                label="Time (optional)"
                htmlFor="due-time"
                hint="None: 11:59 PM."
                error={errors.time}
              >
                <Input
                  id="due-time"
                  type="time"
                  value={extra.time}
                  onChange={(e) => setExtra({ ...extra, time: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Why" htmlFor="due-why" error={errors.reason}>
              <Input id="due-why" value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              {duty.dueSetByHand ? (
                <Button
                  variant="ghost"
                  loading={busy === 'due-clear'}
                  onClick={() =>
                    void act(
                      'due-clear',
                      async () =>
                        unwrap(
                          await api.POST('/v1/commands/realestate.duty.set_due', {
                            body: { ...ids, clear: true },
                          }),
                        ),
                      'Back to what its rule says.',
                    )
                  }
                >
                  Back to its rule
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button
                loading={busy === 'due'}
                onClick={() =>
                  void act(
                    'due',
                    async () =>
                      unwrap(
                        await api.POST('/v1/commands/realestate.duty.set_due', {
                          body: {
                            ...ids,
                            date: extra.date,
                            ...(extra.time ? { time: extra.time } : {}),
                            reason: text.trim(),
                            clear: false,
                          },
                        }),
                      ),
                    'Due date moved.',
                  )
                }
              >
                Move it
              </Button>
            </div>
          </div>
        ) : null}
        {form === 'cancel' || form === 'reopen' ? (
          <div className="mt-3">
            <InlineForm
              label={form === 'cancel' ? 'Why cancel it' : 'Why reopen it'}
              value={text}
              onChange={setText}
              busy={busy === 'reason'}
              submit={form === 'cancel' ? 'Cancel the duty' : 'Reopen'}
              error={errors.reason}
              onCancel={() => setForm(null)}
              onSubmit={() =>
                void act(
                  'reason',
                  async () =>
                    form === 'cancel'
                      ? unwrap(
                          await api.POST('/v1/commands/realestate.duty.cancel', {
                            body: { ...ids, reason: text.trim() },
                          }),
                        )
                      : unwrap(
                          await api.POST('/v1/commands/realestate.duty.reopen', {
                            body: { ...ids, reason: text.trim() },
                          }),
                        ),
                  form === 'cancel' ? 'Cancelled.' : 'Reopened.',
                )
              }
            />
          </div>
        ) : null}
        {done && duty.finishReason ? (
          <p className="mt-3 text-[12.5px] text-text-3">Reason: {duty.finishReason}</p>
        ) : null}
      </section>

      <section className="border-t border-border pt-4">
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-3">
          History
        </h3>
        <ul className="space-y-1 text-[12.5px] text-text-2" data-testid="duty-history">
          {log.map((l, i) => (
            <li key={`${l.at}-${i}`}>
              {whenWords(l.at.slice(0, 10), null, thisYear)} ·{' '}
              {dutyLogWords(l.what, l.before, l.after)}
              {l.actor ? ` by ${l.actor.name}` : l.actorType === 'ai' ? ' by the Assistant' : ''}
              {l.note ? `: ${l.note}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function InlineForm({
  label,
  hint,
  value,
  onChange,
  onSubmit,
  onCancel,
  submit,
  busy,
  error,
  multiline = true,
  testId,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submit: string;
  busy: boolean;
  error?: string;
  multiline?: boolean;
  testId?: string;
}) {
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <form
      className="rounded-menu border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit();
      }}
      data-testid={testId}
    >
      <Field label={label} htmlFor={id} hint={hint} error={error}>
        {multiline ? (
          <Textarea
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="min-h-[72px]"
          />
        ) : (
          <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
        )}
      </Field>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!value.trim()}>
          {submit}
        </Button>
      </div>
    </form>
  );
}
