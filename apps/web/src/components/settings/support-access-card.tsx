'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

interface Row {
  id: string;
  status: 'requested' | 'active' | 'declined' | 'ended';
  expired: boolean;
  requestedBy: { id: string; fullName: string } | null;
  requestNote: string | null;
  grantedBy: { id: string; fullName: string } | null;
  expiresAt: string | null;
  createdAt: string;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * HandsFreeOS support and this business's private records (Real Estate step 4). Support sees no record kept to its
 * people unless someone who may lets them in: answering their request, or unasked. It lasts 24 hours and shows
 * what that person sees, read-only; it can be ended sooner.
 */
export function SupportAccessCard({
  workspaceId,
  canLetIn,
  items,
  myUserId,
  canEndAny,
}: {
  workspaceId: string;
  canLetIn: boolean;
  items: readonly Row[];
  myUserId: string;
  /** Owners and admins end anyone's; everyone else only their own. */
  canEndAny: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const waiting = items.filter((i) => i.status === 'requested');
  const open = items.filter((i) => i.status === 'active' && !i.expired);

  async function send(
    path:
      | '/v1/commands/support_access.grant'
      | '/v1/commands/support_access.decline'
      | '/v1/commands/support_access.end',
    body: Record<string, string>,
    done: string,
  ) {
    setBusy(true);
    try {
      unwrap(await apiBrowser().POST(path, { body: { workspaceId, ...body } as never }));
      toast.success(done);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4 md:p-5" id="support-access" data-testid="support-access">
      <h3 className="text-[15px] font-semibold">Support access to private records</h3>
      <p className="mt-1 text-[13px] text-text-2">
        HandsFreeOS support can’t see records kept to the people on them, like deals, unless you let
        them in. It lasts 24 hours, shows what you see, read-only, and you can end it sooner. Every
        request and answer is in the audit log.
      </p>
      {waiting.map((r) => (
        <div
          key={r.id}
          className="mt-3 rounded-menu border border-accent bg-accent-soft p-3 text-[13px]"
          data-testid={`support-request-${r.id}`}
        >
          <p>
            <strong>{r.requestedBy?.fullName ?? 'HandsFreeOS support'}</strong> asks to see them: “
            {r.requestNote}” <span className="text-text-3">· {when(r.createdAt)}</span>
          </p>
          {canLetIn ? (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void send(
                    '/v1/commands/support_access.grant',
                    { requestId: r.id },
                    'Support can see what you see for 24 hours.',
                  )
                }
              >
                Allow for 24 hours
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void send(
                    '/v1/commands/support_access.decline',
                    { requestId: r.id },
                    'Support was told no.',
                  )
                }
              >
                Decline
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-text-3">
              An owner or admin, or a deal’s main agent, can answer.
            </p>
          )}
        </div>
      ))}
      {open.length ? (
        <ul className="mt-3 flex flex-col gap-2 text-[13px]">
          {open.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span>
                <Badge variant="pending">Open</Badge> Support sees what{' '}
                {r.grantedBy?.id === myUserId
                  ? 'you see'
                  : `${r.grantedBy?.fullName ?? 'someone'} sees`}{' '}
                until {r.expiresAt ? when(r.expiresAt) : 'it ends'}
              </span>
              {canEndAny || r.grantedBy?.id === myUserId ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void send(
                      '/v1/commands/support_access.end',
                      { grantId: r.id },
                      'Support’s access ended.',
                    )
                  }
                >
                  End now
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canLetIn && !open.some((r) => r.grantedBy?.id === myUserId) ? (
        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void send(
              '/v1/commands/support_access.grant',
              {},
              'Support can see what you see for 24 hours.',
            )
          }
        >
          Give support access for 24 hours
        </Button>
      ) : null}
    </Card>
  );
}
