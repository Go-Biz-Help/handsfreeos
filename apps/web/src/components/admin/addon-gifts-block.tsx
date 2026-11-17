'use client';
import {
  ADDON_CATALOG,
  addonGiftRows,
  type AddonGiftRecord,
  type AddonSubscriptionRecord,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * Add-ons given free (Real Estate step 2, then 20261027028500): an add-on still being built, handed to this business to
 * try, or a paid one given free until staff take it back or until a last free day, with a note for whoever looks
 * next. Its owners and admins then add it from their own Add-ons page. Taking a gift back stops new installs; a paid
 * one they don't pay for turns off within the hour (nothing is deleted), and a free one keeps running.
 */
export function AddonGiftsBlock({
  workspaceId,
  grants,
  subscriptions,
  canChange,
}: {
  workspaceId: string;
  grants: readonly AddonGiftRecord[];
  subscriptions: readonly AddonSubscriptionRecord[];
  canChange: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const rows = addonGiftRows(ADDON_CATALOG, grants, subscriptions);

  const run = async (addonId: string, call: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(addonId);
    setError(null);
    try {
      await call();
      setEditing(null);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const give = (addonId: string, body: { freeUntil?: string; note?: string } = {}) =>
    run(addonId, async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/addon_grant.give', {
          body: { workspaceId, addonId, ...body },
        }),
      ),
    );
  const takeBack = (addonId: string) =>
    run(addonId, async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/addon_grant.take_back', {
          body: { workspaceId, addonId },
        }),
      ),
    );
  const edit = (row: (typeof rows)[number]) => {
    setEditing(row.addonId);
    setUntil(row.lastFreeDay ?? '');
    setNote(row.note ?? '');
    setError(null);
  };

  if (!rows.length && !grants.length) return null;
  return (
    <section
      className="mt-5 rounded-card border border-border bg-card p-4"
      data-testid="admin-addon-testing"
    >
      <h2 className="text-sm font-semibold">Give add-ons free</h2>
      <p className="mt-1 text-[13px] text-text-3">
        Give this business an add-on free: one still being built, to try it, or a paid one. Its
        owners and admins add it from their Add-ons page. Set a last free day if it should end; they
        can choose to keep paying after that. Taking one back stops new installs, and a paid one
        they don’t pay for turns off within the hour. Nothing is deleted.
      </p>
      <ul className="mt-3 flex flex-col divide-y divide-border text-[13px]">
        {rows.map((r) => {
          const open = editing === r.addonId;
          return (
            <li
              key={r.addonId}
              className="py-2.5 first:pt-0 last:pb-0"
              data-testid={`admin-addon-gift-${r.addonId}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <div className="min-w-0">
                  <span className="font-medium">{r.name}</span>
                  <span className="text-text-3"> · {r.price}</span>
                  <span
                    className="block text-text-2"
                    data-testid={`admin-addon-gift-status-${r.addonId}`}
                  >
                    {r.status}
                    {r.paying ? ` · ${r.paying}` : ''}
                  </span>
                  {r.note ? <span className="block text-xs text-text-3">“{r.note}”</span> : null}
                </div>
                {canChange && !open ? (
                  <div className="flex flex-wrap gap-2">
                    {r.given ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => edit(r)}
                        data-testid={`admin-addon-gift-edit-${r.addonId}`}
                      >
                        {r.lastFreeDay ? 'Change end date' : 'Set an end date'}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant={r.given ? 'secondary' : 'primary'}
                      loading={busy === r.addonId}
                      disabled={busy !== null}
                      onClick={() => void (r.given ? takeBack(r.addonId) : give(r.addonId))}
                      data-testid={`admin-addon-testing-${r.addonId}`}
                    >
                      {r.given ? 'Take back' : 'Give free'}
                    </Button>
                  </div>
                ) : null}
              </div>
              {open ? (
                <form
                  className="mt-2 flex flex-wrap items-end gap-2"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    void give(r.addonId, {
                      ...(until ? { freeUntil: until } : {}),
                      ...(note.trim() ? { note: note.trim() } : {}),
                    });
                  }}
                >
                  <Field
                    label="Last free day (empty: until taken back)"
                    htmlFor={`gift-until-${r.addonId}`}
                  >
                    <Input
                      id={`gift-until-${r.addonId}`}
                      type="date"
                      inputSize="sm"
                      min={todayUtc()}
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                      data-testid={`admin-addon-gift-until-${r.addonId}`}
                    />
                  </Field>
                  <Field
                    label="Note"
                    htmlFor={`gift-note-${r.addonId}`}
                    className="min-w-[200px] flex-1"
                  >
                    <Input
                      id={`gift-note-${r.addonId}`}
                      inputSize="sm"
                      maxLength={300}
                      placeholder="Why, for whoever looks next"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      data-testid={`admin-addon-gift-note-${r.addonId}`}
                    />
                  </Field>
                  <Button
                    size="sm"
                    type="submit"
                    loading={busy === r.addonId}
                    data-testid={`admin-addon-gift-save-${r.addonId}`}
                  >
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </section>
  );
}
