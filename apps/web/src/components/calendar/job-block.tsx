'use client';
import { JOB_STATUS_WORDS, type JobStatus } from '@hfos/core';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AppointmentDetail } from '@/lib/api/types';
import { fmtAt, fmtTime } from '@/lib/calendar/time';

type Job = NonNullable<AppointmentDetail['job']>;
type SetStatus = Exclude<JobStatus, 'cancelled'>;
const STEPS: readonly SetStatus[] = [
  'scheduled',
  'on_the_way',
  'in_progress',
  'waiting_on_parts',
  'done',
];

/**
 * M18: the job a visit is part of. Its status (the customer gets a text for each change they can get), a note
 * they may see, and the visits it covers — with the customer's other upcoming visits to add, making it a project.
 */
export function JobBlock({
  workspaceId,
  appointmentId,
  job,
  timeZone,
  onChanged,
}: {
  workspaceId: string;
  appointmentId: string;
  job: Job;
  timeZone: string;
  onChanged: () => void;
}) {
  const [note, setNote] = useState(job.customerNote ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const cancelled = job.status === 'cancelled';

  async function setStatus(status: SetStatus, customerNote?: string | null) {
    setBusy(customerNote === undefined ? status : 'note');
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/job.set_status', {
          body: {
            workspaceId,
            appointmentId,
            status,
            ...(customerNote !== undefined ? { customerNote } : {}),
          },
        }),
      );
      if (out.changed)
        toast.success(
          customerNote !== undefined
            ? 'Note saved. The customer gets a text about it.'
            : status === 'scheduled'
              ? 'Back to scheduled.'
              : `Marked ${JOB_STATUS_WORDS[status].toLowerCase()}. The customer gets a text.`,
        );
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function addVisit(visitId: string) {
    setBusy('add');
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/job.add_visit', {
          body: { workspaceId, jobId: job.id, appointmentId: visitId },
        }),
      );
      toast.success('Visit added to this job.');
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2.5 pt-1" data-testid="sheet-job">
      {cancelled ? (
        <p className="text-[13px] text-text-2">This job was cancelled with its visits.</p>
      ) : (
        <>
          <Segmented<SetStatus>
            ariaLabel="Job status"
            value={job.status as SetStatus}
            onChange={(v) => void setStatus(v)}
            options={STEPS.map((s) => ({
              value: s,
              label: JOB_STATUS_WORDS[s],
              testId: `job-status-${s}`,
              disabled: !!busy,
            }))}
          />
          {job.status === 'on_the_way' && job.etaAt ? (
            <p className="text-xs text-text-3">
              Should get there around {fmtTime(job.etaAt, timeZone)}.
            </p>
          ) : null}
          <div>
            <label htmlFor="job-note" className="text-xs font-medium text-text-2">
              Note the customer may see
            </label>
            <Textarea
              id="job-note"
              value={note}
              maxLength={500}
              placeholder="The part is ordered and due Friday."
              onChange={(e) => setNote(e.target.value)}
            />
            {note.trim() !== (job.customerNote ?? '') ? (
              <div className="mt-1.5 flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'note'}
                  onClick={() => void setStatus(job.status as SetStatus, note.trim() || null)}
                >
                  Save note
                </Button>
              </div>
            ) : null}
          </div>
        </>
      )}
      {job.visits.length > 1 ? (
        <div>
          <p className="text-xs font-medium text-text-2">Visits in this job</p>
          <ul className="mt-1 flex flex-col gap-1">
            {job.visits.map((v) => (
              <li key={v.appointmentId} className="text-[13px]">
                <span className={v.appointmentId === appointmentId ? 'font-medium' : ''}>
                  {fmtAt(v.startsAt, timeZone)}
                </span>
                <span className="text-text-3"> · {v.title}</span>
                {v.status !== 'scheduled' ? (
                  <span className="text-text-3"> · {v.status}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!cancelled && job.otherVisits.length ? (
        <div>
          <p className="text-xs font-medium text-text-2">Add another of their visits</p>
          <div className="mt-1 flex flex-col gap-1">
            {job.otherVisits.map((v) => (
              <Button
                key={v.appointmentId}
                size="sm"
                variant="ghost"
                className="justify-start"
                loading={busy === 'add'}
                onClick={() => void addVisit(v.appointmentId)}
                data-testid="job-add-visit"
              >
                + {fmtAt(v.startsAt, timeZone)} · {v.title}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
