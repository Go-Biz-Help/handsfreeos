'use client';
/**
 * A job's daily reports (docs/contractor.md, "The AI helpers"): what got done each day, what needs a look, the
 * materials, what's next and who was on the clock, written by the AI from the day's notes from the field, their
 * photos and the checklist items ticked. One per day, the newest first and open.
 *
 * - **Written on its own each evening** when the business has that on (Settings → AI helpers), or now with
 *   Write today's report. Both ask the worker (`contractor.report.write`).
 * - **A report someone changed is theirs:** it isn't written over unless they say Write it again.
 * - **The customer's update goes only when a person sends it** (the owner's rule: the AI prepares, people approve
 *   what reaches a customer), once, by email or text, through HandsFreeOS's own messages.
 *
 * A report holds hours and never what they cost, so everyone who uses the add-on reads it.
 */
import { REPORT_LIMITS, reportDayWords } from '@hfos/core/addons/contractor/daily-report';
import { CONTRACTOR_WORDS, hoursWords } from '@hfos/core/addons/contractor/words';
import { formatDate } from '@hfos/core';
import { Camera, ChevronDown, ChevronRight, MoreHorizontal, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { jobRecordHref } from './bits';
import { ConfirmDialog } from './job-dialogs';
import type { DailyReport, ReportList } from './types';
import { useAct } from './use-act';

const R = CONTRACTOR_WORDS.reports;
/** How many reports show before "Show all". */
const FIRST = 3;

const linesOf = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export function DailyReportsCard({
  workspaceId,
  jobId,
  reports,
  timeZone,
}: {
  workspaceId: string;
  jobId: string;
  reports: ReportList;
  timeZone: string;
}) {
  const list = reports.reports;
  const [all, setAll] = useState(false);
  // The newest report starts open; pressing a day opens it and closes the one that was.
  const [open, setOpen] = useState<string | null>(list[0]?.id ?? null);
  const [editing, setEditing] = useState<DailyReport | null>(null);
  const [sending, setSending] = useState<DailyReport | null>(null);
  const [again, setAgain] = useState<DailyReport | null>(null);
  const { busy, act } = useAct();
  const shown = all ? list : list.slice(0, FIRST);
  const names = new Map(reports.files.map((f) => [f.id, f.name]));
  // A file of the job's opens on core's page for its record.
  const fileHref = (fileId: string) => `${jobRecordHref(workspaceId, jobId)}?file=${fileId}`;
  /** Asks the worker to write a day's report: the AI reads that day's notes, photos, ticks and hours. */
  const write = (day: string | undefined, replace: boolean) =>
    workerPost<{ reportId: string }>('/v1/addons/contractor/actions/contractor.report.write', {
      workspaceId,
      input: { jobId, ...(day ? { day } : {}), ...(replace ? { replace: true } : {}) },
    });
  return (
    <Card className="p-0" data-testid="reports-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{R.title}</h2>
          <p className="text-[12.5px] text-text-3">{reports.onItsOwn ? R.hintOn : R.hintOff}</p>
        </div>
        {reports.canChange ? (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'write'}
            onClick={() =>
              void act(
                'write',
                async () => {
                  const out = await write(undefined, false);
                  setOpen(out.reportId);
                },
                R.written,
              )
            }
            data-testid="report-write"
          >
            <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
            {R.write}
          </Button>
        ) : null}
      </div>
      {busy === 'write' || busy?.startsWith('again:') ? (
        <p
          className="border-b border-border px-5 py-2.5 text-[12.5px] text-text-2"
          role="status"
          data-testid="report-writing"
        >
          {R.writing}
        </p>
      ) : null}
      {list.length === 0 ? (
        <p className="px-5 py-4 text-[13.5px] text-text-2" data-testid="reports-none">
          {R.none}
        </p>
      ) : (
        <ul>
          {shown.map((r) => {
            const isOpen = open === r.id;
            const Chevron = isOpen ? ChevronDown : ChevronRight;
            return (
              <li
                key={r.id}
                className="border-b border-border last:border-b-0"
                data-testid="report"
              >
                <div className="flex items-start gap-2 px-5 py-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : r.id)}
                    data-testid="report-day"
                  >
                    <Chevron className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-medium">
                        {reportDayWords(r.day)}
                        {r.day === reports.today ? <Badge variant="gray">{R.today}</Badge> : null}
                        {r.sent ? <Badge variant="ok">{R.sentShort}</Badge> : null}
                      </span>
                      <span className="mt-0.5 block text-[12.5px] text-text-3">
                        {[
                          `${R.byAi} ${R.from(r.notesRead, r.photosRead)}`,
                          r.edited ? R.changedBy(r.edited.by) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {isOpen ? null : (
                        <span className="mt-1 line-clamp-2 block text-[13.5px] text-text-2">
                          {r.summary}
                        </span>
                      )}
                    </span>
                  </button>
                  {reports.canChange ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="rounded p-1.5 text-text-3 hover:bg-card-2 hover:text-text"
                          aria-label={R.menu}
                          data-testid="report-menu"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onSelect={() => setEditing(r)}>{R.edit}</DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            // Someone's own words are only replaced once they've said so.
                            if (r.edited) setAgain(r);
                            else
                              void act(`again:${r.id}`, async () => write(r.day, false), R.written);
                          }}
                        >
                          {R.writeAgain}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                {isOpen ? (
                  <div className="space-y-3 px-5 pb-4 pl-11 text-[14px]" data-testid="report-body">
                    <p className="whitespace-pre-wrap break-words" data-testid="report-summary">
                      {r.summary}
                    </p>
                    <Points title={R.done} list={r.done} testId="report-done" />
                    <Points title={R.issues} list={r.issues} testId="report-issues" />
                    <Points title={R.materials} list={r.materials} testId="report-materials" />
                    <Points title={R.next} list={r.next} testId="report-next" />
                    {r.crew.length ? (
                      <Part title={R.crew} testId="report-crew">
                        <p className="text-text-2">
                          {r.crew.map((c) => `${c.name}, ${hoursWords(c.hours)}`).join(' · ')}
                        </p>
                      </Part>
                    ) : null}
                    {r.photoFileIds.length ? (
                      <Part title={R.photos} testId="report-photos">
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          {r.photoFileIds.map((fileId, i) => (
                            <Link
                              key={fileId}
                              href={fileHref(fileId)}
                              className="inline-flex items-center gap-1 text-[13px] font-medium text-accent-text hover:underline"
                              title={names.get(fileId)}
                            >
                              <Camera className="h-3.5 w-3.5" strokeWidth={1.75} />
                              {R.photo(i + 1)}
                            </Link>
                          ))}
                        </div>
                      </Part>
                    ) : null}
                    <div
                      className="rounded-menu border border-border bg-card-2/50 px-3.5 py-3"
                      data-testid="report-for-customer"
                    >
                      <h3 className="text-[12px] font-medium uppercase tracking-wide text-text-3">
                        {R.forCustomer}
                      </h3>
                      {r.forCustomer ? (
                        <p className="mt-1 whitespace-pre-wrap break-words">{r.forCustomer}</p>
                      ) : (
                        <p className="mt-1 text-[13.5px] text-text-2">{R.noCustomerText}</p>
                      )}
                      {r.sent ? (
                        <p className="mt-2 text-[12.5px] text-text-3" data-testid="report-sent">
                          {R.sentBy(
                            r.sent.channel,
                            r.sent.by,
                            formatDate(r.sent.at, { time: true, timeZone }),
                          )}
                        </p>
                      ) : !reports.customer ? (
                        <p className="mt-2 text-[12.5px] text-text-3">{R.noCustomer}</p>
                      ) : r.forCustomer && reports.canChange ? (
                        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setSending(r)}
                            data-testid="report-send"
                          >
                            {R.send(reports.customer.name)}
                          </Button>
                          <span className="text-[12.5px] text-text-3">{R.forCustomerHint}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {list.length > FIRST || reports.truncated ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5 text-[12.5px] text-text-2">
          {list.length > FIRST ? (
            <button
              type="button"
              className="hover:text-text hover:underline"
              onClick={() => setAll(!all)}
              data-testid="reports-show-all"
            >
              {all ? R.showFewer : R.showAll(list.length)}
            </button>
          ) : null}
          {reports.truncated && all ? <span>{R.truncated(list.length)}</span> : null}
        </div>
      ) : null}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={R.editTitle} description={editing ? reportDayWords(editing.day) : ''}>
          {editing ? (
            <ReportForm
              workspaceId={workspaceId}
              report={editing}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      {sending && reports.customer ? (
        <SendDialog
          workspaceId={workspaceId}
          report={sending}
          customer={reports.customer}
          onClose={() => setSending(null)}
        />
      ) : null}
      <ConfirmDialog
        open={again !== null}
        onOpenChange={(o) => !o && setAgain(null)}
        title={R.againTitle}
        description={R.againAsk(again?.edited?.by ?? null)}
        submit={R.againGo}
        done={R.written}
        run={async () => again && write(again.day, true)}
      />
    </Card>
  );
}

function Part({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId}>
      <h3 className="text-[12px] font-medium uppercase tracking-wide text-text-3">{title}</h3>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Points({
  title,
  list,
  testId,
}: {
  title: string;
  list: readonly string[];
  testId: string;
}) {
  if (list.length === 0) return null;
  return (
    <Part title={title} testId={testId}>
      <ul className="list-disc space-y-0.5 pl-5">
        {list.map((p, i) => (
          // The same words can be on a report twice, so the place is part of the key.
          <li key={`${i}:${p}`} className="break-words">
            {p}
          </li>
        ))}
      </ul>
    </Part>
  );
}

/** Changing a report's words. Saving makes it the person's: it isn't written over on its own after that. */
function ReportForm({
  workspaceId,
  report,
  onClose,
}: {
  workspaceId: string;
  report: DailyReport;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState(report.summary);
  const [done, setDone] = useState(report.done.join('\n'));
  const [issues, setIssues] = useState(report.issues.join('\n'));
  const [materials, setMaterials] = useState(report.materials.join('\n'));
  const [next, setNext] = useState(report.next.join('\n'));
  const [forCustomer, setForCustomer] = useState(report.forCustomer ?? '');
  const { busy, errors, act } = useAct(onClose);
  const part = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    error: string | undefined,
  ) => (
    <Field
      label={label}
      htmlFor={`report-${id}`}
      hint={R.onePerLine}
      error={error}
      className="mt-3"
    >
      <Textarea
        id={`report-${id}`}
        rows={3}
        value={value}
        onChange={(e) => set(e.target.value)}
        data-testid={`report-${id}-input`}
      />
    </Field>
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          'save',
          async () =>
            unwrap(
              await apiBrowser().POST('/v1/commands/contractor.report.update', {
                body: {
                  workspaceId,
                  reportId: report.id,
                  summary: summary.trim(),
                  done: linesOf(done),
                  issues: linesOf(issues),
                  materials: linesOf(materials),
                  next: linesOf(next),
                  forCustomer: forCustomer.trim() || null,
                },
              }),
            ),
          R.saved,
        );
      }}
    >
      <Field label={R.summary} htmlFor="report-summary" error={errors.summary}>
        <Textarea
          id="report-summary"
          rows={4}
          value={summary}
          maxLength={REPORT_LIMITS.summary}
          onChange={(e) => setSummary(e.target.value)}
          autoFocus
          data-testid="report-summary-input"
        />
      </Field>
      {part('done', R.done, done, setDone, errors.done)}
      {part('issues', R.issues, issues, setIssues, errors.issues)}
      {part('materials', R.materials, materials, setMaterials, errors.materials)}
      {part('next', R.next, next, setNext, errors.next)}
      <Field
        label={R.forCustomer}
        htmlFor="report-for-customer"
        hint={report.sent ? undefined : R.forCustomerHint}
        error={errors.forCustomer}
        className="mt-3"
      >
        <Textarea
          id="report-for-customer"
          rows={4}
          value={forCustomer}
          maxLength={REPORT_LIMITS.forCustomer}
          // What already went to the customer stays as it went.
          disabled={!!report.sent}
          onChange={(e) => setForCustomer(e.target.value)}
          data-testid="report-for-customer-input"
        />
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {R.cancel}
        </Button>
        <Button
          type="submit"
          loading={busy === 'save'}
          disabled={!summary.trim()}
          data-testid="report-save"
        >
          {R.save}
        </Button>
      </div>
    </form>
  );
}

/** Sending the customer the day's update: only that, by email or text, once a person presses Send it. */
function SendDialog({
  workspaceId,
  report,
  customer,
  onClose,
}: {
  workspaceId: string;
  report: DailyReport;
  customer: NonNullable<ReportList['customer']>;
  onClose: () => void;
}) {
  const [channel, setChannel] = useState<'email' | 'sms'>(
    customer.email || !customer.sms ? 'email' : 'sms',
  );
  const [body, setBody] = useState(report.forCustomer ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Said once, in quiet hours: the next press sends anyway. */
  const [quiet, setQuiet] = useState(false);
  const { act } = useAct();
  const text = body.trim();
  const reachable = channel === 'email' ? customer.email : customer.sms;
  async function send() {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/contractor.report.send', {
          body: {
            workspaceId,
            reportId: report.id,
            channel,
            // What's sent is kept as the report's update, so only a change is sent along.
            ...(text !== (report.forCustomer ?? '').trim() ? { body: text } : {}),
            acknowledgeQuietHours: quiet,
          },
        }),
      );
      toast.success(R.sent);
      // Draws the page again, so the report shows it was sent.
      void act('sent', async () => undefined);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'quiet_hours' && !quiet) {
        setQuiet(true);
        setError(`${e.message} ${R.quietAgain}`);
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={R.sendTitle(customer.name)} description={R.sendHint}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && text && reachable) void send();
          }}
        >
          <Field label={R.sendBy} htmlFor="report-send-channel">
            <Select
              id="report-send-channel"
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value === 'sms' ? 'sms' : 'email');
                setQuiet(false);
                setError(null);
              }}
              data-testid="report-send-channel"
            >
              <option value="email" disabled={!customer.email}>
                {customer.email ? R.email : `${R.email} (${R.noEmail.toLowerCase()})`}
              </option>
              <option value="sms" disabled={!customer.sms}>
                {customer.sms ? R.sms : `${R.sms} (${R.noPhone.toLowerCase()})`}
              </option>
            </Select>
          </Field>
          <Field label={R.whatToSend} htmlFor="report-send-body" className="mt-3">
            <Textarea
              id="report-send-body"
              rows={6}
              value={body}
              maxLength={REPORT_LIMITS.forCustomer}
              onChange={(e) => setBody(e.target.value)}
              data-testid="report-send-body"
            />
          </Field>
          {error ? (
            <p
              className="mt-3 rounded-menu bg-danger-soft px-3 py-2.5 text-[13px] leading-[1.45] text-danger-text"
              role="alert"
              data-testid="report-send-error"
            >
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {R.cancel}
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={!text || !reachable}
              data-testid="report-send-go"
            >
              {R.sendGo}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
