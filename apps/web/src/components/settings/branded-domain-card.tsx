'use client';
import { CircleAlert, CircleCheck, Copy, Globe, RefreshCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';

type Domain = NonNullable<Ok<'/v1/queries/branded_domain.get'>['domain']>;

const STATUS_WORD: Readonly<Record<Domain['status'], string>> = {
  pending: 'Just added',
  verifying: 'Waiting for your DNS',
  verified: 'Working',
  failed: 'Something is wrong',
};
const STATUS_TONE: Readonly<Record<Domain['status'], 'member' | 'pending' | 'accent' | 'danger'>> =
  {
    pending: 'member',
    verifying: 'pending',
    verified: 'accent',
    failed: 'danger',
  };

/** While the worker is asking the host: how often to look again, and when to stop looking. */
const POLL_MS = 3000;
const WATCH_MS = 90_000;

/**
 * A business's own domain on the pages its customers see (M17).
 *
 * The email domain card's shape, because it is the same job: type a name, get the DNS records the host asks
 * for, and a status that moves on its own. What is different is the sentence about removing it — a phone
 * number can be given back quietly, but every QR code and flyer already carrying this address stops working
 * the moment it goes, and nobody can un-print those.
 *
 * **How many records there are is the host's business, not ours.** A subdomain usually needs one CNAME; a
 * name the host wants proof of needs a TXT as well. Nothing here promises a number before the host has said
 * one, because a card that says "two records" over a single record is a card a business does not trust.
 */
export function BrandedDomainCard({
  workspaceId,
  domain,
  canManage,
}: {
  workspaceId: string;
  domain: Domain | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  /** Stamped when Check now is pressed, to start another watch for the answer. */
  const [checked, setChecked] = useState(0);

  const call = async (path: string, body: object, done: string) => {
    setBusy(true);
    try {
      unwrap(
        await (apiBrowser().POST as (p: string, o: { body: unknown }) => Promise<never>)(path, {
          body,
        }),
      );
      toast.success(done);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const serving = domain?.status === 'verified' && domain.certificateReady;
  // The worker's answer arrives as `branded_domain.status_changed`, so the records land on this page
  // without anybody reloading it.
  useLiveRefresh(['branded_domain']);

  /**
   * Look again while the worker is answering.
   *
   * The records are the host's to say, and the worker only asks once `add` has returned — so a domain added
   * a second ago has nothing to show yet, and Check now opens the same gap. Live updates carry the answer
   * whenever that channel is up; this is what makes the records appear on their own when it is not. It gives
   * up after a minute and a half rather than asking all afternoon about a host that is not going to answer,
   * and it never starts for a domain the host has already refused.
   */
  const awaiting =
    !!domain && !serving && domain.status !== 'failed' && domain.records.length === 0;
  const watch = !domain
    ? null
    : awaiting
      ? `records:${checked}`
      : checked
        ? `check:${checked}`
        : null;
  // The deadline belongs to the wait, not to this effect: a new `router` identity restarts the interval,
  // and a watch that started its ninety seconds two minutes ago should not get ninety more.
  const until = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!watch) return;
    if (until.current?.key !== watch) until.current = { key: watch, at: Date.now() + WATCH_MS };
    const stopAt = until.current.at;
    const timer = setInterval(() => {
      if (Date.now() > stopAt) clearInterval(timer);
      else router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [watch, router]);

  return (
    <Card className="max-w-[820px] px-[22px] py-5" data-testid="branded-domain-card">
      <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">
        Your own web address
      </h2>
      <p className="mt-1 max-w-[560px] text-[13px] text-text-2">
        One domain you own — like <span className="font-mono">go.yourbusiness.com</span> — carries
        everything a customer sees: your forms, your payment links, your estimates and invoices,
        your website chat, and your booking page if you use one. Set it once here and they all move
        together.
      </p>

      {!domain ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call(
              '/v1/commands/branded_domain.add',
              { workspaceId, domain: typed.trim().toLowerCase() },
              'Added. The records to put in your DNS show up here in a moment.',
            );
          }}
        >
          <Field label="The domain you want to use" htmlFor="branded-domain">
            <Input
              id="branded-domain"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="go.yourbusiness.com"
              className="w-[320px]"
              disabled={!canManage}
              data-testid="branded-domain-input"
            />
          </Field>
          <Button
            type="submit"
            loading={busy}
            disabled={!canManage}
            data-testid="branded-domain-add"
          >
            <Globe className="h-3.5 w-3.5" strokeWidth={1.8} />
            Use this domain
          </Button>
        </form>
      ) : (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px]">{domain.domain}</span>
            <Badge variant={STATUS_TONE[domain.status]}>
              {serving ? 'Working' : STATUS_WORD[domain.status]}
            </Badge>
            {serving ? (
              <CircleCheck className="h-4 w-4 text-success-text" strokeWidth={1.8} />
            ) : null}
          </div>

          {serving ? (
            <p className="mt-1.5 max-w-[560px] text-[13px] text-text-2">
              Your forms, payment links, estimates, invoices and booking page now go out on this
              address. Anything you sent before still opens on handsfreeos.com, so nothing you have
              already texted or printed has stopped working.
            </p>
          ) : null}

          {domain.lastError && !serving ? (
            <Callout tone="warning" icon={CircleAlert} className="mt-3">
              {domain.lastError}
            </Callout>
          ) : null}

          {awaiting ? (
            // Said out loud, because an empty space under a domain that was just added reads as a broken
            // screen rather than as a wait.
            <p
              className="mt-3 max-w-[560px] text-[13px] text-text-2"
              data-testid="branded-domain-waiting"
            >
              Working out what your DNS needs. The records show up here in a moment.
            </p>
          ) : null}

          {domain.records.length > 0 ? (
            <div className="mt-3">
              <p className="text-[13px] text-text-2">
                {domain.records.length === 1 ? 'Add this record' : 'Add these records'} where your
                domain lives — your registrar, or whoever runs your website. DNS often takes a few
                hours, and we keep checking. Until then, your forms, payment links and booking page
                stay on handsfreeos.com.
              </p>
              <div className="mt-2 flex flex-col gap-2">
                {domain.records.map((r) => (
                  <div
                    key={`${r.kind}:${r.host}`}
                    className="rounded-[10px] bg-card-2 p-3"
                    data-testid={`branded-domain-record-${r.kind}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="member">{r.kind}</Badge>
                      <span className="font-mono text-xs">{r.host}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded bg-card px-2 py-1 font-mono text-xs">
                        {r.value}
                      </code>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void navigator.clipboard.writeText(r.value);
                          toast.success('Copied.');
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" strokeWidth={1.8} />
                        Copy
                      </Button>
                    </div>
                    <p className="mt-1.5 text-xs text-text-3">{r.why}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {canManage ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!serving ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  onClick={() => {
                    setChecked(Date.now());
                    void call(
                      '/v1/commands/branded_domain.verify',
                      { workspaceId, domainId: domain.id },
                      'Checking now.',
                    );
                  }}
                  data-testid="branded-domain-check"
                >
                  <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
                  Check now
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                loading={busy}
                onClick={() => {
                  if (
                    !confirm(
                      `Stop using ${domain.domain}? Your forms, payment links, estimates, invoices and booking page go back to handsfreeos.com. Every link, QR code and flyer already carrying ${domain.domain} stops working straight away, and we can’t undo the printed ones.`,
                    )
                  )
                    return;
                  void call(
                    '/v1/commands/branded_domain.remove',
                    { workspaceId, domainId: domain.id },
                    'Removed. Your forms, payment links and booking page are back on handsfreeos.com.',
                  );
                }}
                data-testid="branded-domain-remove"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                Remove
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
