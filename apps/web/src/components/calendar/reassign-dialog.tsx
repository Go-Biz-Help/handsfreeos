'use client';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AppointmentDetail, AppointmentWarning } from '@/lib/api/types';
import { firstName, namesText } from './appt';
import { tellLabel } from './move-dialog';

/** "Who’s going?": change the people on an appointment (the first one ticked hosts). */
export function ReassignDialog({
  workspaceId,
  appt,
  people,
  onClose,
  onDone,
}: {
  workspaceId: string;
  appt: AppointmentDetail;
  people: readonly { userId: string; fullName: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<string[]>(appt.staff.map((s) => s.userId));
  const [tell, setTell] = useState(true);
  const [warnings, setWarnings] = useState<AppointmentWarning[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const everyone = [
    ...people,
    ...appt.staff
      .filter((s) => !people.some((p) => p.userId === s.userId))
      .map((s) => ({ userId: s.userId, fullName: s.fullName })),
  ];
  const nameOf = (id: string) => everyone.find((p) => p.userId === id)?.fullName ?? 'Someone';
  const changed = picked.join() !== appt.staff.map((s) => s.userId).join();
  const tellText = tellLabel(appt);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/appointment.reassign', {
          body: {
            workspaceId,
            appointmentId: appt.id,
            userIds: picked,
            acknowledgeWarnings: !!warnings,
            notify: tell && !!tellText,
          },
        }),
      );
      toast.success(`Now with ${namesText(picked.map((u) => firstName(nameOf(u))))}.`);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'needs_confirmation')
        setWarnings((e.details as { warnings?: AppointmentWarning[] }).warnings ?? []);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Who’s going?" description={appt.title}>
        <div className="mt-3.5 flex flex-col gap-2" data-testid="reassign-dialog">
          {everyone.map((p) => (
            <Checkbox
              key={p.userId}
              checked={picked.includes(p.userId)}
              onChange={(e) => {
                setPicked(
                  e.target.checked ? [...picked, p.userId] : picked.filter((x) => x !== p.userId),
                );
                setWarnings(null);
                setError(null);
              }}
              label={
                <span className="flex items-center gap-2">
                  <Avatar name={p.fullName} seed={p.userId} size="sm" />
                  {p.fullName}
                  {picked[0] === p.userId ? (
                    <span className="text-xs text-text-3">· hosts</span>
                  ) : null}
                </span>
              }
            />
          ))}
          {warnings?.length
            ? warnings.map((w, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3 py-2.5 text-[13px] text-warning-text"
                >
                  <AlertTriangle className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
                  <span>{w.message}</span>
                </div>
              ))
            : null}
          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-menu bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text"
            >
              <CircleAlert className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
              <span>{error}</span>
            </div>
          ) : null}
          {tellText ? (
            <Checkbox
              className="mt-1"
              label={<span className="font-medium">{tellText}</span>}
              checked={tell}
              onChange={(e) => setTell(e.target.checked)}
              data-testid="reassign-tell"
            />
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!picked.length || !changed}
            onClick={() => void save()}
            data-testid="reassign-save"
          >
            {warnings ? 'Change anyway' : 'Change'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
