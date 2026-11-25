'use client';
import { dayTime, routineStatusWords, type AssistantRoutineOut } from '@hfos/core';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * Settings → Account, under Notifications: each question the Assistant asks for you on a schedule and each alert you
 * asked it for, with Pause (or Turn on again) and Delete. They're yours alone; asking the Assistant is how one is
 * made ("Every Monday at 8, tell me who owes money", "Tell me when Bob writes back"). Someone who lost the Assistant
 * can still delete theirs.
 */
export function AssistantRoutinesSection({
  workspaceId,
  timeZone,
  initial,
}: {
  workspaceId: string;
  /** The business's: a question's times are its times. */
  timeZone: string;
  initial: readonly AssistantRoutineOut[];
}) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function pause(r: AssistantRoutineOut, paused: boolean) {
    setBusy(r.id);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/assistant_routine.update', {
          body: { workspaceId, routineId: r.id, paused },
        }),
      );
      setItems((all) =>
        all.map((x) => (x.id === r.id ? { ...x, paused, nextRunAt: out.nextRunAt } : x)),
      );
      toast.success(paused ? 'Paused.' : 'Turned on again.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(r: AssistantRoutineOut) {
    setBusy(r.id);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/assistant_routine.delete', {
          body: { workspaceId, routineId: r.id },
        }),
      );
      setItems((all) => all.filter((x) => x.id !== r.id));
      toast.success('Deleted.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
      setDeleting(null);
    }
  }

  return (
    <div className="mt-6" id="assistant-routines" data-testid="assistant-routines">
      <h3 className="text-[15px] font-semibold">What you asked the Assistant for</h3>
      <p className="mt-1 text-[13px] text-text-2">
        Questions it asks for you on a schedule, and alerts. Only you see these.
      </p>
      {items.length === 0 ? (
        <p className="mt-3 rounded-control bg-card-2 px-3 py-2.5 text-[13px] text-text-2">
          Nothing yet. Ask the Assistant something like “Every Monday at 8, tell me who owes money”
          or “Tell me when Bob writes back.”
        </p>
      ) : (
        <ul className="mt-3 flex flex-col">
          {items.map((r, i) => (
            <li
              key={r.id}
              className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 ${
                i === items.length - 1 ? '' : 'border-b border-border'
              }`}
              data-testid={`routine-${r.id}`}
            >
              <div className="min-w-0">
                <span className="block font-medium">
                  {r.kind === 'question' ? r.question : r.when}
                </span>
                <span className="mt-0.5 block text-[12.5px] text-text-3">
                  {r.kind === 'question' ? `${r.when} · ` : ''}
                  {routineStatusWords(r, (iso) => dayTime(iso, timeZone))}
                  {r.kind === 'question' && r.email ? ' · By email too' : ''}
                </span>
              </div>
              {deleting === r.id ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busy === r.id}
                    onClick={() => void remove(r)}
                    data-testid={`routine-delete-yes-${r.id}`}
                  >
                    Delete it
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>
                    Keep it
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === r.id}
                    onClick={() => void pause(r, !r.paused)}
                    data-testid={`routine-pause-${r.id}`}
                  >
                    {r.paused ? 'Turn on again' : 'Pause'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === r.id}
                    onClick={() => setDeleting(r.id)}
                    data-testid={`routine-delete-${r.id}`}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
