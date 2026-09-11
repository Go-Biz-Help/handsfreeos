'use client';
import { KeyRound, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { publicEnv } from '@/lib/env';
import { supabaseBrowser } from '@/lib/supabase/client';
import { relativeTime } from '@/lib/utils';

interface Passkey {
  id: string;
  friendly_name?: string;
  created_at: string;
  last_used_at?: string;
}

export function PasskeysSection() {
  const [list, setList] = useState<Passkey[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<Passkey | null>(null);
  // Decided after mount so server and client render the same markup (no hydration mismatch).
  const [supported, setSupported] = useState(true);

  async function load() {
    const { data, error } = await supabaseBrowser().auth.passkey.list();
    if (error) {
      toast.error(error.message);
      setList([]);
      return;
    }
    setList((data ?? []) as Passkey[]);
  }
  useEffect(() => {
    setSupported('PublicKeyCredential' in window);
    if (publicEnv.passkeysEnabled) void load();
  }, []);

  if (!publicEnv.passkeysEnabled) return null;

  async function add() {
    setBusy('add');
    const { data, error } = await supabaseBrowser().auth.registerPasskey();
    setBusy(null);
    if (error) {
      if (!/cancel|abort|not allowed/i.test(error.message)) toast.error(error.message);
      return;
    }
    toast.success(
      `Passkey added${data?.friendly_name ? ` (${data.friendly_name})` : ''}. You can sign in with it on this device.`,
    );
    await load();
  }

  async function rename() {
    if (!renaming) return;
    setBusy(renaming.id);
    const { error } = await supabaseBrowser().auth.passkey.update({
      passkeyId: renaming.id,
      friendlyName: renaming.name.trim() || 'Passkey',
    });
    setBusy(null);
    if (error) return toast.error(error.message);
    setRenaming(null);
    toast.success('Passkey renamed.');
    await load();
  }

  async function remove(p: Passkey) {
    setBusy(p.id);
    const { error } = await supabaseBrowser().auth.passkey.delete({ passkeyId: p.id });
    setBusy(null);
    setConfirm(null);
    if (error) return toast.error(error.message);
    toast.success(`${p.friendly_name ?? 'Passkey'} removed.`);
    await load();
  }

  return (
    <div id="passkeys" data-testid="passkeys-section">
      <div className="flex items-center justify-between gap-4 pb-2 pt-[18px]">
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold">Passkeys</span>
          <span className="text-[13px] text-text-3">
            Sign in with Touch ID, Face ID or a security key. Phishing-resistant.
          </span>
        </span>
        <Button
          size="sm"
          onClick={() => void add()}
          loading={busy === 'add'}
          disabled={!supported}
          title={supported ? undefined : 'This browser does not support passkeys'}
          data-testid="passkey-add"
        >
          <Plus className="h-[15px] w-[15px]" strokeWidth={1.8} />
          Add passkey
        </Button>
      </div>
      <div className="flex flex-col">
        {list === null ? <div className="py-3.5 text-[13px] text-text-3">Checking…</div> : null}
        {list?.length === 0 ? (
          <div className="py-3.5 text-[13px] text-text-3">
            No passkeys yet. Add one to skip passwords on this device.
          </div>
        ) : null}
        {list?.map((p) => (
          <div key={p.id} className="flex items-center gap-3.5 py-3" data-testid="passkey-row">
            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-menu bg-accent-soft text-accent-text">
              <KeyRound className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              {renaming?.id === p.id ? (
                <span className="flex items-center gap-2">
                  <Input
                    inputSize="sm"
                    className="max-w-[220px]"
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                    autoFocus
                    aria-label="Passkey name"
                  />
                  <Button size="sm" onClick={() => void rename()} loading={busy === p.id}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <span className="font-medium">{p.friendly_name || 'Passkey'}</span>
              )}
              <span className="text-[13px] text-text-3">
                Added{' '}
                {new Date(p.created_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
                {p.last_used_at ? ` · Last used ${relativeTime(p.last_used_at)}` : ''}
              </span>
            </span>
            {renaming?.id === p.id ? null : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRenaming({ id: p.id, name: p.friendly_name ?? '' })}
                >
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger-text"
                  onClick={() => setConfirm(p)}
                  data-testid="passkey-remove"
                >
                  Remove
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
      <Dialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v) setConfirm(null);
        }}
      >
        {confirm ? (
          <DialogContent
            title={`Remove ${confirm.friendly_name ?? 'this passkey'}?`}
            description={
              (list?.length ?? 0) <= 1
                ? 'This is your only passkey. You can still sign in with your password or Google, and add a new passkey any time.'
                : 'You will no longer be able to sign in with this device or password manager. Your other passkeys keep working.'
            }
            className="w-[440px]"
          >
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={busy === confirm.id}
                onClick={() => void remove(confirm)}
                data-testid="passkey-remove-confirm"
              >
                Remove passkey
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
