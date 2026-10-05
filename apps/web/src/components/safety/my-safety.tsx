'use client';
/**
 * A person's own Safety page (round six, core; board 91's last panel, as the web shows it): their open check-in, with
 * I'm OK (check out) and +15 min, the contacts told if they don't check out, and the business's times. The "Still
 * there?" push opens it on a computer (apps/worker/src/safety/ladder.ts). Checking in, and adding or changing
 * contacts, happen in the phone app, where the place and the phone's own call and text apps are.
 */
import {
  fmtTime,
  SAFETY_CONTACT_WORDS,
  SAFETY_DEFAULTS,
  SAFETY_TIMES_NOTE,
  safetyTimesLines,
} from '@hfos/core';
import { ShieldCheck, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

type Mine = Ok<'/v1/queries/safety.mine'>;
type Times = Ok<'/v1/queries/safety.settings'>;

const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "Sam", "Sam and Marcus", "Sam, Jo and Marcus". */
const namesList = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export function MySafetyPage({
  workspaceId,
  mine,
  times,
  timeZone,
}: {
  workspaceId: string;
  mine: Mine;
  times: Times;
  timeZone: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'out' | 'more' | null>(null);
  const open = mine.open;
  // Who'd be told now: teammates, and people outside who agreed by text.
  const told = mine.contacts
    .filter((c) => c.status === 'teammate' || c.status === 'agreed')
    .map((c) => firstOf(c.name));
  const run = async (key: 'out' | 'more', done: string) => {
    if (!open) return;
    setBusy(key);
    try {
      if (key === 'out')
        unwrap(
          await apiBrowser().POST('/v1/commands/safety.check_out', {
            body: { workspaceId, checkInId: open.id },
          }),
        );
      else
        unwrap(
          await apiBrowser().POST('/v1/commands/safety.extend', {
            body: { workspaceId, checkInId: open.id, minutes: 15 },
          }),
        );
      toast.success(done);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-xl" data-testid="my-safety">
      <PageHeader
        title="My safety"
        description="Check in from the phone app when you’re alone at a customer’s place."
      />
      <div className="space-y-4">
        {open ? (
          <Card className="p-4 md:p-5" data-testid="my-check-in">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-8 w-8 flex-none items-center justify-center rounded-full bg-success-soft text-success-text">
                <ShieldCheck size={17} strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold">Checked in · {open.place}</h2>
                <p className="text-[13.5px] text-text-2">
                  Until {fmtTime(open.plannedEndAt, timeZone)} ·{' '}
                  {told.length
                    ? `${namesList(told)} ${told.length === 1 ? 'is' : 'are'} told if you don’t check out`
                    : 'the business’s safety person is told if you don’t check out'}
                </p>
              </div>
            </div>
            {open.state === 'alerted' || open.state === 'help' ? (
              <Callout tone="danger" className="mt-3">
                {open.state === 'help'
                  ? 'Your contacts were told you asked for help. If you’re safe, check out so they hear you’re OK.'
                  : 'Your contacts were told you hadn’t checked out. If you’re OK, check out so they hear it.'}
              </Callout>
            ) : open.state === 'asked' ? (
              <Callout tone="warning" className="mt-3">
                Still there? Answer within {times.alertAfterMinutes} minutes of being asked, or your
                contacts are told.
              </Callout>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                loading={busy === 'out'}
                disabled={busy !== null}
                onClick={() => void run('out', 'Checked out. Glad you’re OK.')}
                data-testid="my-check-out"
              >
                I’m OK, check me out
              </Button>
              <Button
                variant="secondary"
                loading={busy === 'more'}
                disabled={busy !== null}
                onClick={() => void run('more', 'Added 15 minutes.')}
                data-testid="my-add-time"
              >
                +15 min
              </Button>
            </div>
          </Card>
        ) : (
          <Card className="p-4 md:p-5 text-[13.5px] text-text-2" data-testid="my-check-in-none">
            You’re not checked in. In the phone app, check in from the appointment when you get
            there, with when you plan to leave.
          </Card>
        )}

        <Card className="p-4 md:p-5" data-testid="my-contacts">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <Users className="h-4 w-4 text-text-3" strokeWidth={1.75} />
            Who’s told if you don’t check out
          </h2>
          {mine.contacts.length ? (
            <ul className="mt-2 divide-y divide-border">
              {mine.contacts.map((c) => (
                <li key={c.id} className="py-2.5 text-[13.5px]">
                  <div>{c.name}</div>
                  <div className="text-[12.5px] text-text-3">{SAFETY_CONTACT_WORDS[c.status]}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[13.5px] text-text-2">
              Nobody yet, so the business’s safety person is told.
            </p>
          )}
          <p className="mt-2 text-[12.5px] text-text-3">
            Add or change them in the phone app, under My safety. Someone outside is asked by text
            first and gets nothing until they reply OK. Only you see your contacts.
          </p>
        </Card>

        <Card className="p-4 md:p-5" data-testid="my-times">
          <h2 className="text-[15px] font-semibold">When</h2>
          <dl className="mt-2 divide-y divide-border rounded-control border border-border">
            {safetyTimesLines({
              askAfterMinutes: times.askAfterMinutes,
              alertAfterMinutes: times.alertAfterMinutes,
              repeatMinutes: SAFETY_DEFAULTS.repeatMinutes,
            }).map((l) => (
              <div
                key={l.label}
                className="flex items-baseline justify-between gap-3 px-3.5 py-2.5 text-[13.5px]"
              >
                <dt className="text-text-2">{l.label}</dt>
                <dd className="text-right">{l.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[12.5px] text-text-3">
            {SAFETY_TIMES_NOTE}
            {times.safetyPersonName ? ` The safety person is ${times.safetyPersonName}.` : ''}
          </p>
        </Card>
      </div>
    </div>
  );
}
