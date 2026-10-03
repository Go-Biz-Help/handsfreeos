'use client';
/**
 * An add-on's connections to other services (round five; boards 62 and 63): each thing it connects (its listing
 * feed, its e-sign), the accounts connected for it with their health, and how to connect another: a key the business
 * pastes, tried at the service before it's kept, or a sign-in. Any add-on with `connectors` in its manifest uses it.
 *
 * - Keys and sign-ins are the worker's: it tries and seals them (`POST /v1/addons/connections/key`) and runs the
 *   sign-in (`/v1/addons/connections/sign-in`), so nothing secret passes through the API or comes back.
 * - A connection that stops working says so first, with what it affects (from the add-on) and what to do.
 * - Only people who may manage a connector see its buttons (`canManage`); everyone else sees how it is.
 */
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { AddonConnectionList, AddonConnectionRow, AddonConnector } from '@/lib/api/types';
import { workerPost } from '@/lib/api/worker';
import { cn, relativeTime } from '@/lib/utils';
import { toast } from 'sonner';

type Provider = AddonConnector['providers'][number];

/** "DS" for DocuSign, "AP" for AnyProp, "R" for Repliers. */
const initials = (label: string) => {
  const caps = label.match(/[A-Z]/g) ?? [];
  if (caps.length >= 2 && !label.includes(' ')) return caps.slice(0, 2).join('');
  return (
    label
      .replace(/[’'()]/g, '')
      .split(/\s+/)
      .filter((w) => /^[A-Za-z]/.test(w))
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '·'
  );
};

/** The MLSs a listing-data account reaches, when the service said so when it was tried. */
function mlsWords(details: Readonly<Record<string, unknown>>): string | null {
  const mlss = Array.isArray(details.mlss) ? details.mlss.filter((m) => typeof m === 'string') : [];
  return mlss.length ? mlss.join(', ') : null;
}

const ROW =
  'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-border p-3.5';
/** A row's words: wide enough that its buttons go under them on a phone rather than squeezing them. */
const ROW_WORDS = 'min-w-[11rem] flex-1 basis-[14rem]';

const STATUS: Record<
  AddonConnectionRow['status'],
  { words: string; variant: 'ok' | 'pending' | 'danger' | 'gray' }
> = {
  active: { words: 'Connected', variant: 'ok' },
  pending: { words: 'Signing in…', variant: 'pending' },
  reauth_required: { words: 'Sign in again', variant: 'danger' },
  error: { words: 'Not working', variant: 'danger' },
  disconnected: { words: 'Off', variant: 'gray' },
};

/** What's wrong with a connection, and what to do, in words; null when it's fine. */
function troubleWords(
  c: AddonConnectionRow,
  provider: Provider | undefined,
  platform: boolean,
): string | null {
  const name = c.providerLabel;
  if (c.status === 'reauth_required')
    return provider?.auth.includes('oauth')
      ? `${name} turned the sign-in down. Sign in again to keep it working.`
      : `${name} turned the key down. Paste a new one${platform ? ', or switch back to HandsFreeOS’s account' : ', or let it go'}.`;
  if (c.status === 'error')
    return `${name} isn’t answering${c.lastError ? `: ${c.lastError}` : '.'} HandsFreeOS keeps trying; nothing is marked done because of it.`;
  return null;
}

export function AddonConnections({
  workspaceId,
  addonId,
  list,
  about = {},
  uses = {},
  ownAccount = {},
  back,
  children,
}: {
  workspaceId: string;
  addonId: string;
  list: AddonConnectionList;
  /** One line about what each connector is for, by its key. */
  about?: Readonly<Record<string, string>>;
  /** What hangs on each connector, by its key: "3 listings and 5 buyers’ searches use it.", and how many. */
  uses?: Readonly<Record<string, { readonly words: string; readonly count: number }>>;
  /** For a connector HandsFreeOS connects by default: what using the business's own account means, by its key. */
  ownAccount?: Readonly<Record<string, string>>;
  /** What a sign-in came back with (`?connected=<provider>` or `?signin=cancelled|failed`). */
  back?: { readonly connected?: string | null; readonly signin?: string | null };
  /** Anything more the add-on shows beside them. */
  children?: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [keying, setKeying] = useState<{ connector: AddonConnector; provider: string } | null>(
    null,
  );

  const signIn = async (connector: AddonConnector, provider: Provider) => {
    setBusy(`signin:${connector.key}:${provider.id}`);
    try {
      const { url } = await workerPost<{ url: string }>('/v1/addons/connections/sign-in', {
        workspaceId,
        addonId,
        connector: connector.key,
        provider: provider.id,
      });
      window.location.assign(url);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };
  const disconnect = async (c: AddonConnectionRow, back = false) => {
    if (
      !window.confirm(
        back
          ? `Switch back to HandsFreeOS’s account? Your ${c.providerLabel} key is wiped now; what it already brought in stays.`
          : `Let ${c.providerLabel} go? Its key or sign-in is wiped now; what it already brought in stays.`,
      )
    )
      return;
    setBusy(`off:${c.id}`);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/addon_connection.disconnect', {
          body: { workspaceId, connectionId: c.id },
        }),
      );
      toast.success(
        back ? 'Back on HandsFreeOS’s account.' : `${c.providerLabel} is disconnected.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const trouble = list.connectors.flatMap((k) =>
    k.connections
      .filter((c) => c.inUse || k.many)
      .flatMap((c) => {
        const words = troubleWords(
          c,
          k.providers.find((p) => p.id === c.provider),
          !k.many && c.auth !== 'platform' && k.connections.some((x) => x.auth === 'platform'),
        );
        return words ? [{ k, c, words }] : [];
      }),
  );

  const signedIn = back?.connected
    ? (list.connectors.flatMap((k) => k.providers).find((p) => p.id === back.connected)?.label ??
      null)
    : null;

  return (
    <div className="space-y-4" data-testid="addon-connections">
      {signedIn ? (
        <Callout tone="info" data-testid="signin-back">
          {signedIn} is connected.
        </Callout>
      ) : back?.signin === 'cancelled' ? (
        <Callout tone="neutral" data-testid="signin-back">
          The sign-in was cancelled, so nothing changed.
        </Callout>
      ) : back?.signin ? (
        <Callout tone="danger" data-testid="signin-back">
          The sign-in didn’t finish, so nothing changed. Try again; if it keeps happening, try again
          in a few minutes.
        </Callout>
      ) : null}
      {trouble.map(({ k, c, words }) => (
        <Callout key={c.id} tone="danger" data-testid={`connection-trouble-${c.provider}`}>
          <p className="font-medium">{words}</p>
          {uses[k.key]?.count ? (
            <p className="mt-1 text-[13px]">
              {uses[k.key]!.words} They show what came in last until it works again.
            </p>
          ) : null}
          {k.canManage ? (
            <div className="mt-2 flex gap-2">
              {k.providers.find((p) => p.id === c.provider)?.auth.includes('key') ? (
                <Button size="sm" onClick={() => setKeying({ connector: k, provider: c.provider })}>
                  Paste a new key
                </Button>
              ) : (
                <Button
                  size="sm"
                  loading={busy === `signin:${k.key}:${c.provider}`}
                  onClick={() =>
                    void signIn(
                      k,
                      k.providers.find((p) => p.id === c.provider)!,
                    )
                  }
                >
                  Sign in again
                </Button>
              )}
              {!k.many &&
              c.auth !== 'platform' &&
              k.connections.some((x) => x.auth === 'platform') ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === `off:${c.id}`}
                  onClick={() => void disconnect(c, true)}
                  data-testid={`switch-back-${k.key}`}
                >
                  Switch back to HandsFreeOS’s account
                </Button>
              ) : null}
            </div>
          ) : null}
        </Callout>
      ))}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          {list.connectors.map((k) => {
            const keyable = k.providers.filter((p) => p.auth.includes('key'));
            const unconnected = k.many
              ? k.providers.filter((p) => !k.connections.some((c) => c.provider === p.id))
              : [];
            return (
              <Card key={k.key} className="p-4 md:p-5" data-testid={`connector-${k.key}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                  <h2 className="text-[15px] font-semibold">{k.label}</h2>
                  {about[k.key] ? (
                    <p className="text-[13px] text-text-2 md:max-w-[65%] md:text-right">
                      {about[k.key]}
                    </p>
                  ) : null}
                </div>
                <ul className="mt-3 space-y-2.5">
                  {k.connections.map((c) => {
                    const st = STATUS[c.status];
                    const own = c.auth !== 'platform';
                    return (
                      <li key={c.id} className={ROW} data-testid={`connection-${c.provider}`}>
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-card-2 text-[12px] font-semibold text-text-2">
                          {initials(c.providerLabel)}
                        </span>
                        <div className={ROW_WORDS}>
                          <p className="font-medium">
                            {c.auth === 'platform'
                              ? (c.label ?? `HandsFreeOS’s ${c.providerLabel} account`)
                              : c.providerLabel}{' '}
                            <Badge variant={st.variant}>{st.words}</Badge>
                            {!k.many && !c.inUse ? <Badge variant="gray">Not in use</Badge> : null}
                          </p>
                          <p className="text-[13px] text-text-2">
                            {[
                              mlsWords(c.details),
                              ...(c.auth === 'platform'
                                ? ['turned on by HandsFreeOS']
                                : [
                                    c.label,
                                    c.connectedAt
                                      ? `connected ${relativeTime(c.connectedAt)}`
                                      : null,
                                    c.connectedByName ? `by ${c.connectedByName}` : null,
                                  ]),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                          <p className="text-[12.5px] text-text-3">
                            {c.failingSince
                              ? `Not working since ${relativeTime(c.failingSince)}`
                              : c.lastSuccessAt
                                ? `Last worked ${relativeTime(c.lastSuccessAt)}`
                                : 'Not used yet'}
                          </p>
                        </div>
                        {k.canManage && own ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busy === `off:${c.id}`}
                            onClick={() => void disconnect(c)}
                            data-testid={`disconnect-${c.provider}`}
                          >
                            Disconnect
                          </Button>
                        ) : null}
                        {!k.many && k.canManage && keyable.length && c.inUse ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setKeying({ connector: k, provider: keyable[0]!.id })}
                            data-testid={`own-account-${k.key}`}
                          >
                            {own ? 'Use a different account…' : 'Use your own account…'}
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                  {unconnected.map((p) => (
                    <li key={p.id} className={ROW} data-testid={`connection-${p.id}`}>
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-card-2 text-[12px] font-semibold text-text-3">
                        {initials(p.label)}
                      </span>
                      <div className={ROW_WORDS}>
                        <p className="font-medium">
                          {p.label} <Badge variant="gray">Off</Badge>
                        </p>
                        <p className="text-[13px] text-text-2">Not connected</p>
                      </div>
                      {k.canManage ? (
                        p.auth.includes('oauth') ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy === `signin:${k.key}:${p.id}`}
                            onClick={() => void signIn(k, p)}
                            data-testid={`signin-${p.id}`}
                          >
                            Sign in with {p.label}
                          </Button>
                        ) : p.auth.includes('key') ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setKeying({ connector: k, provider: p.id })}
                          >
                            Connect…
                          </Button>
                        ) : null
                      ) : null}
                    </li>
                  ))}
                  {!k.connections.length && !unconnected.length ? (
                    <li className="py-3 text-[13px] text-text-2">Nothing connected yet.</li>
                  ) : null}
                </ul>
                {!k.many && k.canManage && keyable.length && !k.connections.length ? (
                  <Button
                    className="mt-1"
                    variant="secondary"
                    size="sm"
                    onClick={() => setKeying({ connector: k, provider: keyable[0]!.id })}
                    data-testid={`own-account-${k.key}`}
                  >
                    Connect an account…
                  </Button>
                ) : null}
                {!k.many && k.canManage && keyable.length ? (
                  <div className="mt-2.5">
                    <p className="text-[12.5px] text-text-3">
                      {ownAccount[k.key] ??
                        `Your own ${keyable
                          .map((p) => p.label)
                          .join(', ')
                          .replace(/, ([^,]*)$/, ' or $1')} account replaces it.`}
                    </p>
                  </div>
                ) : null}
                {uses[k.key] && !trouble.some((t) => t.k.key === k.key) ? (
                  <p className="mt-2 text-[12.5px] text-text-3">{uses[k.key]!.words}</p>
                ) : null}
              </Card>
            );
          })}
        </div>
        <div className="space-y-4">
          {children}

          <Card className="p-4 text-[13px] text-text-2 md:p-5">
            <h2 className="text-[15px] font-semibold text-text">Nobody can read a key back</h2>
            <p className="mt-1">
              Keys and sign-ins are sealed when they’re saved. People who run these settings can
              replace or remove one, never see it. A connection that stops working says what it
              affects, and nothing is marked done because of it.
            </p>
          </Card>
        </div>
      </div>

      {keying ? (
        <KeyDialog
          workspaceId={workspaceId}
          addonId={addonId}
          connector={keying.connector}
          initial={keying.provider}
          replacesPlatform={
            !keying.connector.many &&
            keying.connector.connections.some((c) => c.auth === 'platform')
          }
          onClose={() => setKeying(null)}
          onSaved={(label) => {
            setKeying(null);
            toast.success(`${label} is connected.`);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** Pasting a key: tried at the service before anything is kept, then sealed. */
function KeyDialog({
  workspaceId,
  addonId,
  connector,
  initial,
  replacesPlatform,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  addonId: string;
  connector: AddonConnector;
  initial: string;
  /** HandsFreeOS connects this for everyone until the business uses its own. */
  replacesPlatform: boolean;
  onClose: () => void;
  onSaved: (label: string) => void;
}) {
  const choices = connector.providers.filter((p) => p.auth.includes('key'));
  const [providerId, setProviderId] = useState(
    choices.some((p) => p.id === initial) ? initial : choices[0]!.id,
  );
  const provider = choices.find((p) => p.id === providerId)!;
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [trying, setTrying] = useState(false);

  const save = async () => {
    setTrying(true);
    setErrors({});
    try {
      const out = await workerPost<{
        label: string | null;
        details: Readonly<Record<string, unknown>>;
      }>('/v1/addons/connections/key', {
        workspaceId,
        addonId,
        connector: connector.key,
        provider: provider.id,
        fields: Object.fromEntries(
          Object.entries(fields)
            .filter(([, v]) => v.trim())
            .map(([k, v]) => [k, v.trim()]),
        ),
      });
      const mls = mlsWords(out.details ?? {});
      onSaved(`${out.label ?? provider.label}${mls ? ` (${mls})` : ''}`);
    } catch (e) {
      const byField = fieldErrors(e);
      if (Object.keys(byField).length) setErrors(byField);
      else toast.error(errorMessage(e));
    } finally {
      setTrying(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent
        title={`Use your own ${connector.label.toLowerCase()} account`}
        description="Tried with the service before it’s saved, then sealed. Nobody can read it back."
        className="w-[min(520px,calc(100vw-32px))]"
      >
        {choices.length > 1 ? (
          <div className="mt-4 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Supplier">
            {choices.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === providerId}
                onClick={() => {
                  setProviderId(p.id);
                  setFields({});
                  setErrors({});
                }}
                className={cn(
                  'rounded-control border px-3 py-1.5 text-[13px]',
                  p.id === providerId
                    ? 'border-accent bg-accent-soft font-medium text-accent-text'
                    : 'border-border text-text-2 hover:text-text',
                )}
                data-testid={`key-provider-${p.id}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        ) : null}
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {(provider.fields ?? []).map((f) => (
            <Field
              key={f.key}
              label={`${f.label}${f.optional ? ' (optional)' : ''}`}
              htmlFor={`key-${f.key}`}
              hint={f.hint ?? undefined}
              error={errors[`fields.${f.key}`] ?? errors[f.key]}
            >
              <Input
                id={`key-${f.key}`}
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                value={fields[f.key] ?? ''}
                onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
                data-testid={`key-field-${f.key}`}
              />
            </Field>
          ))}
          {replacesPlatform ? (
            <p className="text-[12.5px] text-text-3">
              {provider.label}’s terms are then your business’s, and HandsFreeOS’s own account stops
              being used for you.
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={trying} data-testid="key-save">
              Try it and save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
