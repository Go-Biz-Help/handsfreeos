'use client';
/**
 * A teammate's safety alert (round six, core; board 91's third panel): someone who picked them as a contact missed
 * their check-out, or asked for help. Where they were, when they planned to leave, where their phone was and how to
 * call them, with I reached them (`safety.resolve`), which stops the alerts for everyone. `safety.alert` answers only
 * while it's theirs to answer (private.safety_checkin_for_contact); after that the page says there's nothing to do.
 * The push and the email both open it (apps/worker/src/safety/ladder.ts).
 */
import { formatPhone, fmtTime, safetyAlertPushWords } from '@hfos/core';
import { CircleCheck, MapPin, Phone, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shell/page-header';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

type Alert = NonNullable<Ok<'/v1/queries/safety.alert'>['alert']>;

const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** A map of where the phone was, when it said. */
export const mapLink = (latitude: number, longitude: number) =>
  `https://maps.google.com/?q=${encodeURIComponent(`${latitude},${longitude}`)}`;

export function SafetyAlertPage({
  workspaceId,
  checkInId,
  alert,
  timeZone,
}: {
  workspaceId: string;
  checkInId: string;
  alert: Alert | null;
  timeZone: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [reached, setReached] = useState<string | null>(null);

  if (reached || !alert)
    return (
      <div className="mx-auto w-full max-w-xl" data-testid="safety-alert-over">
        <PageHeader title="Safety" />
        <Card className="flex flex-col items-center px-6 py-10 text-center">
          <span className="mb-2 inline-flex h-[42px] w-[42px] items-center justify-center rounded-full bg-success-soft text-success-text">
            <CircleCheck size={20} />
          </span>
          <h2 className="text-[15px] font-semibold">
            {reached ? `Thanks. ${reached} is OK` : 'Nothing to answer here'}
          </h2>
          <p className="mt-1.5 max-w-sm text-[13px] text-text-2">
            {reached
              ? 'The alerts stop for everyone, and the others who were told hear it.'
              : 'Someone already said they’re OK, or they checked out, so the alerts have stopped. Nothing more to do.'}
          </p>
        </Card>
      </div>
    );

  const first = firstOf(alert.personName);
  const phone = alert.personPhone ? formatPhone(alert.personPhone) : null;
  const at = (iso: string) => fmtTime(iso, timeZone);
  const words = safetyAlertPushWords({
    person: alert.personName,
    place: alert.place,
    plannedEnd: at(alert.plannedEndAt),
    phone,
    help: alert.state === 'help',
  });
  const resolve = async () => {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/safety.resolve', {
          body: { workspaceId, checkInId },
        }),
      );
      setReached(first);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-xl" data-testid="safety-alert">
      <PageHeader title="Safety" />
      <Card className="border-danger p-4 md:p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-8 w-8 flex-none items-center justify-center rounded-full bg-danger-soft text-danger-text">
            <ShieldAlert size={17} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold" data-testid="safety-alert-title">
              {words.title}
            </h2>
            <p className="text-[13.5px] text-text-2">{alert.place}</p>
          </div>
        </div>
        <dl className="mt-4 divide-y divide-border rounded-control border border-border">
          <Row label="Planned end">{at(alert.plannedEndAt)}</Row>
          <Row label="Checked in">{at(alert.startedAt)}</Row>
          {alert.latitude !== null && alert.longitude !== null ? (
            <Row label="Where their phone was">
              <a
                href={mapLink(alert.latitude, alert.longitude)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent-text hover:underline"
              >
                <MapPin size={14} strokeWidth={1.75} />
                On the map{alert.locatedAt ? `, ${at(alert.locatedAt)}` : ''}
              </a>
            </Row>
          ) : null}
          <Row label="Their phone">{phone ?? 'Not on file'}</Row>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {alert.personPhone ? (
            <a
              href={`tel:${alert.personPhone}`}
              className={buttonClassName({ variant: 'primary' })}
              data-testid="safety-call"
            >
              <Phone size={15} aria-hidden />
              Call {first}
            </a>
          ) : null}
          <Button
            variant={alert.personPhone ? 'secondary' : 'primary'}
            loading={busy}
            onClick={() => void resolve()}
            data-testid="safety-reached"
          >
            I reached them
          </Button>
        </div>
        <p className="mt-3 text-[12.5px] text-text-3">
          This alert is to you alone; nobody else in the business sees the place. If you think{' '}
          {first} is in danger, call 911. HandsFreeOS never calls for you.
        </p>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3.5 py-2.5 text-[13.5px]">
      <dt className="text-text-2">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
