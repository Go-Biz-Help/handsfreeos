/**
 * A job's daily reports (docs/contractor.md, "The AI helpers"): one per job per day, written by the AI from what
 * the crew left that day: their typed and voice notes, their photos, the checklist items they ticked and who was on
 * the clock. The worker asks the AI (apps/worker/src/addons/contractor/reports.ts) and keeps what comes back here.
 *
 * - **The report is the office's own record**, so it's written without asking: on its own the evening of a day
 *   with notes or photos (the business can turn that off), or when someone presses Write.
 * - **A person's words win.** Once someone changes a report it's theirs: the AI never writes over it, unless that
 *   person asks for it to be written again.
 * - **The customer's update goes only when a person sends it** (the owner's rule: the AI prepares, people approve
 *   what reaches a customer), through core's own send (`message.send`), so consent, quiet hours, who may message
 *   customers and the conversation are all core's.
 * - **No money.** A report holds hours and never what they cost, so everyone who uses the add-on reads it.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { fmtTime } from '../../../calendar/when';
import { messageSend } from '../../../commands/message';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { executeCommandWithin } from '../../../kernel/execute';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { checkedReport, REPORT_LIMITS, reportDayWords } from '../daily-report';
import { contractorAddon } from '../manifest';
import { todayIn } from '../progress';
import {
  ReportChangeOutput,
  ReportKeepInput,
  ReportKeepOutput,
  ReportListInput,
  ReportListOutput,
  ReportSendInput,
  ReportSendOutput,
  ReportSourceInput,
  ReportSourceOutput,
  ReportUpdateInput,
} from '../schemas';
import { dailyReports } from '../tables';
import { TRADE_NAMES } from '../trades';
import { CONTRACTOR_WORDS as W, JOB_KIND_WORDS, REFUSALS, VISIT_STATUS_WORDS } from '../words';
import { inWorkspace, jobLine, loadJob, pairsOf, settingsOf, timeZoneOf, type Ctx } from './common';

const jobPath = (jobId: string) => `a/contractor/jobs/${jobId}`;
const pathOf = (io: unknown) => {
  const jobId = (io as { jobId?: unknown } | null)?.jobId;
  return typeof jobId === 'string' ? jobPath(jobId) : 'a/contractor';
};
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** The job's customer, as a report's update needs them: who, and how they can be reached. */
async function customerOf(ctx: Ctx, jobId: string) {
  const pair = (await pairsOf(ctx, jobId)).customer;
  if (!pair) return null;
  const [p] = await rows<{
    id: string;
    name: string;
    first_name: string | null;
    email: boolean;
    sms: boolean;
  }>(
    ctx.tx,
    sql`select id, nullif(btrim(first_name), '') as first_name,
          coalesce(nullif(btrim(concat_ws(' ', first_name, last_name)), ''), email::text, phone_e164, 'Customer') as name,
          (email is not null) as email, (phone_e164 is not null) as sms
        from app.people
        where id = ${pair.personId} and workspace_id = ${ctx.scope.workspaceId!} and archived_at is null`,
  );
  return p
    ? { personId: p.id, name: p.name, firstName: p.first_name, email: p.email, sms: p.sms }
    : null;
}

// ------------------------------------------------------------------------------------------------ the worker's

export const reportSource = defineAddonQuery(contractorAddon, {
  name: 'contractor.report.source',
  description:
    'Worker: what the AI reads to write one day’s report for a job: the day’s notes with their words, the checklist items ticked, who was on the clock and for how long, the day’s visits and its photos. No money.',
  input: ReportSourceInput,
  output: ReportSourceOutput,
  permission: 'contractor.use',
  actors: ['system'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId);
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const ws = ctx.scope.workspaceId!;
    const zone = await timeZoneOf(ctx);
    const day = input.day ?? todayIn(zone);
    // The day where the business is, as two instants.
    const from = sql`(${day}::date::timestamp at time zone ${zone})`;
    const to = sql`((${day}::date + 1)::timestamp at time zone ${zone})`;
    const [noted, ticked, crew, visits, [business], customer, [existing], settings] =
      await Promise.all([
        rows<{
          body: string | null;
          transcript: string | null;
          transcript_state: string;
          noted_at: Date;
          photo_file_ids: string[];
          by: string | null;
          visit: string | null;
        }>(
          ctx.tx,
          sql`select n.body, n.transcript, n.transcript_state, n.noted_at, n.photo_file_ids,
                coalesce(nullif(btrim(u.full_name), ''), u.email::text) as by, a.title as visit
              from addon_contractor.notes n
              left join app.users u on u.id = n.created_by
              left join app.appointments a on a.id = n.appointment_id
              where n.record_id = ${job.recordId} and n.workspace_id = ${ws}
                and n.noted_at >= ${from} and n.noted_at < ${to}
              order by n.noted_at, n.id
              limit ${REPORT_LIMITS.notes * 2}`,
        ),
        rows<{ label: string; file_id: string | null }>(
          ctx.tx,
          sql`select i.label, i.file_id from addon_contractor.work_order_items i
              where i.record_id = ${job.recordId} and i.workspace_id = ${ws}
                and i.done_at >= ${from} and i.done_at < ${to}
              order by i.done_at, i.id
              limit ${REPORT_LIMITS.ticked * 2}`,
        ),
        // Work and travel inside the day, by person. Time still running counts up to now.
        rows<{ name: string | null; seconds: number }>(
          ctx.tx,
          sql`select coalesce(nullif(btrim(u.full_name), ''), u.email::text) as name,
                sum(greatest(0, extract(epoch from (
                  least(coalesce(t.ended_at, now()), ${to}) - greatest(t.started_at, ${from})))))::float8 as seconds
              from addon_contractor.time_entries t
              left join app.users u on u.id = t.user_id
              where t.record_id = ${job.recordId} and t.workspace_id = ${ws} and t.kind <> 'break'
                and t.started_at < ${to} and coalesce(t.ended_at, now()) > ${from}
              group by t.user_id, u.full_name, u.email
              order by 2 desc`,
        ),
        rows<{ title: string | null; status: string }>(
          ctx.tx,
          sql`select a.title, a.status::text as status from app.appointments a
              where a.custom_record_id = ${job.recordId} and a.workspace_id = ${ws}
                and a.starts_at < ${to} and a.ends_at > ${from}
              order by a.starts_at
              limit 12`,
        ),
        rows<{ name: string }>(ctx.tx, sql`select name from app.workspaces where id = ${ws}`),
        customerOf(ctx, job.recordId),
        ctx.tx
          .select({ id: dailyReports.id, editedAt: dailyReports.editedAt })
          .from(dailyReports)
          .where(
            and(
              eq(dailyReports.workspaceId, ws),
              eq(dailyReports.recordId, job.recordId),
              eq(dailyReports.day, day),
            ),
          ),
        settingsOf(ctx),
      ]);
    const photoFileIds = [
      ...new Set([
        ...noted.flatMap((n) => n.photo_file_ids ?? []),
        ...ticked.map((t) => t.file_id).filter((id): id is string => !!id),
      ]),
    ].slice(0, 60);
    return {
      jobId: job.recordId,
      day,
      job: {
        name: job.name,
        kind: JOB_KIND_WORDS[job.kind],
        trade: job.trade ? TRADE_NAMES[job.trade] : null,
        percentDone: job.percentDone,
        customerFirstName: customer?.firstName ?? null,
      },
      business: business?.name ?? 'The business',
      dayWords: reportDayWords(day),
      notes: noted
        .map((n) => ({
          by: n.by,
          at: fmtTime(new Date(n.noted_at).getTime(), zone),
          visit: n.visit,
          text: (n.body ?? n.transcript ?? '').trim(),
          photos: (n.photo_file_ids ?? []).length,
        }))
        .filter((n) => n.text || n.photos)
        .slice(0, REPORT_LIMITS.notes),
      ticked: ticked.map((t) => t.label).slice(0, REPORT_LIMITS.ticked),
      crew: crew
        .map((c) => ({
          name: c.name ?? W.time.gone,
          hours: Math.round(Number(c.seconds) / 36) / 100,
        }))
        .filter((c) => c.hours > 0),
      visits: visits.map((v) => ({
        title: v.title?.trim() || 'Visit',
        status: VISIT_STATUS_WORDS[v.status] ?? v.status,
      })),
      photoFileIds,
      waitingWords: noted.filter((n) => n.transcript_state === 'waiting').length,
      existing: existing ? { id: existing.id, edited: existing.editedAt !== null } : null,
      onItsOwn: settings.dailyReports,
    };
  },
});

export const reportKeep = defineAddonCommand(contractorAddon, {
  name: 'contractor.report.keep',
  description:
    'Worker: a job’s report for one day, written by the AI from the day’s notes and photos. One a person changed is left as theirs unless they asked for it to be written again.',
  risk: 0,
  input: ReportKeepInput,
  output: ReportKeepOutput,
  permission: 'contractor.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['contractor.report.written'],
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId, { lock: true });
    if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
    const ws = ctx.scope.workspaceId!;
    const body = checkedReport(input.body);
    if (!body) throw HfosError.rule('contractor_report_empty', 409, REFUSALS.reportEmpty);
    const [had] = await ctx.tx
      .select({ id: dailyReports.id, editedAt: dailyReports.editedAt })
      .from(dailyReports)
      .where(
        and(
          eq(dailyReports.workspaceId, ws),
          eq(dailyReports.recordId, job.recordId),
          eq(dailyReports.day, input.day),
        ),
      )
      .for('update');
    if (had?.editedAt && !input.replace)
      return { reportId: had.id, jobId: job.recordId, day: input.day, kept: false };
    const now = new Date();
    const words = {
      summary: body.summary,
      done: [...body.done],
      issues: [...body.issues],
      materials: [...body.materials],
      nextSteps: [...body.next],
      forCustomer: body.forCustomer,
      crew: input.crew.map((c) => ({ name: c.name, hours: c.hours })),
      photoFileIds: [...new Set(input.photoFileIds)],
      notesRead: input.notesRead,
      photosRead: input.photosRead,
      // Who pressed Write: the worker keeps it on their behalf. Null when it wrote the day up on its own.
      askedBy: userIdOf(ctx.actor),
      writtenAt: now,
      editedBy: null,
      editedAt: null,
      updatedAt: now,
    };
    const [kept] = had
      ? await ctx.tx
          .update(dailyReports)
          .set(words)
          .where(eq(dailyReports.id, had.id))
          .returning({ id: dailyReports.id })
      : await ctx.tx
          .insert(dailyReports)
          .values({ workspaceId: ws, recordId: job.recordId, day: input.day, ...words })
          .returning({ id: dailyReports.id });
    const eventId = await ctx.emit({
      type: 'contractor.report.written',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { reportId: kept!.id, jobId: job.recordId, day: input.day, again: !!had },
    });
    // Written again is the same report: the timeline says it once.
    if (!had)
      await jobLine(ctx, job.recordId, `wrote the daily report for ${reportDayWords(input.day)}`, {
        eventId,
        body: clip(body.summary, 400),
      });
    return { reportId: kept!.id, jobId: job.recordId, day: input.day, kept: true };
  },
});

// ------------------------------------------------------------------------------------------------ people's

export const reportList = defineAddonQuery(contractorAddon, {
  name: 'contractor.report.list',
  description:
    'A job’s daily reports, the newest day first: what happened, what got done, what went wrong or needs a decision, materials, what’s next, who worked how long, the day’s photos, and the update written for the customer with whether it was sent.',
  input: ReportListInput,
  output: ReportListOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_reports',
    description:
      'A job’s daily reports (by job id), the newest day first: each with its report id, day, summary, what got done, issues, materials, what’s next, the crew’s hours (never what they cost), its photos’ file ids, the update written for the customer (forCustomer) and whether someone sent it, and whether a person changed its words. Also who a customer’s update would go to and how they can be reached.',
    keywords: ['daily report', 'job report', 'what happened today', 'site report', 'daily log'],
  },
  async handler(ctx, input) {
    const job = await loadJob(ctx, input.jobId);
    const ws = ctx.scope.workspaceId!;
    const [found, zone, settings, customer] = await Promise.all([
      rows<{
        id: string;
        day: string;
        summary: string;
        done: string[];
        issues: string[];
        materials: string[];
        next_steps: string[];
        for_customer: string | null;
        crew: { name: string; hours: number }[];
        photo_file_ids: string[];
        notes_read: number;
        photos_read: number;
        written_at: Date;
        asked: string | null;
        edited_at: Date | null;
        edited: string | null;
        sent_at: Date | null;
        sent: string | null;
        sent_channel: 'email' | 'sms' | null;
      }>(
        ctx.tx,
        sql`select r.id, r.day::text as day, r.summary, r.done, r.issues, r.materials, r.next_steps, r.for_customer,
              r.crew, r.photo_file_ids, r.notes_read, r.photos_read, r.written_at,
              coalesce(nullif(btrim(a.full_name), ''), a.email::text) as asked,
              r.edited_at, coalesce(nullif(btrim(e.full_name), ''), e.email::text) as edited,
              r.sent_at, coalesce(nullif(btrim(s.full_name), ''), s.email::text) as sent, r.sent_channel
            from addon_contractor.daily_reports r
            left join app.users a on a.id = r.asked_by
            left join app.users e on e.id = r.edited_by
            left join app.users s on s.id = r.sent_by
            where r.record_id = ${job.recordId} and r.workspace_id = ${ws}
            order by r.day desc
            limit ${REPORT_LIMITS.list + 1}`,
      ),
      timeZoneOf(ctx),
      settingsOf(ctx),
      customerOf(ctx, job.recordId),
    ]);
    const list = found.slice(0, REPORT_LIMITS.list);
    const fileIds = [...new Set(list.flatMap((r) => r.photo_file_ids ?? []))];
    const files = fileIds.length
      ? await rows<{ id: string; name: string }>(
          ctx.tx,
          sql`select id, name from app.files
              where workspace_id = ${ws} and id = any(${`{${fileIds.join(',')}}`}::uuid[]) and deleted_at is null`,
        )
      : [];
    const here = new Set(files.map((f) => f.id));
    return {
      jobId: job.recordId,
      reports: list.map((r) => ({
        id: r.id,
        day: r.day,
        summary: r.summary,
        done: r.done ?? [],
        issues: r.issues ?? [],
        materials: r.materials ?? [],
        next: r.next_steps ?? [],
        forCustomer: r.for_customer,
        crew: r.crew ?? [],
        photoFileIds: (r.photo_file_ids ?? []).filter((id) => here.has(id)),
        notesRead: r.notes_read,
        photosRead: r.photos_read,
        writtenAt: new Date(r.written_at).toISOString(),
        askedBy: r.asked,
        edited: r.edited_at ? { by: r.edited, at: new Date(r.edited_at).toISOString() } : null,
        sent:
          r.sent_at && r.sent_channel
            ? { by: r.sent, at: new Date(r.sent_at).toISOString(), channel: r.sent_channel }
            : null,
      })),
      files,
      today: todayIn(zone),
      onItsOwn: settings.dailyReports,
      customer: customer ? { name: customer.name, email: customer.email, sms: customer.sms } : null,
      canChange: !job.archived,
      truncated: found.length > REPORT_LIMITS.list,
    };
  },
});

/** A report of this business, locked for the change, with its job; refused when either is gone. */
async function loadReport(ctx: Ctx, reportId: string) {
  const [report] = await ctx.tx
    .select()
    .from(dailyReports)
    .where(and(eq(dailyReports.id, reportId), eq(dailyReports.workspaceId, ctx.scope.workspaceId!)))
    .for('update');
  if (!report) throw HfosError.notFound(REFUSALS.reportGone);
  const job = await loadJob(ctx, report.recordId);
  if (job.archived) throw HfosError.notFound(REFUSALS.jobGone);
  return { report, job };
}

export const reportUpdate = defineAddonCommand(contractorAddon, {
  name: 'contractor.report.update',
  description:
    'Change a daily report’s words: its summary, what got done, issues, materials, what’s next and the update for the customer. It’s saved whole, and from then on the AI never writes over it unless someone asks.',
  risk: 1,
  input: ReportUpdateInput,
  output: ReportChangeOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_update_report',
    description:
      'Change a daily report’s words (by report id, from contractor_list_reports). Saved whole: give summary, done, issues, materials, next and forCustomer as they should now read (a part left out is emptied; an update already sent to the customer stays as it went). After a person’s change the AI never writes that day over unless asked.',
    keywords: ['edit report', 'fix the daily report'],
    outcome: (output) => ({ words: W.reports.saved, path: pathOf(output) }),
  },
  emits: ['contractor.report.updated'],
  async handler(ctx, input) {
    const { report, job } = await loadReport(ctx, input.reportId);
    const body = checkedReport(input);
    if (!body) throw HfosError.rule('contractor_report_empty', 409, REFUSALS.reportEmpty);
    const now = new Date();
    await ctx.tx
      .update(dailyReports)
      .set({
        summary: body.summary,
        done: [...body.done],
        issues: [...body.issues],
        materials: [...body.materials],
        nextSteps: [...body.next],
        // What already went to the customer stays as it went.
        forCustomer: report.sentAt ? report.forCustomer : body.forCustomer,
        editedBy: userIdOf(ctx.actor),
        editedAt: now,
        updatedAt: now,
      })
      .where(eq(dailyReports.id, report.id));
    await ctx.emit({
      type: 'contractor.report.updated',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: { reportId: report.id, jobId: job.recordId, day: report.day },
    });
    return { reportId: report.id, jobId: job.recordId, day: report.day };
  },
});

export const reportSend = defineAddonCommand(contractorAddon, {
  name: 'contractor.report.send',
  description:
    'Send the job’s customer a daily report’s update, by email or text, through HandsFreeOS’s own messages. Only the update written for the customer goes: never the office’s report, hours or costs.',
  risk: 2,
  input: ReportSendInput,
  output: ReportSendOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_send_report',
    description:
      'Send a job’s customer the update from a daily report (by report id; channel email or sms). It sends the report’s forCustomer text, or body when given (which is then kept as the report’s update). Only that update goes, never the office’s report. Refused when the job has no customer, they can’t be reached that way, or the update was already sent. Asks the person first.',
    autonomy: 'confirm',
    what: 'Send the customer the day’s update',
    keywords: ['send daily report', 'update the customer', 'send report to customer'],
    outcome: (output) => ({ words: W.reports.sent, path: pathOf(output) }),
  },
  emits: ['contractor.report.sent'],
  async handler(ctx, input) {
    const { report, job } = await loadReport(ctx, input.reportId);
    if (report.sentAt) throw HfosError.rule('contractor_report_sent', 409, REFUSALS.reportSent);
    const customer = await customerOf(ctx, job.recordId);
    if (!customer)
      throw HfosError.rule('contractor_report_no_customer', 409, REFUSALS.reportNoCustomer);
    const text = (input.body ?? report.forCustomer ?? '').trim();
    if (!text)
      throw HfosError.rule('contractor_report_nothing_to_send', 409, REFUSALS.reportNoUpdate);
    if (input.channel === 'email' ? !customer.email : !customer.sms)
      throw HfosError.rule(
        'contractor_report_cant_reach',
        409,
        REFUSALS.reportCantReach(customer.name, input.channel),
      );
    const dayWords = reportDayWords(report.day);
    // Core's own send: who may message customers, consent, quiet hours and the conversation are all its.
    await executeCommandWithin(ctx, messageSend, {
      workspaceId: ctx.scope.workspaceId!,
      personId: customer.personId,
      channel: input.channel,
      body: text,
      ...(input.channel === 'email'
        ? { subject: clip(`Today on your job: ${job.name}`, 200) }
        : { acknowledgeQuietHours: input.acknowledgeQuietHours }),
    });
    const now = new Date();
    await ctx.tx
      .update(dailyReports)
      .set({
        // What went is what's kept as the customer's update.
        forCustomer: text,
        sentBy: userIdOf(ctx.actor),
        sentAt: now,
        sentChannel: input.channel,
        updatedAt: now,
      })
      .where(eq(dailyReports.id, report.id));
    const eventId = await ctx.emit({
      type: 'contractor.report.sent',
      entityType: 'custom_record',
      entityId: job.recordId,
      payload: {
        reportId: report.id,
        jobId: job.recordId,
        day: report.day,
        channel: input.channel,
      },
    });
    await jobLine(ctx, job.recordId, `sent the customer the update for ${dayWords}`, {
      eventId,
      personId: customer.personId,
    });
    return {
      reportId: report.id,
      jobId: job.recordId,
      day: report.day,
      channel: input.channel,
      customer: customer.name,
    };
  },
});
