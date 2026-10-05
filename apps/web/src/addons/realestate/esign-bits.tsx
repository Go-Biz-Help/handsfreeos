'use client';
/**
 * Sending a deal's document for signing through the brokerage's DocuSign or Dotloop (round five; boards 69, 70), on
 * Documents: who signs and in what order, then the agent places the fields and sends it there. Each envelope's panel
 * says where signing stands, person by person, and what can be done: open it at the service, remind (DocuSign), say
 * it's signed (Dotloop, which doesn't say), or void it. The signed copy comes back to Documents, locked.
 *
 * Only the worker holds the services' sign-ins, so opening, reminding and looking again ask the worker's actions
 * (`realestate.esign.open`, `.remind`, `.check`); the rest are commands.
 */
import { ESIGN_PROVIDERS, SIGNER_STATES } from '@hfos/core/addons/realestate/esign';
import { Loader2, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { cn, relativeTime } from '@/lib/utils';
import { firstNames } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import type { DealDocument, EsignList } from './types';
import { useAct } from './use-act';

export type Envelope = EsignList['envelopes'][number];
type Provider = Envelope['provider'];

/** Someone on the deal who might sign, with the email they'd sign with. */
export interface SignerChoice {
  readonly name: string;
  readonly email: string | null;
  /** "Buyer", "Seller", "Lender". */
  readonly label: string;
  /** The deal's clients sign by default. */
  readonly client: boolean;
}

const action = <T,>(name: string, envelopeId: string, workspaceId: string) =>
  workerPost<T>(`/v1/addons/realestate/actions/${name}`, { workspaceId, input: { envelopeId } });

/** Opens the envelope at its service: placing the fields and sending, or seeing it there. */
export async function openEnvelope(workspaceId: string, envelopeId: string) {
  const { url } = await action<{ url: string }>('realestate.esign.open', envelopeId, workspaceId);
  window.location.assign(url);
}

const STATE_BADGE: Readonly<Record<Envelope['state'], 'ok' | 'pending' | 'danger' | 'gray'>> = {
  preparing: 'gray',
  draft: 'pending',
  sent: 'pending',
  completed: 'ok',
  declined: 'danger',
  voided: 'gray',
  failed: 'danger',
};

/** "Jamie signed 2 hours ago · waiting on Chris · then Robert" */
export function signingLine(e: Envelope): string {
  if (e.state !== 'sent') return e.stateLabel;
  const signed = e.signers.filter((s) => s.state === 'signed');
  const left = e.signers.filter((s) => s.state !== 'signed' && s.state !== 'declined');
  const next = left.length ? Math.min(...left.map((s) => s.order)) : null;
  const now = left.filter((s) => s.order === next);
  const later = left.filter((s) => s.order !== next);
  return [
    ...signed.map(
      (s) => `${firstNames([s.name])} signed${s.signedAt ? ` ${relativeTime(s.signedAt)}` : ''}`,
    ),
    now.length ? `waiting on ${firstNames(now.map((s) => s.name))}` : null,
    later.length ? `then ${firstNames(later.map((s) => s.name))}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

interface Row {
  key: number;
  name: string;
  email: string;
  /** Signs with the one before, at the same time. */
  together: boolean;
}

/** Board 69: who signs, in order, and a message; then it's got ready at the service. */
export function SendForSigningDialog({
  workspaceId,
  document,
  connected,
  people,
  onClose,
  onPrepared,
}: {
  workspaceId: string;
  document: DealDocument | null;
  connected: EsignList['connected'];
  people: readonly SignerChoice[];
  onClose: () => void;
  onPrepared: (envelopeId: string) => void;
}) {
  const usable = connected.filter((c) => !c.failing);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [message, setMessage] = useState('');
  const { busy, errors, act } = useAct();
  // Opened for a document: the clients first, together, as most of a deal's papers go.
  useEffect(() => {
    if (!document) return;
    setProvider(usable[0]?.provider ?? null);
    setRows(
      people
        .filter((p) => p.client)
        .map((p, i) => ({ key: i, name: p.name, email: p.email ?? '', together: i > 0 })),
    );
    setMessage('');
  }, [document?.documentId]);
  const others = people.filter((p) => !rows.some((r) => r.name === p.name));
  const add = (p?: SignerChoice) =>
    setRows([
      ...rows,
      {
        key: Math.max(0, ...rows.map((r) => r.key)) + 1,
        name: p?.name ?? '',
        email: p?.email ?? '',
        together: false,
      },
    ]);
  const orders = rows.reduce<number[]>(
    (out, r, i) => [...out, i === 0 ? 1 : r.together ? out[i - 1]! : out[i - 1]! + 1],
    [],
  );
  const using = connected.find((c) => c.provider === provider);
  return (
    <Dialog open={document !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={document ? `Send “${document.title}” for signing` : 'Send for signing'}
        className="max-h-[92dvh] w-[min(620px,calc(100vw-32px))] overflow-y-auto"
      >
        {!usable.length ? (
          <Callout tone="warning" className="mt-4" data-testid="esign-none">
            {connected.length
              ? `${connected.map((c) => c.label).join(' and ')} stopped working here. An owner can sign in again in Deal settings → Connections.`
              : 'No e-signature service is connected. An owner can connect DocuSign or Dotloop in Deal settings → Connections.'}
          </Callout>
        ) : (
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!document) return;
              void act(
                'send',
                async () => {
                  const out = unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.esign.prepare', {
                      body: {
                        workspaceId,
                        documentId: document.documentId,
                        ...(provider ? { provider } : {}),
                        ...(message.trim() ? { message: message.trim() } : {}),
                        signers: rows.map((r, i) => ({
                          name: r.name.trim(),
                          email: r.email.trim(),
                          order: orders[i]!,
                        })),
                      },
                    }),
                  );
                  onPrepared(out.envelopeId);
                },
                `Getting it ready in ${using?.label ?? 'the service'}.`,
              );
            }}
          >
            {usable.length > 1 ? (
              <div>
                <div className="mb-1.5 text-[13px] font-medium">With</div>
                <div className="flex gap-1.5" role="radiogroup" aria-label="With">
                  {usable.map((c) => (
                    <button
                      key={c.provider}
                      type="button"
                      role="radio"
                      aria-checked={provider === c.provider}
                      onClick={() => setProvider(c.provider)}
                      className={cn(
                        'rounded-control border px-3 py-1.5 text-[13px]',
                        provider === c.provider
                          ? 'border-accent bg-accent-soft font-medium text-accent-text'
                          : 'border-border text-text-2 hover:text-text',
                      )}
                      data-testid={`esign-with-${c.provider}`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div>
              <div className="mb-1.5 text-[13px] font-medium">Who signs, in order</div>
              <ol className="space-y-2">
                {rows.map((r, i) => (
                  <li
                    key={r.key}
                    className="flex flex-wrap items-center gap-2"
                    data-testid="esign-signer"
                  >
                    <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-card-2 text-[12px] font-semibold">
                      {orders[i]}
                    </span>
                    <Input
                      aria-label="Name"
                      placeholder="Name"
                      className="min-w-[9rem] flex-1"
                      value={r.name}
                      onChange={(e) =>
                        setRows(
                          rows.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)),
                        )
                      }
                      invalid={!!errors[`signers.${i}.name`]}
                    />
                    <Input
                      aria-label="Email"
                      type="email"
                      placeholder="Email"
                      className="min-w-[12rem] flex-[1.4]"
                      value={r.email}
                      onChange={(e) =>
                        setRows(
                          rows.map((x) => (x.key === r.key ? { ...x, email: e.target.value } : x)),
                        )
                      }
                      invalid={!!errors[`signers.${i}.email`]}
                    />
                    <button
                      type="button"
                      aria-label={`Take ${r.name || 'them'} off`}
                      className="grid h-8 w-8 flex-none place-items-center rounded text-text-3 hover:text-danger-text"
                      onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                    >
                      <X className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                    {i > 0 ? (
                      <label className="flex w-full items-center gap-1.5 pl-8 text-[12.5px] text-text-2">
                        <input
                          type="checkbox"
                          checked={r.together}
                          onChange={(e) =>
                            setRows(
                              rows.map((x) =>
                                x.key === r.key ? { ...x, together: e.target.checked } : x,
                              ),
                            )
                          }
                        />
                        At the same time as the one above
                      </label>
                    ) : null}
                    {errors[`signers.${i}.email`] || errors[`signers.${i}.name`] ? (
                      <p className="w-full pl-8 text-[12.5px] text-danger-text">
                        {errors[`signers.${i}.name`] ?? errors[`signers.${i}.email`]}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
              {errors.signers ? (
                <p className="mt-1 text-[12.5px] text-danger-text">{errors.signers}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {others.map((p) => (
                  <Button key={p.name} size="sm" variant="ghost" onClick={() => add(p)}>
                    <Plus className="h-3.5 w-3.5" strokeWidth={2} /> {p.name} · {p.label}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => add()} data-testid="esign-add">
                  <Plus className="h-3.5 w-3.5" strokeWidth={2} /> Someone else
                </Button>
              </div>
            </div>
            <Field label="Message (optional)" htmlFor="esign-message" error={errors.message}>
              <Textarea
                id="esign-message"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </Field>
            <p className="text-[12.5px] text-text-3">
              {using
                ? `Sent from ${using.label}${using.account ? ` (${using.account})` : ''}. `
                : ''}
              You place the fields and send it there. When everyone has signed, the signed copy
              {provider === 'docusign' ? ' and its certificate come' : ' comes'} back to Documents,
              locked, as proof.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={busy === 'send'}
                disabled={!rows.length}
                data-testid="esign-send"
              >
                Get it ready to send
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Board 70: one envelope, person by person, and what can be done with it. */
export function EnvelopePanel({
  workspaceId,
  envelope: e,
  onClose,
}: {
  workspaceId: string;
  envelope: Envelope | null;
  onClose: () => void;
}) {
  const { busy, act } = useAct();
  const [voiding, setVoiding] = useState(false);
  if (!e) return null;
  const name = ESIGN_PROVIDERS[e.provider];
  const worker = (key: string, run: () => Promise<unknown>, done?: string) => act(key, run, done);
  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent
          title={`${e.documentTitle} · ${e.providerLabel}`}
          description={e.words}
          className="max-h-[92dvh] w-[min(520px,calc(100vw-32px))] overflow-y-auto"
        >
          <div className="mt-4 space-y-4" data-testid="esign-panel">
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-2">
              <Badge variant={STATE_BADGE[e.state]} data-testid="esign-state">
                {e.state === 'preparing' ? (
                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                ) : null}
                {e.stateLabel}
              </Badge>
              {e.sentAt ? `Sent ${relativeTime(e.sentAt)}` : `Started ${relativeTime(e.createdAt)}`}
              {e.createdByName ? ` by ${e.createdByName}` : ''}
            </div>
            {e.failure && e.state !== 'failed' ? (
              <Callout tone="warning">{e.failure}</Callout>
            ) : null}
            <ol className="divide-y divide-border rounded-card border border-border">
              {e.signers.map((s, i) => (
                <li
                  key={`${s.email}-${i}`}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[13.5px]"
                >
                  <div className="min-w-0">
                    <div className="font-medium">
                      {s.order}. {s.name}
                    </div>
                    <div className="truncate text-[12.5px] text-text-3">{s.email}</div>
                  </div>
                  <span
                    className={cn(
                      'flex-none text-[12.5px]',
                      s.state === 'signed'
                        ? 'text-success-text'
                        : s.state === 'declined'
                          ? 'text-danger-text'
                          : 'text-text-2',
                    )}
                  >
                    {SIGNER_STATES[s.state]}
                    {s.state === 'signed' && s.signedAt ? ` ${relativeTime(s.signedAt)}` : ''}
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              {e.can.open ? (
                <Button
                  size="sm"
                  loading={busy === 'open'}
                  onClick={() => void worker('open', () => openEnvelope(workspaceId, e.id))}
                  data-testid="esign-open"
                >
                  {e.state === 'draft' ? `Place the fields and send in ${name}` : `Open in ${name}`}
                </Button>
              ) : null}
              {e.provider === 'docusign' && e.state === 'sent' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'remind'}
                  onClick={() =>
                    void worker(
                      'remind',
                      () => action('realestate.esign.remind', e.id, workspaceId),
                      `${name} emailed whoever hasn’t signed yet.`,
                    )
                  }
                  data-testid="esign-remind"
                >
                  Remind them
                </Button>
              ) : null}
              {e.can.markSigned ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'signed'}
                  onClick={() =>
                    confirm(
                      `Has everyone signed “${e.documentTitle}” in ${name}? The signed copy is fetched from ${name} and kept, locked.`,
                    ) &&
                    void act(
                      'signed',
                      async () =>
                        unwrap(
                          await apiBrowser().POST('/v1/commands/realestate.esign.mark_signed', {
                            body: { workspaceId, envelopeId: e.id },
                          }),
                        ),
                      `Fetching the signed copy from ${name}.`,
                    )
                  }
                  data-testid="esign-mark-signed"
                >
                  It’s signed
                </Button>
              ) : null}
              {e.state === 'draft' || e.state === 'sent' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === 'check'}
                  onClick={() =>
                    void worker(
                      'check',
                      () => action('realestate.esign.check', e.id, workspaceId),
                      'Looked again.',
                    )
                  }
                  data-testid="esign-check"
                >
                  Look again
                </Button>
              ) : null}
              {e.can.void ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger-text"
                  onClick={() => setVoiding(true)}
                  data-testid="esign-void"
                >
                  Void it…
                </Button>
              ) : null}
            </div>
            <p className="text-[12.5px] text-text-3">
              {e.provider === 'docusign'
                ? 'Watched through DocuSign’s updates. If they stop coming, it says so here; it’s never marked signed without the signed copy.'
                : 'Dotloop doesn’t say when everyone has signed. Press “It’s signed” then, and the signed copy comes back from Dotloop.'}
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <ReasonDialog
        open={voiding}
        onOpenChange={setVoiding}
        title={`Void “${e.documentTitle}” in ${name}?`}
        description={`Nobody can sign it after this; ${name} tells the signers it was voided.`}
        submit="Void it"
        danger
        done="Voided."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.esign.void', {
              body: { workspaceId, envelopeId: e.id, reason },
            }),
          )
        }
      />
    </>
  );
}
