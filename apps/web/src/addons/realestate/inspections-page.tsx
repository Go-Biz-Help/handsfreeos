'use client';
/**
 * A buyer deal's inspections (board 23, design/realestate/Inspections.dc.html): each inspection and its report,
 * what it found with the client's priority and what to ask for, and the repair request drafted from them, its
 * versions and the seller's answers. Every version and answer is kept.
 *
 * On a listing (round three) it's the other way round: the buyer's inspector comes to the home, the buyers' repair
 * request comes in and is kept as it came, and our seller's answer goes out.
 */
import { fmtDateShort, fmtMonthDay, localInstant, money } from '@hfos/core';
import {
  CLIENT_PRIORITIES,
  CLIENT_PRIORITY_KEYS,
  FINDING_ASK_KEYS,
  FINDING_ASKS,
  FINDING_SEVERITIES,
  FINDING_SEVERITY_KEYS,
  INSPECTION_KIND_KEYS,
  INSPECTION_KINDS,
  type ClientPriority,
  type FindingAsk,
  type FindingSeverity,
  type InspectionKind,
} from '@hfos/core/addons/realestate/closing';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { FileItem } from '@/lib/api/types';
import { dateOf, fmtTime } from '@/lib/calendar/time';
import { parseMoney } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { CardHead } from './bits';
import { DealCrumb, firstNames } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import { Thumb } from './field-cards';
import type { DealDocument, Finding, Inspection, Inspections } from './types';
import { useAct } from './use-act';

const thisYear = () => new Date().getFullYear();
const day = (d: string) => fmtMonthDay(d, thisYear());

export function InspectionsPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  data,
  documents,
  clients,
  live,
  side = 'buyer',
  files = [],
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  data: Inspections;
  documents: readonly DealDocument[];
  clients: readonly string[];
  live: boolean;
  side?: 'buyer' | 'listing';
  /** The deal's files, for the findings' photos (taken at the inspection on the phone, round six). */
  files?: readonly FileItem[];
}) {
  useLiveRefresh(['custom_record']);
  const listing = side === 'listing';
  const [receiving, setReceiving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [reportFor, setReportFor] = useState<Inspection | null>(null);
  const [canceling, setCanceling] = useState<Inspection | null>(null);
  const [finding, setFinding] = useState<{ inspection: Inspection; f: Finding | null } | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState(false);
  const who = firstNames(clients) || 'The client';
  const active = data.inspections.filter((i) => i.status !== 'canceled');
  const findings = active.flatMap((i) => i.findings.map((f) => ({ i, f })));
  const fileById = new Map(files.map((f) => [f.id, f]));
  const last = data.repairs.at(-1);
  // Whose turn it is: the request is ours on a buyer deal, the buyers' on a listing; the answer is the other side's.
  const asked = listing ? 'them' : 'us';
  const outcomeWords = (o: 'agreed' | 'countered' | 'refused') =>
    `${listing ? 'Your seller' : 'The seller'} ${o === 'agreed' ? 'agreed' : o === 'refused' ? 'refused' : 'countered'}`;
  return (
    <div data-testid="realestate-inspections">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Inspections" />
      <PageHeader
        title="Inspections"
        description={
          data.periodEnds
            ? `${dealName} · inspection period ends ${fmtDateShort(data.periodEnds)}`
            : `${dealName} · enter when the inspection period ends under Key dates`
        }
        actions={
          live ? (
            <>
              <Button
                variant="secondary"
                onClick={() => setAdding(true)}
                data-testid="inspection-add"
              >
                Add an inspection
              </Button>
              {listing ? (
                <Button onClick={() => setReceiving(true)} data-testid="repair-receive">
                  {last ? 'Keep their new request' : 'Keep the buyers’ request'}
                </Button>
              ) : (
                <Button
                  onClick={() => setSending(true)}
                  disabled={!data.draft.items && !last}
                  data-testid="repair-draft"
                >
                  {last ? 'Send another version' : 'Draft the repair request'}
                </Button>
              )}
            </>
          ) : null
        }
      />
      <div className="space-y-4">
        {active.length === 0 ? (
          <Card className="p-5 text-[13.5px] text-text-2">
            {listing
              ? 'No inspections yet. Add the buyer’s inspection with its inspector and day, so the home is ready for them.'
              : 'No inspections yet. Add each one with its inspector and day; when its report is in, add what it found and the repair request drafts itself from them.'}
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {active.map((i) => (
              <Card key={i.id} className="p-4 md:p-5" data-testid="inspection-card">
                <CardHead
                  title={i.label}
                  action={
                    i.status === 'report_in' ? (
                      <Badge variant="ok">Report in</Badge>
                    ) : i.scheduledAt ? (
                      <Badge variant="pending">{day(dateOf(i.scheduledAt, timeZone))}</Badge>
                    ) : (
                      <Badge variant="gray">Not booked</Badge>
                    )
                  }
                />
                <p className="text-[13px] text-text-2">
                  {[
                    i.scheduledAt
                      ? `${day(dateOf(i.scheduledAt, timeZone))}, ${fmtTime(i.scheduledAt, timeZone)}`
                      : null,
                    i.inspector,
                    i.status === 'report_in'
                      ? i.pages
                        ? `${i.pages}-page report`
                        : 'report in'
                      : i.reportExpectedOn
                        ? `report expected ${day(i.reportExpectedOn)}`
                        : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {i.note ? <p className="mt-1 text-[12.5px] text-text-3">{i.note}</p> : null}
                {live ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {i.status !== 'report_in' ? (
                      <Button size="sm" variant="secondary" onClick={() => setReportFor(i)}>
                        The report’s in
                      </Button>
                    ) : null}
                    {listing ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setFinding({ inspection: i, f: null })}
                      >
                        Add a finding
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setCanceling(i)}>
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        )}
        {findings.length && !listing ? (
          <Card className="overflow-x-auto p-0" data-testid="inspection-findings">
            <table className="w-full min-w-[640px] text-left text-[13.5px]">
              <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
                <tr>
                  <th className="px-5 py-3 font-semibold">Finding</th>
                  <th className="px-3 py-3 font-semibold">Where</th>
                  <th className="px-3 py-3 font-semibold">How serious</th>
                  <th className="px-3 py-3 font-semibold">Estimate</th>
                  <th className="px-3 py-3 font-semibold">{who}’s priority</th>
                  <th className="px-5 py-3 font-semibold">Ask for</th>
                </tr>
              </thead>
              <tbody>
                {findings.map(({ i, f }) => (
                  <tr
                    key={f.id}
                    className="cursor-pointer border-b border-border last:border-b-0 hover:bg-card-2"
                    onClick={() => live && setFinding({ inspection: i, f })}
                  >
                    <td className="px-5 py-3">
                      <div className="font-semibold">{f.title}</div>
                      {f.photoFileIds.length ? (
                        <div
                          className="mt-1.5 flex flex-wrap gap-1.5"
                          // A photo opens on its own, not the finding.
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`finding-photos-${f.id}`}
                        >
                          {f.photoFileIds.map((id, n) => (
                            <Thumb key={id} file={fileById.get(id)} alt={`Photo ${n + 1}`} />
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">{f.location ?? '—'}</td>
                    <td className="px-3 py-3">
                      <Badge
                        variant={
                          f.severity === 'safety'
                            ? 'danger'
                            : f.severity === 'repair'
                              ? 'pending'
                              : 'gray'
                        }
                      >
                        {FINDING_SEVERITIES[f.severity]}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      {f.estimateCents !== null ? money(f.estimateCents) : '—'}
                    </td>
                    <td className="px-3 py-3">
                      {f.clientPriority ? CLIENT_PRIORITIES[f.clientPriority] : 'Not said'}
                    </td>
                    <td className={f.ask === 'not_asked' ? 'px-5 py-3 text-text-3' : 'px-5 py-3'}>
                      {FINDING_ASKS[f.ask]}
                      {f.ask === 'credit' && f.creditCents ? ` · ${money(f.creditCents)}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : null}
        <Card className="p-4 md:p-5" data-testid="repair-request">
          <CardHead
            title={listing ? 'The buyers’ repair request' : 'Repair request'}
            action={
              last ? (
                <Badge variant={last.outcome === 'agreed' ? 'ok' : 'pending'}>
                  {last.side === asked && !last.outcome
                    ? `${listing ? 'Request' : 'Version'} ${last.number} ${listing ? 'came in' : 'sent'} ${day(dateOf(last.at, timeZone))}${last.respondBy ? ` · answer due ${day(dateOf(last.respondBy, timeZone))}` : ''}`
                    : last.outcome
                      ? outcomeWords(last.outcome)
                      : 'Answered'}
                </Badge>
              ) : null
            }
          />
          {data.repairs.length === 0 ? (
            <p className="text-[13.5px] text-text-2">
              {listing
                ? 'When the buyers send their repair request, keep it here as it came in; then your seller’s answer.'
                : data.draft.items
                  ? `Ready to draft from ${data.draft.items} ${data.draft.items === 1 ? 'finding' : 'findings'}${data.draft.creditCents ? `, with ${money(data.draft.creditCents)} in credits` : ''}. You’ll edit it before it’s kept.`
                  : 'Add what the inspections found, with what to ask for, and it drafts itself from them.'}
            </p>
          ) : (
            <ol className="space-y-3">
              {data.repairs.map((r) => (
                <li key={r.id} className="text-[13.5px]">
                  <div className="font-medium">
                    {listing
                      ? r.side === 'them'
                        ? `The buyers’ request, version ${r.number}`
                        : 'Our answer'
                      : r.side === 'us'
                        ? `Our request, version ${r.number}`
                        : 'The seller’s answer'}{' '}
                    · {day(dateOf(r.at, timeZone))}
                    {r.creditCents ? ` · ${money(r.creditCents)} credit` : ''}
                    {r.outcome
                      ? ` · ${r.outcome === 'agreed' ? 'Agreed' : r.outcome === 'refused' ? 'Refused' : 'Countered'}`
                      : ''}
                  </div>
                  <p className="whitespace-pre-wrap text-text-2">{r.words}</p>
                </li>
              ))}
            </ol>
          )}
          {live && last && last.side === asked && !last.outcome ? (
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={() => setAnswering(true)}
              data-testid="repair-answer"
            >
              {listing ? 'Record your seller’s answer' : 'Record the seller’s answer'}
            </Button>
          ) : null}
          <p className="mt-2 text-[12.5px] text-text-3">
            {listing
              ? 'Each request and your seller’s answer are kept.'
              : 'Each version and the seller’s answer are kept.'}
          </p>
        </Card>
      </div>
      {adding ? (
        <AddInspectionDialog
          onClose={() => setAdding(false)}
          workspaceId={workspaceId}
          dealId={dealId}
          timeZone={timeZone}
        />
      ) : null}
      {reportFor ? (
        <ReportDialog
          inspection={reportFor}
          onClose={() => setReportFor(null)}
          workspaceId={workspaceId}
          documents={documents}
        />
      ) : null}
      {finding ? (
        <FindingDialog
          inspection={finding.inspection}
          finding={finding.f}
          onClose={() => setFinding(null)}
          workspaceId={workspaceId}
          who={who}
        />
      ) : null}
      {sending ? (
        <RepairDialog
          draft={last?.side === 'them' ? last.words : data.draft.words}
          onClose={() => setSending(false)}
          workspaceId={workspaceId}
          dealId={dealId}
          timeZone={timeZone}
        />
      ) : null}
      {answering ? (
        <AnswerRepairDialog
          onClose={() => setAnswering(false)}
          workspaceId={workspaceId}
          dealId={dealId}
          listing={listing}
        />
      ) : null}
      {receiving ? (
        <ReceiveRepairDialog
          onClose={() => setReceiving(false)}
          workspaceId={workspaceId}
          dealId={dealId}
          timeZone={timeZone}
          documents={documents}
        />
      ) : null}
      <ReasonDialog
        open={!!canceling}
        onOpenChange={(o) => !o && setCanceling(null)}
        title={`Cancel the ${canceling?.label.toLowerCase() ?? 'inspection'}?`}
        description="It’s kept in the deal’s history, with what it found."
        submit="Cancel it"
        danger
        done="Canceled."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.inspection.cancel', {
              body: { workspaceId, inspectionId: canceling!.id, reason },
            }),
          )
        }
      />
    </div>
  );
}

function AddInspectionDialog({
  onClose,
  workspaceId,
  dealId,
  timeZone,
}: {
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  timeZone: string;
}) {
  const [kind, setKind] = useState<InspectionKind>('general');
  const [inspector, setInspector] = useState('');
  const [at, setAt] = useState('');
  const [expected, setExpected] = useState('');
  const { busy, errors, act } = useAct(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add an inspection">
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'add',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.inspection.add', {
                    body: {
                      workspaceId,
                      dealId,
                      kind,
                      inspector: inspector.trim() || undefined,
                      scheduledAt: at
                        ? new Date(
                            localInstant(at.slice(0, 10), at.slice(11, 16), timeZone),
                          ).toISOString()
                        : undefined,
                      reportExpectedOn: expected || undefined,
                    },
                  }),
                ),
              'Added.',
            );
          }}
        >
          <Field label="What kind" htmlFor="insp-kind" className="sm:col-span-2">
            <Select
              id="insp-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as InspectionKind)}
            >
              {INSPECTION_KIND_KEYS.map((k) => (
                <option key={k} value={k}>
                  {INSPECTION_KINDS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Inspector" htmlFor="insp-who" className="sm:col-span-2">
            <Input id="insp-who" value={inspector} onChange={(e) => setInspector(e.target.value)} />
          </Field>
          <Field label="When" htmlFor="insp-at" error={errors.scheduledAt}>
            <Input
              id="insp-at"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </Field>
          <Field label="Report expected" htmlFor="insp-exp" error={errors.reportExpectedOn}>
            <Input
              id="insp-exp"
              type="date"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'add'}>
              Add it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReportDialog({
  inspection,
  onClose,
  workspaceId,
  documents,
}: {
  inspection: Inspection;
  onClose: () => void;
  workspaceId: string;
  documents: readonly DealDocument[];
}) {
  const usable = documents.filter((d) => d.status !== 'void' && d.status !== 'superseded');
  const [doc, setDoc] = useState(
    usable.find((d) => d.kind === 'inspection_report')?.documentId ?? '',
  );
  const [pages, setPages] = useState('');
  const { busy, act } = useAct(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`The ${inspection.label.toLowerCase()} report is in`}
        description="Pick the report from the deal’s documents, once it’s uploaded there."
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'report',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.inspection.report_in', {
                    body: {
                      workspaceId,
                      inspectionId: inspection.id,
                      documentId: doc || undefined,
                      pages: pages.trim() ? Number(pages) : undefined,
                    },
                  }),
                ),
              'Marked in.',
            );
          }}
        >
          <Field label="The report" htmlFor="rep-doc">
            <Select id="rep-doc" value={doc} onChange={(e) => setDoc(e.target.value)}>
              <option value="">Not uploaded yet</option>
              {usable.map((d) => (
                <option key={d.documentId} value={d.documentId}>
                  {d.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pages (optional)" htmlFor="rep-pages">
            <Input
              id="rep-pages"
              inputMode="numeric"
              value={pages}
              onChange={(e) => setPages(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'report'}>
              It’s in
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FindingDialog({
  inspection,
  finding: f,
  onClose,
  workspaceId,
  who,
}: {
  inspection: Inspection;
  finding: Finding | null;
  onClose: () => void;
  workspaceId: string;
  who: string;
}) {
  const [title, setTitle] = useState(f?.title ?? '');
  const [location, setLocation] = useState(f?.location ?? '');
  const [severity, setSeverity] = useState<FindingSeverity>(f?.severity ?? 'repair');
  const [estimate, setEstimate] = useState(f?.estimateCents ? String(f.estimateCents / 100) : '');
  const [priority, setPriority] = useState<ClientPriority | ''>(f?.clientPriority ?? '');
  const [ask, setAsk] = useState<FindingAsk>(f?.ask ?? 'repair');
  const [credit, setCredit] = useState(f?.creditCents ? String(f.creditCents / 100) : '');
  const { busy, errors, act } = useAct(onClose);
  const fields = {
    title,
    location: location.trim() || null,
    severity,
    estimateCents: estimate.trim() ? parseMoney(estimate) : null,
    clientPriority: priority || null,
    ask,
    creditCents: ask === 'credit' && credit.trim() ? parseMoney(credit) : null,
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={f ? f.title : 'Add a finding'}
        description={`From the ${inspection.label.toLowerCase()}.`}
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'save',
              async () =>
                f
                  ? unwrap(
                      await apiBrowser().POST('/v1/commands/realestate.finding.update', {
                        body: { workspaceId, findingId: f.id, ...fields },
                      }),
                    )
                  : unwrap(
                      await apiBrowser().POST('/v1/commands/realestate.finding.add', {
                        body: { workspaceId, inspectionId: inspection.id, ...fields },
                      }),
                    ),
              f ? 'Saved.' : 'Added.',
            );
          }}
        >
          <Field
            label="What was found"
            htmlFor="fd-title"
            error={errors.title}
            className="sm:col-span-2"
          >
            <Input
              id="fd-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus={!f}
            />
          </Field>
          <Field label="Where" htmlFor="fd-where">
            <Input id="fd-where" value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Field label="Estimate" htmlFor="fd-est" error={errors.estimateCents}>
            <Input
              id="fd-est"
              inputMode="decimal"
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              placeholder="$"
            />
          </Field>
          <div className="sm:col-span-2">
            <div className="mb-1.5 text-[13px] font-medium">How serious</div>
            <Segmented
              value={severity}
              onChange={setSeverity}
              ariaLabel="How serious"
              options={FINDING_SEVERITY_KEYS.map((k) => ({
                value: k,
                label: FINDING_SEVERITIES[k],
              }))}
            />
          </div>
          <Field label={`${who}’s priority`} htmlFor="fd-pri">
            <Select
              id="fd-pri"
              value={priority}
              onChange={(e) => setPriority(e.target.value as ClientPriority | '')}
            >
              <option value="">Not said yet</option>
              {CLIENT_PRIORITY_KEYS.map((k) => (
                <option key={k} value={k}>
                  {CLIENT_PRIORITIES[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ask for" htmlFor="fd-ask">
            <Select id="fd-ask" value={ask} onChange={(e) => setAsk(e.target.value as FindingAsk)}>
              {FINDING_ASK_KEYS.map((k) => (
                <option key={k} value={k}>
                  {FINDING_ASKS[k]}
                </option>
              ))}
            </Select>
          </Field>
          {ask === 'credit' ? (
            <Field
              label="Credit"
              htmlFor="fd-credit"
              hint="The estimate when left empty."
              error={errors.creditCents}
            >
              <Input
                id="fd-credit"
                inputMode="decimal"
                value={credit}
                onChange={(e) => setCredit(e.target.value)}
                placeholder="$"
              />
            </Field>
          ) : null}
          <div className="flex items-center justify-between gap-2 sm:col-span-2">
            {f ? (
              <Button
                variant="ghost"
                className="text-danger-text"
                loading={busy === 'remove'}
                onClick={() =>
                  void act(
                    'remove',
                    async () =>
                      unwrap(
                        await apiBrowser().POST('/v1/commands/realestate.finding.remove', {
                          body: { workspaceId, findingId: f.id },
                        }),
                      ),
                    'Taken off.',
                  )
                }
              >
                Take it off
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === 'save'}>
                {f ? 'Save' : 'Add it'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RepairDialog({
  draft,
  onClose,
  workspaceId,
  dealId,
  timeZone,
}: {
  draft: string;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  timeZone: string;
}) {
  const [words, setWords] = useState(draft);
  const [due, setDue] = useState('');
  const { busy, errors, act } = useAct(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="The repair request"
        description="Drafted from the findings, must-fixes first. Edit it to say exactly what you’re sending."
        className="w-[min(640px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'send',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.repair.send', {
                    body: {
                      workspaceId,
                      dealId,
                      words,
                      respondBy: due
                        ? new Date(
                            localInstant(due.slice(0, 10), due.slice(11, 16), timeZone),
                          ).toISOString()
                        : null,
                    },
                  }),
                ),
              'Kept as sent.',
            );
          }}
        >
          <Field label="The request" htmlFor="rr-words" error={errors.words}>
            <Textarea
              id="rr-words"
              rows={8}
              value={words}
              onChange={(e) => setWords(e.target.value)}
            />
          </Field>
          <Field label="Answer due by (optional)" htmlFor="rr-due">
            <Input
              id="rr-due"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'send'} data-testid="repair-send">
              Keep it as sent
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** On a listing: the buyers' repair request, kept as it came in. */
function ReceiveRepairDialog({
  onClose,
  workspaceId,
  dealId,
  timeZone,
  documents,
}: {
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  timeZone: string;
  documents: readonly DealDocument[];
}) {
  const [words, setWords] = useState('');
  const [credit, setCredit] = useState('');
  const [due, setDue] = useState('');
  const [documentId, setDocumentId] = useState('');
  const { busy, errors, act } = useAct(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="The buyers’ repair request"
        description="Type in what they ask for, as it came in. It brings the duties for answering it."
        className="w-[min(640px,calc(100vw-32px))]"
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'receive',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.repair.receive', {
                    body: {
                      workspaceId,
                      dealId,
                      words,
                      creditCents: credit.trim() ? (parseMoney(credit) ?? undefined) : undefined,
                      respondBy: due
                        ? new Date(
                            localInstant(due.slice(0, 10), due.slice(11, 16), timeZone),
                          ).toISOString()
                        : null,
                      documentId: documentId || undefined,
                    },
                  }),
                ),
              'Kept as it came in.',
            );
          }}
        >
          <Field label="What they ask for" htmlFor="rq-words" error={errors.words}>
            <Textarea
              id="rq-words"
              rows={6}
              value={words}
              onChange={(e) => setWords(e.target.value)}
              data-testid="repair-receive-words"
            />
          </Field>
          <Field label="Credit they ask for (optional)" htmlFor="rq-credit">
            <Input
              id="rq-credit"
              inputMode="decimal"
              value={credit}
              onChange={(e) => setCredit(e.target.value)}
              placeholder="$"
            />
          </Field>
          <Field label="Answer due by (optional)" htmlFor="rq-due">
            <Input
              id="rq-due"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </Field>
          <Field
            label="Their request, uploaded (optional)"
            htmlFor="rq-doc"
            hint="Upload it under Documents, then pick it here."
          >
            <Select id="rq-doc" value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
              <option value="">Not uploaded</option>
              {documents
                .filter((d) => d.status !== 'void' && d.status !== 'superseded')
                .map((d) => (
                  <option key={d.documentId} value={d.documentId}>
                    {d.title}
                  </option>
                ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'receive'} data-testid="repair-receive-save">
              Keep it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AnswerRepairDialog({
  onClose,
  workspaceId,
  dealId,
  listing = false,
}: {
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  listing?: boolean;
}) {
  const [outcome, setOutcome] = useState<'agreed' | 'countered' | 'refused'>('agreed');
  const [words, setWords] = useState('');
  const [credit, setCredit] = useState('');
  const { busy, errors, act } = useAct(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={listing ? 'Your seller’s answer' : 'The seller’s answer'}
        description={
          listing
            ? 'What your seller will do about the buyers’ request, as you’re sending it.'
            : undefined
        }
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'answer',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.repair.record_answer', {
                    body: {
                      workspaceId,
                      dealId,
                      outcome,
                      words,
                      creditCents: credit.trim() ? (parseMoney(credit) ?? undefined) : undefined,
                    },
                  }),
                ),
              outcome === 'agreed' ? 'Kept. The repairs agreed are duties now.' : 'Kept.',
            );
          }}
        >
          <Segmented
            value={outcome}
            onChange={setOutcome}
            ariaLabel={listing ? 'Your seller’s answer' : 'Their answer'}
            options={[
              { value: 'agreed', label: 'Agreed' },
              { value: 'countered', label: 'Countered' },
              { value: 'refused', label: 'Refused' },
            ]}
          />
          <Field label="What they’ll do" htmlFor="ra-words" error={errors.words}>
            <Textarea
              id="ra-words"
              rows={4}
              value={words}
              onChange={(e) => setWords(e.target.value)}
            />
          </Field>
          <Field label="Credit (optional)" htmlFor="ra-credit">
            <Input
              id="ra-credit"
              inputMode="decimal"
              value={credit}
              onChange={(e) => setCredit(e.target.value)}
              placeholder="$"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'answer'}>
              Keep it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
