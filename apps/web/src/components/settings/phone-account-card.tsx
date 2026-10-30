'use client';
import { CircleAlert, Copy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { OwnAccountNumbers } from '@/components/settings/number-import';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { phoneAccountState, type PhoneAccountState } from '@/lib/api/worker';
import { useLiveVersion } from '@/lib/realtime/live-provider';

/**
 * Phone & texting on or off for this business: its own Twilio account (HandsFreeOS's parent account → one
 * account per business → its numbers).
 *
 * On makes the account now, so its Account SID is here to give HighLevel or Twilio when moving a number over,
 * before there is any number. When Twilio keeps refusing, the worker gives up after a few minutes and the card
 * shows Off with why. Off closes it for good — Twilio cannot reopen one — so it asks first, and the
 * worker refuses while a number, a transfer, a port, an RCS sender or a texting registration is in it.
 *
 * While it is on, the card also finds the numbers sitting in the account that are not set up here: one moved in
 * straight through Twilio's or HighLevel's support, with no transfer started here, waits there until set up.
 */
export function PhoneAccountCard({ workspaceId }: { workspaceId: string }) {
  const [shown, setShown] = useState<PhoneAccountState | null>(null);
  const [busy, setBusy] = useState<'on' | 'off' | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** Why turning off was refused: what is still in the account, in words. */
  const [refused, setRefused] = useState<string | null>(null);
  const version = useLiveVersion(['telephony_account', 'phone_number']);

  const load = useCallback(async () => {
    try {
      const next = await phoneAccountState(workspaceId);
      setShown(next);
      return next;
    } catch {
      return null;
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // The worker makes or closes the account within seconds; look again until it has, in case the live channel
  // is down. Once the worker has the press of On, the state it reports says "Turning on…" by itself, through a
  // refresh too, and then either on or off with why.
  useEffect(() => {
    if (!busy && shown?.state !== 'turning_on') return;
    const timer = setInterval(() => {
      void load().then((next) => {
        if (!next) return;
        if (busy === 'on' && next.state !== 'off') setBusy(null);
        if (busy === 'off' && (next.state === 'off' || next.lastError)) setBusy(null);
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [busy, shown?.state, load]);

  async function turnOn() {
    setBusy('on');
    try {
      unwrap(await apiBrowser().POST('/v1/commands/telephony.enable', { body: { workspaceId } }));
    } catch (e) {
      setBusy(null);
      toast.error(errorMessage(e));
    }
  }

  async function turnOff() {
    setBusy('off');
    setConfirming(false);
    setRefused(null);
    try {
      unwrap(await apiBrowser().POST('/v1/commands/telephony.disable', { body: { workspaceId } }));
    } catch (e) {
      setBusy(null);
      setRefused(errorMessage(e));
    }
  }

  const on = shown?.state === 'on' || shown?.state === 'turning_on';
  const status =
    busy === 'on' || shown?.state === 'turning_on'
      ? 'Turning on…'
      : busy === 'off'
        ? 'Turning off…'
        : on
          ? 'On'
          : 'Off';

  return (
    <Card
      className="max-w-[820px] p-5 md:p-7"
      data-testid="phone-account-card"
      data-state={shown?.state}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Phone &amp; texting</h2>
          <p className="mt-1 text-[13px] text-text-2">
            Your business’s own Twilio account inside HandsFreeOS. Your numbers live in it, and
            moving a number here from HighLevel or another Twilio account needs its Account SID.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[13px] text-text-2" data-testid="phone-account-status">
            {status}
          </span>
          <Switch
            checked={busy ? busy === 'on' : on}
            disabled={!shown || !!busy || shown.state === 'turning_on'}
            onChange={(next) => (next ? void turnOn() : setConfirming(true))}
            label="Phone & texting"
            testId="phone-account-switch"
          />
        </div>
      </div>

      {confirming ? (
        <Callout
          tone="warning"
          icon={CircleAlert}
          className="mt-4"
          data-testid="phone-account-confirm"
          action={
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="danger"
                onClick={() => void turnOff()}
                data-testid="phone-account-off"
              >
                Turn off
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep it on
              </Button>
            </span>
          }
        >
          Turning off closes this business’s Twilio account for good. It only works when there are
          no numbers in it, and never releases one. Turning it back on later gives you a new Account
          SID.
        </Callout>
      ) : null}

      {refused ? (
        <Callout
          tone="warning"
          icon={CircleAlert}
          className="mt-4"
          data-testid="phone-account-refused"
        >
          {refused}
        </Callout>
      ) : null}

      {shown?.lastError && !busy && !refused ? (
        <Callout
          tone="warning"
          icon={CircleAlert}
          className="mt-4"
          data-testid="phone-account-error"
        >
          {shown.lastError}
        </Callout>
      ) : null}

      {on && shown?.accountSid ? (
        <div className="mt-4 flex flex-col gap-1 text-[13px]" data-testid="phone-account-sids">
          <SidRow
            label="Twilio Account SID"
            value={shown.parentAccountSid}
            testId="phone-account-parent"
          />
          <SidRow label="Sub-account SID" value={shown.accountSid} testId="phone-account-sid" />
          <span className="mt-1 text-xs text-text-3">
            HighLevel asks for both when moving an LC Phone number here: open a support ticket with
            the number, these two, and when you would like it to move. Never release the number to
            move it.
          </span>
        </div>
      ) : null}

      {on && shown?.accountSid ? (
        <div className="mt-5 border-t border-border pt-4">
          <h3 className="text-[13.5px] font-semibold">Numbers already in this account</h3>
          <p className="mb-3 mt-1 text-xs text-text-3">
            A number Twilio or HighLevel moved here without a transfer started in HandsFreeOS waits
            in this account until you set it up.
          </p>
          <OwnAccountNumbers workspaceId={workspaceId} />
        </div>
      ) : null}
    </Card>
  );
}

function SidRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-40 text-text-3">{label}</span>
      <span className="font-mono" data-testid={testId}>
        {value}
      </span>
      <Button
        size="icon"
        variant="ghost"
        aria-label={`Copy the ${label}`}
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => toast.success(`${label} copied.`))
            .catch(() => toast.error('Could not copy. Select it and copy it yourself.'));
        }}
      >
        <Copy className="h-3.5 w-3.5" strokeWidth={1.8} />
      </Button>
    </div>
  );
}
