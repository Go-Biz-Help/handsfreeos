'use client';
import { cellVerifiedOn, formatPhone, MY_CELL_WORDS, normalizePhone } from '@hfos/core';
import { Check, PhoneCall, Smartphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type { CellPhone } from '@/lib/api/types';

/** How long the page keeps looking for the press of 1 after a verification call goes out. */
const WATCH_MS = 3 * 60_000;
const POLL_MS = 2_000;

/**
 * My cell phone (M10): the number HandsFreeOS rings first when someone presses Call in the app, then connects the
 * customer from the business number. Verify my cell has HandsFreeOS call it from this business's number, and pressing
 * 1 on that call confirms it; the page watches for that. A verified cell shows when it was confirmed, the business
 * number to save as a contact (a phone that silences unknown callers would otherwise send these calls to voicemail),
 * and Change.
 */
export function MyCellSection({
  workspaceId,
  businessName,
  businessNumber,
  initial,
}: {
  workspaceId: string;
  businessName: string;
  /** This business's number in E.164, which places the calls; null until it has one. */
  businessNumber: string | null;
  initial: CellPhone | null;
}) {
  const router = useRouter();
  const [phone, setPhone] = useState<CellPhone | null>(initial);
  const [editing, setEditing] = useState(!initial);
  const [typed, setTyped] = useState(initial ? formatPhone(initial.e164) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The number a verification call just went to, while the page waits for the press of 1. */
  const [calling, setCalling] = useState<string | null>(null);
  const watchUntil = useRef(0);
  const business = formatPhone(businessNumber);

  // Waiting for the press of 1: look every two seconds for a few minutes.
  useEffect(() => {
    if (!calling) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const got = unwrap(await apiBrowser().POST('/v1/queries/user_phone.get', { body: {} }));
          if (cancelled) return;
          if (got.phone?.e164 === calling && got.phone.verifiedAt) {
            setPhone(got.phone);
            setCalling(null);
            toast.success(MY_CELL_WORDS.isVerified(calling));
            router.refresh();
            return;
          }
          if (Date.now() > watchUntil.current) setCalling(null);
        } catch {
          // Try again on the next tick.
        }
      })();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [calling, router]);

  async function verify(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    const e164 = normalizePhone(typed);
    if (!typed.trim()) {
      setError(MY_CELL_WORDS.enterNumber);
      return;
    }
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/user_phone.start_verification', {
          body: { workspaceId, phone: e164 ?? typed.trim() },
        }),
      );
      const now = new Date().toISOString();
      if (out.status === 'verified') {
        setPhone((p) => ({
          id: out.userPhoneId,
          e164: out.e164,
          verifiedAt: p?.e164 === out.e164 ? (p.verifiedAt ?? now) : now,
          lastVerificationAt: p?.lastVerificationAt ?? null,
        }));
        toast.success(MY_CELL_WORDS.alreadyVerified(out.e164));
      } else {
        setPhone({
          id: out.userPhoneId,
          e164: out.e164,
          verifiedAt: null,
          lastVerificationAt: now,
        });
        watchUntil.current = Date.now() + WATCH_MS;
        setCalling(out.e164);
      }
      setEditing(false);
    } catch (err) {
      const field =
        err instanceof ApiError && err.code === 'validation' && Array.isArray(err.details)
          ? (err.details as { path?: string; message?: string }[]).find((d) => d.path === 'phone')
          : undefined;
      setError(field?.message ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const noNumber = !businessNumber;

  return (
    <div data-testid="my-cell">
      <h2 className="text-lg font-semibold tracking-tight">{MY_CELL_WORDS.title}</h2>
      <p className="mt-1 text-[13px] text-text-2">{MY_CELL_WORDS.intro.web}</p>

      {editing ? (
        <form onSubmit={(e) => void verify(e)} noValidate className="mt-4 flex flex-col gap-3">
          <Field label={MY_CELL_WORDS.numberLabel} htmlFor="my-cell-number" error={error}>
            <Input
              id="my-cell-number"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={MY_CELL_WORDS.placeholder}
              value={typed}
              invalid={!!error}
              onChange={(e) => setTyped(e.target.value)}
              className="max-w-[260px] font-mono"
            />
          </Field>
          {noNumber ? (
            <Callout tone="neutral" icon={PhoneCall}>
              {MY_CELL_WORDS.noNumber(businessName)}
            </Callout>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={busy} disabled={noNumber} data-testid="verify-my-cell">
              {MY_CELL_WORDS.verify}
            </Button>
            {phone ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                  setTyped(formatPhone(phone.e164));
                }}
              >
                {MY_CELL_WORDS.cancel}
              </Button>
            ) : null}
          </div>
        </form>
      ) : phone ? (
        <>
          <div className="mt-3.5 flex flex-wrap items-center gap-3 rounded-[10px] border border-border px-3.5 py-3">
            <Smartphone className="h-5 w-5 flex-none text-text-2" strokeWidth={1.5} />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="font-mono text-[14.5px] font-semibold" data-testid="my-cell-number">
                {formatPhone(phone.e164)}
              </span>
              <span className="text-xs text-text-3">
                {phone.verifiedAt
                  ? cellVerifiedOn(phone.verifiedAt)
                  : calling
                    ? MY_CELL_WORDS.waiting
                    : MY_CELL_WORDS.notVerified}
              </span>
            </span>
            {phone.verifiedAt ? (
              <Badge variant="ok" className="h-6 px-2.5 text-[12.5px] font-semibold">
                <Check className="h-[13px] w-[13px]" strokeWidth={2} />
                {MY_CELL_WORDS.verified}
              </Badge>
            ) : calling ? null : (
              <Button
                size="sm"
                loading={busy}
                disabled={noNumber}
                onClick={() => {
                  setTyped(formatPhone(phone.e164));
                  void verify();
                }}
                data-testid="verify-again"
              >
                {MY_CELL_WORDS.verify}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setCalling(null);
                setEditing(true);
              }}
            >
              {MY_CELL_WORDS.change}
            </Button>
          </div>
          {calling ? (
            <Callout tone="info" icon={PhoneCall} className="mt-3" data-testid="verify-calling">
              <span className="block font-medium">{MY_CELL_WORDS.calling(calling)}</span>
              {business && businessNumber ? (
                <span className="block">
                  {MY_CELL_WORDS.callsFrom(businessName, businessNumber)}
                </span>
              ) : null}
            </Callout>
          ) : phone.verifiedAt && business && businessNumber ? (
            <p className="mt-3 text-[12.5px] text-text-3">
              {MY_CELL_WORDS.saveContact(businessName, businessNumber)}
            </p>
          ) : error ? (
            <p role="alert" className="mt-2 text-[12.5px] text-danger-text">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
