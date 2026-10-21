'use client';
/**
 * Settings → Facebook & Instagram (20261025000200): the Facebook Pages and Instagram accounts whose direct messages
 * come to the inbox, the Facebook sign-in they came through, and connecting more.
 *
 * Connect starts a one-time state with `meta_connection.connect`, then the browser goes to the worker's
 * `/oauth/facebook/start`. Facebook sends it back through the worker to /app/oauth/finish, which asks which Pages
 * when the sign-in manages several, and the worker comes back here with `?meta=`.
 */
import { metaAccountLabel } from '@hfos/core';
import { CircleAlert, MoreHorizontal, Plus, Unplug } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { ChannelIcon } from '@/components/inbox/bits';
import { InstagramIcon, MessengerIcon } from '@/components/inbox/social-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { MetaAccount, MetaAccountList, MetaConnection } from '@/lib/api/types';
import { publicEnv } from '@/lib/env';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { relativeTime } from '@/lib/utils';
import { settingAttrs } from './setting-anchor';

/** What the worker came back with, from `?meta=` and its counts. */
export interface MetaResult {
  readonly meta: string;
  readonly facebook: number;
  readonly instagram: number;
  readonly skipped: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function resultWords(r: MetaResult): { tone: 'success' | 'info' | 'error'; text: string } {
  if (r.meta === 'connected') {
    const what = [
      r.facebook ? plural(r.facebook, 'Facebook Page', 'Facebook Pages') : null,
      r.instagram ? plural(r.instagram, 'Instagram account', 'Instagram accounts') : null,
    ]
      .filter(Boolean)
      .join(' and ');
    const skipped = r.skipped
      ? ` ${plural(r.skipped, 'other was', 'others were')} connected to another business in the meantime.`
      : '';
    return {
      tone: 'success',
      text: `Connected ${what || 'Facebook'}. Their messages arrive in the inbox from now on.${skipped}`,
    };
  }
  if (r.meta === 'cancelled')
    return { tone: 'info', text: 'Sign-in cancelled. Nothing was connected.' };
  return {
    tone: 'error',
    text: 'Facebook didn’t connect. Choose Connect Facebook again in a minute.',
  };
}

/** Starts connecting: a one-time state, then Facebook's own sign-in. */
async function connectFacebook(workspaceId: string): Promise<void> {
  const out = unwrap(
    await apiBrowser().POST('/v1/commands/meta_connection.connect', { body: { workspaceId } }),
  );
  window.location.assign(
    `${publicEnv.workerUrl}/oauth/facebook/start?state=${encodeURIComponent(out.state)}`,
  );
}

/** Why a Page or account isn't answering, and what fixes it. */
function troubleOf(a: MetaAccount): string | null {
  if (a.status === 'disconnected') return null;
  if (a.status === 'needs_attention')
    return a.problem === 'revoked'
      ? 'HandsFreeOS was removed from it on Facebook, so its messages stopped. Connect Facebook again to bring it back.'
      : a.problem === 'failed'
        ? 'Meta stopped sending its messages here. Connect Facebook again to fix it.'
        : 'Its Facebook sign-in stopped working, so replies can’t go out. Connect Facebook again to fix it.';
  if (!a.subscribed)
    return 'Meta hasn’t started sending its messages here yet. HandsFreeOS asks again each day, or connect Facebook again now.';
  return null;
}

export function FacebookInstagramPage({
  workspaceId,
  data,
  result,
}: {
  workspaceId: string;
  data: MetaAccountList;
  result: MetaResult | null;
}) {
  const router = useRouter();
  useLiveRefresh(['meta_account', 'meta_connection']);
  const [busy, setBusy] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<
    | { kind: 'account'; account: MetaAccount }
    | { kind: 'connection'; connection: MetaConnection }
    | null
  >(null);

  const told = useRef(false);
  useEffect(() => {
    if (!result || told.current) return;
    told.current = true;
    const r = resultWords(result);
    if (r.tone === 'success') toast.success(r.text);
    else if (r.tone === 'error') toast.error(r.text);
    else toast(r.text);
    router.replace(`/app/w/${workspaceId}/settings/facebook-instagram`, { scroll: false });
  }, [result, router, workspaceId]);

  const connected = data.accounts.filter((a) => a.status !== 'disconnected');
  const gone = data.accounts.filter((a) => a.status === 'disconnected' && a.conversations > 0);
  const humanAgent = connected.some((a) => a.humanAgent);
  const readsAds = data.connections.some((c) => c.readsAds);

  async function connect() {
    setBusy('connect');
    try {
      await connectFacebook(workspaceId);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!leaving) return;
    setBusy('leave');
    try {
      if (leaving.kind === 'account') {
        unwrap(
          await apiBrowser().POST('/v1/commands/meta_account.disconnect', {
            body: { workspaceId, accountId: leaving.account.id },
          }),
        );
        toast.success(`${metaAccountLabel(leaving.account)} is disconnected.`);
      } else {
        unwrap(
          await apiBrowser().POST('/v1/commands/meta_connection.disconnect', {
            body: { workspaceId, connectionId: leaving.connection.id },
          }),
        );
        toast.success('Facebook is disconnected.');
      }
      setLeaving(null);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5" data-testid="facebook-instagram">
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-[560px]">
            <h2 className="text-lg font-semibold tracking-tight">Facebook & Instagram</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-text-2">
              Messenger and Instagram direct messages to your business arrive in the inbox, and you
              answer them there. When someone writes from one of your ads, their conversation and
              their customer record show which ad brought them.
            </p>
          </div>
          <Button
            onClick={() => void connect()}
            loading={busy === 'connect'}
            disabled={busy !== null}
            data-testid="meta-connect"
          >
            {busy === 'connect' ? null : <Plus className="h-4 w-4" strokeWidth={1.5} />}
            {connected.length ? 'Connect more' : 'Connect Facebook'}
          </Button>
        </div>
        <ul className="mt-4 flex flex-col gap-1.5 text-[13px] text-text-2">
          <li>
            Sign in with a Facebook account that manages your business’s Page. Facebook asks which
            Pages and Instagram accounts HandsFreeOS may use, and for permission to manage their
            messages: leave every permission ticked. Then you pick which Pages answer here.
          </li>
          <li>
            An Instagram account comes along with the Page it’s linked to, once it’s a professional
            account linked in the Page’s settings. In the Instagram app, also turn on Allow access
            to messages, under Messages and story replies → Connected tools.
          </li>
          <li>
            {humanAgent
              ? 'You can reply within 7 days of a customer’s last message; workflows, within a day.'
              : 'Replies can go within a day of a customer’s last message, as Meta allows.'}
          </li>
        </ul>
      </Card>

      <Card className="p-6" {...settingAttrs('facebook_instagram.accounts')}>
        <h2 className="text-[15px] font-semibold">Pages and accounts</h2>
        {connected.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-3" data-testid="meta-none">
            Nothing is connected yet. Choose Connect Facebook to bring your Page’s Messenger and
            Instagram messages into the inbox.
          </p>
        ) : (
          <div className="mt-3 flex flex-col">
            {connected.map((a, i) => (
              <AccountRow
                key={a.id}
                account={a}
                first={i === 0}
                onDisconnect={() => setLeaving({ kind: 'account', account: a })}
              />
            ))}
          </div>
        )}
        {gone.length ? (
          <div className="mt-4 border-t border-border pt-3">
            <h3 className="text-[13px] font-medium text-text-2">Not connected anymore</h3>
            <p className="mt-0.5 text-xs text-text-3">
              Their conversations stay in the inbox. Connect Facebook again to answer them.
            </p>
            {gone.map((a) => (
              <AccountRow key={a.id} account={a} first={false} />
            ))}
          </div>
        ) : null}
      </Card>

      {data.connections.length ? (
        <Card className="p-6" {...settingAttrs('facebook_instagram.sign_in')}>
          <h2 className="text-[15px] font-semibold">Facebook sign-in</h2>
          <p className="mt-1 text-[13px] text-text-2">
            {readsAds
              ? 'It may read your ads, so a conversation that starts from one shows its campaign, ad set and ad.'
              : 'It can’t read your ads, so a conversation from an ad shows the ad’s id but not its campaign. Connect Facebook again and allow ads to see them.'}
          </p>
          <div className="mt-3 flex flex-col">
            {data.connections.map((c, i) => (
              <div
                key={c.id}
                className={i ? 'border-t border-border py-3' : 'py-3'}
                data-testid={`meta-connection-${c.id}`}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {c.facebookUserName ?? 'Facebook'}
                      {c.status === 'needs_attention' ? (
                        <Badge variant="pending">Needs attention</Badge>
                      ) : (
                        <Badge variant="ok">Connected</Badge>
                      )}
                      {c.readsAds ? <Badge variant="gray">Reads ads</Badge> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-text-3">
                      {[
                        c.connectedBy ? `Connected by ${c.connectedBy.fullName}` : null,
                        c.connectedAt ? relativeTime(c.connectedAt) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {c.status === 'needs_attention' ? (
                      <Callout tone="warning" icon={CircleAlert} className="mt-2 px-3 py-2.5">
                        This sign-in stopped working. Connect Facebook again with an account that
                        manages your Pages.
                      </Callout>
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setLeaving({ kind: 'connection', connection: c })}
                    data-testid={`meta-connection-disconnect-${c.id}`}
                  >
                    <Unplug className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Disconnect
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Dialog open={!!leaving} onOpenChange={(o) => (o ? null : setLeaving(null))}>
        {leaving ? (
          <DialogContent
            title={
              leaving.kind === 'account'
                ? `Disconnect ${metaAccountLabel(leaving.account)}?`
                : 'Disconnect Facebook?'
            }
            description={
              leaving.kind === 'account'
                ? 'Its messages stop coming to HandsFreeOS, and replies can’t go out from here. Its conversations stay, and nothing changes on Facebook or Instagram.'
                : 'HandsFreeOS stops answering every Page and Instagram account this sign-in connected. Conversations and their messages stay, and nothing changes on Facebook or Instagram.'
            }
          >
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setLeaving(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                loading={busy === 'leave'}
                onClick={() => void disconnect()}
                data-testid="meta-disconnect-confirm"
              >
                Disconnect
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function AccountRow({
  account: a,
  first,
  onDisconnect,
}: {
  account: MetaAccount;
  first: boolean;
  onDisconnect?: () => void;
}) {
  const trouble = troubleOf(a);
  const instagram = a.platform === 'instagram';
  return (
    <div
      className={first ? 'py-3' : 'border-t border-border py-3'}
      data-testid={`meta-account-${a.id}`}
      data-status={a.status}
    >
      <div className="flex items-start gap-3">
        <ChannelIcon icon={instagram ? InstagramIcon : MessengerIcon} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span className="truncate">{metaAccountLabel(a)}</span>
            {a.status === 'disconnected' ? (
              <Badge variant="gray">Disconnected</Badge>
            ) : trouble ? (
              <Badge variant="pending">Needs attention</Badge>
            ) : (
              <Badge variant="ok">Answering here</Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-text-3">
            {[
              instagram
                ? a.username && a.name
                  ? `Instagram · ${a.name}`
                  : 'Instagram'
                : 'Facebook Page · Messenger',
              plural(a.conversations, 'conversation', 'conversations'),
            ].join(' · ')}
          </p>
          {trouble ? (
            <Callout tone="warning" icon={CircleAlert} className="mt-2 px-3 py-2.5">
              {trouble}
            </Callout>
          ) : null}
        </div>
        {onDisconnect ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`More for ${metaAccountLabel(a)}`}
                data-testid={`meta-account-menu-${a.id}`}
              >
                <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={onDisconnect}
                data-testid={`meta-account-disconnect-${a.id}`}
              >
                <Unplug className="h-3.5 w-3.5" strokeWidth={1.5} />
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
