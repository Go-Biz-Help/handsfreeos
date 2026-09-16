'use client';
/**
 * One account a business is paid into (design/m9 Settings). Connecting is the same two steps as a calendar:
 * a one-time state from `payment_connection.connect`, then the browser goes to the worker's `/oauth/<provider>/start`,
 * which sends it to Stripe or Square and brings it back to this page with `?payments=…`.
 *
 * Nothing secret is ever here: the query hands over the account id, the label, what it can do and how it stands,
 * and the token columns aren't granted to people at all.
 */
import { Lock, MoreHorizontal, Unplug } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PaymentConnectionRow } from '@/lib/api/types';
import { publicEnv } from '@/lib/env';
import { cn } from '@/lib/utils';

export type ConnectableProvider = 'stripe' | 'square';

export const PROVIDER_NAME: Readonly<Record<string, string>> = {
  stripe: 'Stripe',
  square: 'Square',
  paypal: 'PayPal',
  nmi: 'NMI',
  authorize_net: 'Authorize.net',
};

/**
 * Starts connecting an account to be paid into: a one-time state, then the provider's own sign-in through the
 * worker. It comes back to Settings → Payments with `?payments=connected|cancelled|failed|missing_permissions`.
 */
export async function connectPaymentAccount(
  workspaceId: string,
  provider: ConnectableProvider,
): Promise<void> {
  const out = unwrap(
    await apiBrowser().POST('/v1/commands/payment_connection.connect', {
      body: { workspaceId, provider },
    }),
  );
  window.location.assign(
    `${publicEnv.workerUrl}/oauth/${provider}/start?state=${encodeURIComponent(out.state)}`,
  );
}

/** The provider's initial in a tile, so two accounts of the same kind still read apart by their name. */
function ProviderMark({ provider }: { provider: string }) {
  const name = PROVIDER_NAME[provider] ?? provider;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-8 w-8 flex-none items-center justify-center rounded-control border border-border text-[13px] font-semibold',
        provider === 'stripe' ? 'bg-accent-soft text-accent-text' : 'bg-card-2 text-text-2',
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}

/** "Card · bank transfer · plans · refunds", in the order the canvas lists them. */
export function capabilityWords(capabilities: Record<string, unknown>): string {
  const on = (key: string) => capabilities[key] === true;
  const words = [
    on('card') ? 'Card' : null,
    on('bankTransfer') ? 'bank transfer' : null,
    on('subscriptions') ? 'plans' : null,
    on('refunds') ? 'refunds' : null,
  ].filter(Boolean);
  return words.length ? words.join(' · ') : 'Nothing yet — the provider is still checking it';
}

interface Standing {
  readonly badge: string;
  readonly variant: 'ok' | 'danger' | 'pending';
  readonly note: string | null;
}

function standingOf(c: PaymentConnectionRow): Standing {
  if (c.status === 'active') return { badge: 'Connected', variant: 'ok', note: null };
  if (c.status === 'reauth_required')
    return {
      badge: 'Needs reconnecting',
      variant: 'danger',
      note:
        c.lastError ??
        'The provider stopped letting us in. Nothing new can be paid into it until you sign in again.',
    };
  if (c.status === 'error')
    return {
      badge: 'Not working',
      variant: 'danger',
      note: c.lastError ?? 'The last few calls to this account failed. We keep trying.',
    };
  return { badge: 'Connecting', variant: 'pending', note: 'Finish signing in at the provider.' };
}

export function PaymentConnectionCard({
  workspaceId,
  connection,
}: {
  workspaceId: string;
  connection: PaymentConnectionRow;
}) {
  const router = useRouter();
  const c = connection;
  const provider = PROVIDER_NAME[c.provider] ?? c.provider;
  const name = c.label ?? c.displayName ?? provider;
  const standing = standingOf(c);
  const [busy, setBusy] = useState<string | null>(null);
  const [plans, setPlans] = useState<{ id: string; planName: string }[] | null>(null);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const makeDefault = () =>
    void run('default', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/payment_connection.set_default', {
          body: { workspaceId, connectionId: c.id },
        }),
      );
      toast.success(`${name} is where new invoices are paid.`);
      router.refresh();
    });

  const rename = () =>
    void run('rename', async () => {
      const next = prompt('What do you call this account?', c.label ?? c.displayName ?? '');
      if (next === null) return;
      unwrap(
        await apiBrowser().POST('/v1/commands/payment_connection.set_label', {
          body: { workspaceId, connectionId: c.id, label: next.trim() || null },
        }),
      );
      toast.success('Saved.');
      router.refresh();
    });

  /**
   * The plans this account bills, cancelled first — the way out the plan's pitfall asks for. Each one is
   * cancelled at the provider while we still have the sign-in to do it with; once the account is disconnected
   * nothing here can stop them, because the tokens are destroyed on purpose.
   */
  async function cancelPlansThenDisconnect(list: { id: string; planName: string }[]) {
    for (const plan of list)
      unwrap(
        await apiBrowser().POST('/v1/commands/subscription.cancel', {
          body: {
            workspaceId,
            subscriptionId: plan.id,
            reason: `The ${provider} account it billed through was disconnected`,
          },
        }),
      );
    await disconnect(
      true,
      list.length === 1
        ? 'The plan was cancelled, and the account disconnected.'
        : `${list.length} plans were cancelled, and the account disconnected.`,
    );
  }

  /** Plans keep billing at the provider after a disconnect, so the command refuses until the business says it knows. */
  async function disconnect(acknowledgeSubscriptions: boolean, said?: string) {
    unwrap(
      await apiBrowser().POST('/v1/commands/payment_connection.disconnect', {
        body: { workspaceId, connectionId: c.id, acknowledgeSubscriptions },
      }),
    );
    setPlans(null);
    toast.success(
      said ??
        (acknowledgeSubscriptions
          ? 'Disconnected. The plans keep billing at the provider and now say so.'
          : 'Disconnected. Reconnect the same account later and refunds on old payments work again.'),
    );
    router.refresh();
  }

  const askDisconnect = () =>
    void run('disconnect', async () => {
      try {
        await disconnect(false);
      } catch (e) {
        if (e instanceof ApiError && e.rule === 'payment_connection_has_plans') {
          const list = (e.details as { subscriptions?: { id: string; planName: string }[] } | null)
            ?.subscriptions;
          setPlans(list ?? []);
          return;
        }
        throw e;
      }
    });

  return (
    <div
      className="flex flex-wrap items-start gap-3 rounded-menu border border-border px-3.5 py-3"
      data-testid={`pay-account-${c.id}`}
      data-provider={c.provider}
      data-status={c.status}
      data-default={c.isDefault ? 'yes' : 'no'}
    >
      <ProviderMark provider={c.provider} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">
            {provider}
            {c.label || c.displayName ? ` · ${c.label ?? c.displayName}` : ''}
          </span>
          {c.isDefault ? (
            <Badge variant="accent" data-testid={`pay-default-${c.id}`}>
              Default
            </Badge>
          ) : null}
          <Badge variant={standing.variant}>{standing.badge}</Badge>
          {c.environment === 'test' ? <Badge variant="gray">Test</Badge> : null}
        </span>
        <span className="text-xs text-text-3">
          {c.externalAccountId ?? 'No account id yet'}
          {c.locationId ? ` · ${c.locationId} location` : ''}
        </span>
        <span className="text-xs text-text-3">{capabilityWords(c.capabilities)}</span>
        {standing.note ? (
          <span className="text-xs text-danger-text" data-testid={`pay-account-note-${c.id}`}>
            {standing.note}
          </span>
        ) : null}
        {c.provider === 'square' && c.status === 'active' ? (
          <span className="text-xs text-text-3">
            Square signs you out every 30 days. HandsFreeOS renews it each week.
          </span>
        ) : null}
        {c.liveSubscriptions > 0 ? (
          <span className="text-xs text-text-3">
            {c.liveSubscriptions} {c.liveSubscriptions === 1 ? 'plan bills' : 'plans bill'} through
            it.
          </span>
        ) : null}
      </span>
      <span className="flex flex-none items-center gap-1.5">
        {c.status === 'active' && !c.isDefault ? (
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'default'}
            onClick={makeDefault}
            data-testid={`pay-make-default-${c.id}`}
          >
            Make default
          </Button>
        ) : null}
        {c.status === 'reauth_required' || c.status === 'error' ? (
          <Button
            size="sm"
            loading={busy === 'reconnect'}
            onClick={() =>
              void run('reconnect', () =>
                connectPaymentAccount(workspaceId, c.provider as ConnectableProvider),
              )
            }
            data-testid={`pay-reconnect-${c.id}`}
          >
            Reconnect
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`${name} actions`}>
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={rename}>Rename</DropdownMenuItem>
            <DropdownMenuItem danger onSelect={askDisconnect}>
              <Unplug className="h-4 w-4" strokeWidth={1.5} />
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

      <Dialog open={plans !== null} onOpenChange={(open) => !open && setPlans(null)}>
        <DialogContent title="Plans still bill through this account">
          <p className="text-[13px] text-text-2">
            Disconnecting forgets the sign-in here, but {provider} keeps charging{' '}
            {(plans ?? []).length === 1 ? 'this customer' : 'these customers'} every cycle. Cancel
            them first — which can only be done while the account is still connected — or disconnect
            anyway and they’ll be marked as no longer managed by HandsFreeOS.
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-[13px]" data-testid="pay-disconnect-plans">
            {(plans ?? []).map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <Lock className="h-3.5 w-3.5 flex-none text-text-3" strokeWidth={1.75} />
                {p.planName}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPlans(null)}>
              Keep it connected
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'cancel-plans'}
              onClick={() => void run('cancel-plans', () => cancelPlansThenDisconnect(plans ?? []))}
              data-testid="pay-cancel-plans"
            >
              Cancel {(plans ?? []).length === 1 ? 'the plan' : 'them'} first
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busy === 'disconnect-anyway'}
              onClick={() => void run('disconnect-anyway', () => disconnect(true))}
              data-testid="pay-disconnect-anyway"
            >
              Disconnect anyway
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
