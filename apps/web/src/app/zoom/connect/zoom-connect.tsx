'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';

/** Pick the business and confirm: the worker links the Zoom user to this person there. */
export function ZoomConnect({
  ticket,
  places,
  nobodyCoaches,
}: {
  ticket: string;
  places: readonly { id: string; name: string }[];
  /** None of their businesses has anything that coaches in Zoom yet. */
  nobodyCoaches: boolean;
}) {
  const [workspaceId, setWorkspaceId] = useState(places[0]!.id);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ email: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await workerPost<{ linked: boolean; accountEmail: string | null }>(
        '/v1/zoom-live/link',
        { workspaceId, ticket },
      );
      setDone({ email: out.accountEmail });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <Card className="space-y-2 p-4" data-testid="zoom-connected">
        <p className="text-[14px] font-medium">
          Zoom is connected{done.email ? ` (${done.email})` : ''}.
        </p>
        <p className="text-[13.5px] text-text-2">
          In your next Zoom meeting, open HandsFreeOS from Zoom’s Apps button and the coach starts
          listening. You can close this tab.
        </p>
      </Card>
    );

  return (
    <Card className="space-y-3 p-4">
      <p className="text-[13.5px] text-text-2">
        Zoom said who you are there. Pick the business to be coached in, and HandsFreeOS will know
        that Zoom account is you.
      </p>
      {places.length > 1 ? (
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-[13px] font-medium">Business</legend>
          {places.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-[14px]">
              <input
                type="radio"
                name="business"
                value={p.id}
                checked={workspaceId === p.id}
                onChange={() => setWorkspaceId(p.id)}
              />
              {p.name}
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-[14px] font-medium">{places[0]!.name}</p>
      )}
      {nobodyCoaches ? (
        <p className="text-[12.5px] text-text-3">
          Nothing in this business coaches meetings yet. An owner can turn on AI Sales Coach under
          Settings → Add-ons; your Zoom stays connected for when they do.
        </p>
      ) : null}
      {error ? (
        <p className="text-[13px] text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
      <Button disabled={busy} onClick={() => void connect()} data-testid="zoom-connect-confirm">
        {busy ? 'Connecting…' : 'Connect Zoom'}
      </Button>
    </Card>
  );
}
