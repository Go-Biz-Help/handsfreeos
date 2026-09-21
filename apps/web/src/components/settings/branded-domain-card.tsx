'use client';
import { CircleAlert, CircleCheck, Copy, Globe, RefreshCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

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

/**
 * A business's own domain on the pages its customers see (M17).
 *
 * The email domain card's shape, because it is the same job: type a name, get two DNS records, and a status
 * that moves on its own. What is different is the sentence about removing it — a phone number can be given
 * back quietly, but every QR code and flyer already carrying this address stops working the moment it goes,
 * and nobody can un-print those.
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

  return (
    <Card className="max-w-[820px] px-[22px] py-5" data-testid="branded-domain-card">
      <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">
        Your own web address
      </h2>
      <p className="mt-1 max-w-[560px] text-[13px] text-text-2">
        One domain you own — like <span className="font-mono">booking.yourbusiness.com</span> —
        carries everything a customer sees: your booking page and calendar links, your forms, your
        estimates and invoices, your payment links, and your website chat. Set it once here and they
        all move together.
      </p>

      {!domain ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call(
              '/v1/commands/branded_domain.add',
              { workspaceId, domain: typed.trim().toLowerCase() },
              'Added. Put the two records below into your DNS.',
            );
          }}
        >
          <Field label="The domain you want to use" htmlFor="branded-domain">
            <Input
              id="branded-domain"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="booking.yourbusiness.com"
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
              New links are handed out on this address. Anything you sent before still opens on
              handsfreeos.com, so nothing you have already texted or printed has stopped working.
            </p>
          ) : null}

          {domain.lastError && !serving ? (
            <Callout tone="warning" icon={CircleAlert} className="mt-3">
              {domain.lastError}
            </Callout>
          ) : null}

          {domain.records.length > 0 ? (
            <div className="mt-3">
              <p className="text-[13px] text-text-2">
                Add these where your domain lives — your registrar, or whoever runs your website.
                DNS often takes a few hours, and we keep checking.
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
                  onClick={() =>
                    void call(
                      '/v1/commands/branded_domain.verify',
                      { workspaceId, domainId: domain.id },
                      'Checking now.',
                    )
                  }
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
                      `Take your pages off ${domain.domain}? Every link, QR code and flyer already carrying that address stops working straight away, and we can’t undo the printed ones.`,
                    )
                  )
                    return;
                  void call(
                    '/v1/commands/branded_domain.remove',
                    { workspaceId, domainId: domain.id },
                    'Removed. Your links are back on handsfreeos.com.',
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
