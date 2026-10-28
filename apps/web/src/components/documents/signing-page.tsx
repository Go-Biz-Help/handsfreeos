'use client';
/**
 * What a signer sees at `/d/<token>` (docs/documents.md): the document they were sent, their fields on it, and
 * signing it or declining. A phone page first, like the money pages, with the business's look on top and
 * "Powered by HandsFreeOS" at the foot.
 *
 * Rules that matter here:
 * - **The words they agree to are the worker's**, word for word (`view.consent`): the worker keeps its own copy with
 *   the signature, so the page never writes its own.
 * - **Everything that changes something is a POST**, opening it included: mail scanners follow links.
 * - **Only their own fields are sent**, and the worker checks each the way core's `valueProblem` does here.
 * - **Handed over in person** (Sign now, answer 13a), the address ends `#with=<first name>&back=<page>`: the page
 *   says whose turn it is before the document shows, and once they've signed, to hand it back. From their portal
 *   (answer 10b), `#back=/c/…` puts a way back on the page. Only a path in the app is followed, never an address,
 *   but for the phone's own way back (`PHONE_HAND_BACK`), which closes the signing page the phone's Sign now opened.
 */
import {
  FIELD_PROMPTS,
  PHONE_HAND_BACK,
  SIGNING_WORDS,
  valueProblem,
  type DocumentField,
  type DocumentValueInput,
} from '@hfos/core';
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  Download,
  HandHelping,
  Link2Off,
  LockKeyhole,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PublicHeader, PublicState } from '@/components/booking/public-shell';
import { BottomSheet, Honeypot, OkBox } from '@/components/money/public-shell';
import { BrandMark } from '@/components/ui/brand';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, errorMessage } from '@/lib/api/errors';
import {
  checkSigningCode,
  declineDocument,
  getSigning,
  markSigningOpened,
  sendSigningCode,
  signDocument,
  signedCopyUrl,
  type PublicBusiness,
  type SigningField,
  type SigningView,
} from '@/lib/api/public-documents';
import { brandLook } from '@/lib/look';
import { cn } from '@/lib/utils';
import { boxStyle, EditView, PdfPages, ValueView } from './pdf-pages';
import { SignatureInput, type SignatureValue } from './signature-input';

type Failure = { kind: 'stale' } | { kind: 'missing' } | { kind: 'error'; message: string };
type Values = Record<string, DocumentValueInput>;

const failureOf = (e: unknown): Failure => {
  if (e instanceof ApiError && e.status === 410) return { kind: 'stale' };
  if (e instanceof ApiError && e.status === 404) return { kind: 'missing' };
  return { kind: 'error', message: errorMessage(e) };
};

/** The field as core's checks read it: a signer's field, never filled from HandsFreeOS here. */
const asField = (f: SigningField) =>
  ({ ...f, role: 'signer', fillFrom: null, options: [...f.options] }) as unknown as DocumentField;

const promptOf = (f: SigningField) =>
  f.label || FIELD_PROMPTS[f.type as keyof typeof FIELD_PROMPTS] || 'Fill this in';

const byPlace = (a: SigningField, b: SigningField) => a.page - b.page || a.y - b.y || a.x - b.x;

/** Who it's handed to in person, and the page in the app to go back to: read from after `#`. */
type Hand = { readonly with: string | null; readonly back: string | null };

function handOf(hash: string): Hand {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const back = p.get('back');
  return {
    with: p.get('with')?.trim().slice(0, 40) || null,
    back:
      back === PHONE_HAND_BACK ||
      (back && /^\/(app\/w|c)\/[A-Za-z0-9_\-/]+$/.test(back) && !back.includes('//'))
        ? back
        : null,
  };
}

const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function SigningFrame({
  business,
  footer,
  children,
}: {
  business: PublicBusiness | null;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const look = brandLook(business?.look?.color);
  return (
    <div
      className={cn('flex min-h-dvh flex-col bg-bg text-text', look.className)}
      style={look.style}
      data-testid="signing-page"
    >
      {business ? <PublicHeader business={business} /> : null}
      <div className="flex flex-1 flex-col">{children}</div>
      {footer ? (
        <div className="sticky bottom-0 z-10 flex-none border-t border-border bg-card px-4 pb-3 pt-2.5">
          <div className="mx-auto flex w-full max-w-[880px] flex-col gap-2">{footer}</div>
        </div>
      ) : null}
      <footer className="flex-none px-4 pb-5 pt-3">
        <p className="flex items-center justify-center gap-[5px] text-[11.5px] text-text-3">
          <BrandMark size={13} />
          {SIGNING_WORDS.poweredBy}
        </p>
      </footer>
    </div>
  );
}

function Band({
  tone,
  icon: Icon,
  children,
  testId,
}: {
  tone: 'info' | 'warning';
  icon: LucideIcon;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-card p-3.5 text-[13.5px] leading-[1.5]',
        tone === 'warning' ? 'bg-warning-soft text-warning-text' : 'bg-card-2 text-text-2',
      )}
      data-testid={testId}
    >
      <Icon size={19} className="mt-px flex-none" aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function SigningPage({ token }: { token: string }) {
  const [view, setView] = useState<SigningView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [values, setValues] = useState<Values>({});
  const [agreed, setAgreed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<{ signature?: SignatureValue; initials?: SignatureValue }>(
    {},
  );
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [flash, setFlash] = useState(false);
  const [hand, setHand] = useState<Hand>({ with: null, back: null });
  const [handed, setHanded] = useState(false);
  const opened = useRef(false);
  const consentBox = useRef<HTMLDivElement>(null);

  /** A new answer from the worker: what's on the page, and their own fields as it has them. */
  const show = (next: SigningView) => {
    setView(next);
    const mine: Values = {};
    for (const f of next.content?.fields ?? [])
      if (f.mine && next.content?.values[f.id]) mine[f.id] = next.content.values[f.id]!;
    setValues(mine);
  };

  useEffect(() => {
    setHand(handOf(window.location.hash));
  }, []);

  useEffect(() => {
    let live = true;
    getSigning(token)
      .then((v) => live && show(v))
      .catch((e: unknown) => live && setFailure(failureOf(e)));
    return () => {
      live = false;
    };
  }, [token]);

  // "They opened it" is news for the business once they can see it: after their code, when there is one.
  useEffect(() => {
    if (opened.current || !view?.content || view.document.status !== 'out') return;
    opened.current = true;
    void markSigningOpened(token).catch(() => {
      // Only news for the business: nothing to tell the signer.
    });
  }, [token, view]);

  const fields = useMemo(() => [...(view?.content?.fields ?? [])].sort(byPlace), [view]);
  const mine = fields.filter((f) => f.mine && f.type !== 'date_signed');
  const left = mine.filter((f) => valueProblem(asField(f), values[f.id] as never));
  const openField = fields.find((f) => f.id === open) ?? null;

  /** A refusal mid-way: a dead link ends the page; anything else is said, and the page reads itself again. */
  async function failed(e: unknown) {
    if (e instanceof ApiError && (e.status === 410 || e.status === 404)) {
      setFailure(failureOf(e));
      return;
    }
    setError(errorMessage(e));
    try {
      show(await getSigning(token));
    } catch {
      // Keep what's on screen.
    }
  }

  function setValue(id: string, value: DocumentValueInput | null) {
    setValues((was) => {
      const next = { ...was };
      if (value) next[id] = value;
      else delete next[id];
      return next;
    });
  }

  function needAgreeing(): boolean {
    if (agreed) return false;
    consentBox.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
    return true;
  }

  function tap(f: SigningField) {
    if (!f.mine || f.type === 'date_signed' || needAgreeing()) return;
    setError(null);
    if (f.type === 'checkbox') {
      const was = values[f.id];
      setValue(f.id, { kind: 'check', checked: !(was?.kind === 'check' && was.checked) });
      return;
    }
    const kind = f.type === 'initials' ? 'initials' : f.type === 'signature' ? 'signature' : null;
    if (kind && !values[f.id] && adopted[kind]) {
      setValue(f.id, adopted[kind]!);
      return;
    }
    setOpen(f.id);
  }

  function next() {
    if (needAgreeing()) return;
    const f = left[0];
    if (!f) return;
    document
      .querySelector(`[data-field="${f.id}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (f.type !== 'checkbox') setTimeout(() => tap(f), 250);
  }

  async function finish() {
    if (busy || needAgreeing()) return;
    if (left.length) {
      next();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const mineValues: Values = {};
      for (const f of mine) if (values[f.id]) mineValues[f.id] = values[f.id]!;
      show(await signDocument(token, { values: mineValues, website }));
      window.scrollTo({ top: 0 });
    } catch (e) {
      await failed(e);
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (busy) return;
    setBusy(true);
    try {
      show(await declineDocument(token, { reason: reason.trim() || null, website }));
      setDeclining(false);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setDeclining(false);
      await failed(e);
    } finally {
      setBusy(false);
    }
  }

  async function askCode() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await sendSigningCode(token);
      if (!out.sent) show(await getSigning(token));
      else setCodeSentTo(out.to);
    } catch (e) {
      await failed(e);
    } finally {
      setBusy(false);
    }
  }

  async function checkCode() {
    if (busy) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6 digits we sent you.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      show(await checkSigningCode(token, code.trim()));
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'document_code_spent') {
        setCodeSentTo(null);
        setCode('');
      }
      await failed(e);
    } finally {
      setBusy(false);
    }
  }

  if (failure)
    return (
      <SigningFrame business={null}>
        <PublicState
          tone={failure.kind === 'stale' ? 'warning' : 'neutral'}
          icon={failure.kind === 'stale' ? <CircleAlert size={20} /> : <Link2Off size={20} />}
          title={
            failure.kind === 'stale'
              ? 'This link is out of date'
              : failure.kind === 'missing'
                ? 'This link doesn’t work'
                : 'We couldn’t open this'
          }
          testId="signing-failed"
        >
          {failure.kind === 'stale'
            ? SIGNING_WORDS.stale
            : failure.kind === 'missing'
              ? SIGNING_WORDS.gone
              : failure.message}
        </PublicState>
      </SigningFrame>
    );
  if (!view)
    return (
      <SigningFrame business={null}>
        <p aria-live="polite" className="mx-auto mt-16 text-[13px] text-text-3">
          Opening your document…
        </p>
      </SigningFrame>
    );

  const { business, document: doc, signer, content } = view;
  const call = business.phoneDisplay ? (
    <a
      className={buttonClassName({ variant: 'secondary', size: 'sm' })}
      href={`tel:${business.phone}`}
    >
      Call {business.phoneDisplay}
    </a>
  ) : null;

  if (doc.status === 'voided' || doc.status === 'expired' || doc.status === 'declined') {
    const declinedByMe = doc.status === 'declined' && signer.status === 'declined';
    return (
      <SigningFrame business={business}>
        <PublicState
          icon={doc.status === 'expired' ? <Clock size={20} /> : <CircleSlash size={20} />}
          title={
            declinedByMe
              ? 'You declined to sign'
              : doc.status === 'voided'
                ? 'This document was taken back'
                : doc.status === 'expired'
                  ? 'This document ran out of time'
                  : 'This document was declined'
          }
          action={call}
          testId={`signing-${doc.status}`}
        >
          {declinedByMe
            ? SIGNING_WORDS.declined
            : doc.status === 'voided'
              ? SIGNING_WORDS.voided
              : doc.status === 'expired'
                ? SIGNING_WORDS.expired
                : SIGNING_WORDS.closedDeclined}
        </PublicState>
      </SigningFrame>
    );
  }

  // Their code first (answer 11a): nothing of the document shows until it's checked.
  if (!content && signer.askCode && !signer.codeChecked && doc.status === 'out')
    return (
      <SigningFrame business={business}>
        <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center gap-4 px-4 py-10">
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="inline-flex h-[42px] w-[42px] items-center justify-center rounded-full bg-accent-soft text-accent-text">
              <LockKeyhole size={20} aria-hidden />
            </span>
            <h1 className="text-[17px] font-semibold">{doc.name}</h1>
            <p className="text-[13.5px] text-text-2">
              {signer.codeTo
                ? SIGNING_WORDS.codeAsk(signer.codeTo)
                : SIGNING_WORDS.noCodeRoute(business.name)}
            </p>
          </div>
          {codeSentTo ? (
            <>
              <div>
                <Label htmlFor="signing-code">{SIGNING_WORDS.codeEnter}</Label>
                <Input
                  id="signing-code"
                  inputSize="lg"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  autoFocus
                  className="text-center text-[20px] tracking-[0.3em]"
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && void checkCode()}
                  data-testid="signing-code"
                />
                <p className="mt-1.5 text-[12.5px] text-text-3">Sent to {codeSentTo}.</p>
              </div>
              <Button
                size="lg"
                className="w-full"
                loading={busy}
                onClick={() => void checkCode()}
                data-testid="signing-code-check"
              >
                {SIGNING_WORDS.codeCheck}
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                disabled={busy}
                onClick={() => void askCode()}
              >
                {SIGNING_WORDS.codeAgain}
              </Button>
            </>
          ) : signer.codeTo ? (
            <Button
              size="lg"
              className="w-full"
              loading={busy}
              onClick={() => void askCode()}
              data-testid="signing-code-send"
            >
              {SIGNING_WORDS.codeSend}
            </Button>
          ) : (
            <div className="flex justify-center">{call}</div>
          )}
          {error ? (
            <p
              role="alert"
              className="text-center text-[13px] text-danger-text"
              data-testid="signing-error"
            >
              {error}
            </p>
          ) : null}
        </div>
      </SigningFrame>
    );

  const signing = signer.yourTurn && signer.status !== 'signed' && !!content;
  const pages = content?.pages ?? [];
  // From the team's own screen: the web's document page, or the phone's Sign now.
  const inPerson =
    !!hand.with && (!!hand.back?.startsWith('/app/') || hand.back === PHONE_HAND_BACK);
  const back = hand.back ? (
    <a
      href={hand.back}
      className={buttonClassName({ variant: 'secondary', size: 'sm', className: 'w-fit' })}
      data-testid="signing-back"
    >
      <ArrowLeft size={16} aria-hidden />
      {hand.back.startsWith('/c/') ? SIGNING_WORDS.backToPortal : SIGNING_WORDS.backToDocument}
    </a>
  ) : null;

  // Handed over in person: who it's for, before anything of theirs shows.
  if (inPerson && signing && !handed)
    return (
      <SigningFrame business={business}>
        <div
          className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center gap-4 px-4 py-10"
          data-testid="signing-hand-over"
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="inline-flex h-[42px] w-[42px] items-center justify-center rounded-full bg-accent-soft text-accent-text">
              <HandHelping size={20} aria-hidden />
            </span>
            <h1 className="text-[19px] font-semibold">{SIGNING_WORDS.handTitle(hand.with!)}</h1>
            <p className="text-[13.5px] text-text-2">
              {SIGNING_WORDS.handBody({ by: null, business: business.name, document: doc.name })}
            </p>
          </div>
          <Button
            size="lg"
            className="w-full"
            onClick={() => setHanded(true)}
            data-testid="signing-hand-start"
          >
            {SIGNING_WORDS.handStart(hand.with!)}
          </Button>
          <div className="flex justify-center">{back}</div>
        </div>
      </SigningFrame>
    );

  const footer = signing ? (
    <div className="flex items-center gap-3">
      <span
        className="min-w-0 flex-1 text-[13px] text-text-2"
        aria-live="polite"
        data-testid="signing-left"
      >
        {!agreed
          ? SIGNING_WORDS.agreeFirst
          : left.length
            ? SIGNING_WORDS.requiredLeft(left.length)
            : 'All filled in.'}
      </span>
      {agreed && !left.length ? (
        <Button size="lg" loading={busy} onClick={() => void finish()} data-testid="signing-finish">
          {SIGNING_WORDS.finish}
        </Button>
      ) : (
        <Button size="lg" onClick={next} data-testid="signing-next">
          {agreed ? SIGNING_WORDS.next : SIGNING_WORDS.start}
        </Button>
      )}
    </div>
  ) : null;

  return (
    <SigningFrame business={business} footer={footer}>
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 pb-6 pt-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
            {signer.kind === 'copy'
              ? 'Your copy'
              : signer.roleLabel
                ? `Signing as ${signer.roleLabel}`
                : 'To sign'}
          </span>
          <h1
            className="text-[22px] font-semibold leading-tight tracking-[-0.01em]"
            data-testid="signing-name"
          >
            {doc.name}
          </h1>
          {doc.status === 'out' && signing ? (
            <p className="text-sm text-text-2">Please sign by {dayOf(doc.expiresAt)}.</p>
          ) : null}
        </div>

        {/* In person, the way back is the team's, so it shows only once they've handed it back. */}
        {back && !(inPerson && signing) ? <div>{back}</div> : null}

        {inPerson && signer.status === 'signed' ? (
          <Band tone="info" icon={HandHelping} testId="signing-hand-back">
            <b className="font-semibold">{SIGNING_WORDS.handBack(null)}.</b>{' '}
            {SIGNING_WORDS.handBackBody}
          </Band>
        ) : null}

        {doc.status === 'completed' ? (
          <OkBox icon={<CircleCheck size={19} />} testId="signing-completed">
            <b className="font-semibold">{SIGNING_WORDS.completed}</b>{' '}
            {doc.signedCopy ? 'Your signed copy is ready.' : 'Your signed copy is on its way.'}
          </OkBox>
        ) : signer.status === 'signed' ? (
          <OkBox icon={<CircleCheck size={19} />} testId="signing-signed">
            <b className="font-semibold">{SIGNING_WORDS.signed}</b> {SIGNING_WORDS.signedWaiting}
          </OkBox>
        ) : signer.kind === 'copy' ? (
          <Band tone="info" icon={Clock} testId="signing-copy-only">
            {SIGNING_WORDS.copyOnly}
          </Band>
        ) : !signer.yourTurn ? (
          <Band tone="info" icon={Clock} testId="signing-not-yet">
            {SIGNING_WORDS.notYourTurn}
          </Band>
        ) : null}

        {doc.status === 'completed' && doc.signedCopy ? (
          <a
            href={signedCopyUrl(token)}
            rel="noreferrer"
            className={buttonClassName({ size: 'lg', className: 'w-full sm:w-fit' })}
            data-testid="signing-download"
          >
            <Download size={17} aria-hidden />
            {SIGNING_WORDS.download}
          </a>
        ) : null}

        {doc.message && signing ? (
          <Card className="px-4 py-3.5">
            <div className="mb-0.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              From {business.name}
            </div>
            <p className="whitespace-pre-line text-[13.5px] leading-[1.55] text-text-2">
              {doc.message}
            </p>
          </Card>
        ) : null}

        {signing ? (
          <div
            ref={consentBox}
            className={cn(
              'rounded-card border bg-card p-3.5 transition-shadow',
              flash ? 'border-accent ring-[3px] ring-ring' : 'border-border',
            )}
          >
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 flex-none cursor-pointer accent-accent"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                data-testid="signing-agree"
              />
              <span className="flex flex-col gap-1">
                <span className="text-[14px] font-semibold">{SIGNING_WORDS.agree}</span>
                {/* The worker's own words: what's kept with the signature. */}
                <span
                  className="text-[12.5px] leading-[1.5] text-text-2"
                  data-testid="signing-consent"
                >
                  {view.consent}
                </span>
              </span>
            </label>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-[13px] text-danger-text" data-testid="signing-error">
            {error}
          </p>
        ) : null}

        {content ? (
          <PdfPages
            source={content.sourceUrl}
            pages={pages}
            testId="signing-pages"
            layer={({ index, scale }) => (
              <>
                {content.edits
                  .filter((e) => e.page === index)
                  .map((e) => (
                    <EditView key={e.id} edit={e} scale={scale} />
                  ))}
                {fields
                  .filter((f) => f.page === index)
                  .map((f) => (
                    <FieldBox
                      key={f.id}
                      field={f}
                      scale={scale}
                      value={f.mine ? values[f.id] : content.values[f.id]}
                      active={signing && f.mine}
                      onTap={() => tap(f)}
                    />
                  ))}
              </>
            )}
          />
        ) : null}

        {signing ? (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              onClick={() => setDeclining(true)}
              data-testid="signing-decline-open"
            >
              {SIGNING_WORDS.decline}
            </Button>
          </div>
        ) : null}
      </div>

      <BottomSheet
        open={!!openField}
        onOpenChange={(o) => !o && setOpen(null)}
        title={openField ? promptOf(openField) : ''}
        testId="signing-field-sheet"
      >
        {openField ? (
          <FieldInput
            key={openField.id}
            field={openField}
            value={values[openField.id] ?? null}
            signerName={signer.name}
            onDone={(v) => {
              setValue(openField.id, v);
              if (v?.kind === 'signature')
                setAdopted((a) => ({
                  ...a,
                  [openField.type === 'initials' ? 'initials' : 'signature']: v,
                }));
              setOpen(null);
            }}
          />
        ) : null}
      </BottomSheet>

      <BottomSheet
        open={declining}
        onOpenChange={setDeclining}
        title={SIGNING_WORDS.decline}
        testId="signing-decline-sheet"
      >
        <p className="text-[13px] leading-[1.5] text-text-2">
          {business.name} will be told, and nobody else can sign it after you decline.
        </p>
        <div className="relative">
          <Label htmlFor="decline-reason">{SIGNING_WORDS.declineReason}</Label>
          <Textarea
            id="decline-reason"
            className="min-h-16"
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
            data-testid="signing-decline-reason"
          />
          <Honeypot id="decline-website" value={website} onChange={setWebsite} />
        </div>
        <Button
          variant="secondary"
          size="lg"
          className="w-full text-danger-text"
          loading={busy}
          onClick={() => void decline()}
          data-testid="signing-decline"
        >
          {SIGNING_WORDS.declineConfirm}
        </Button>
        <Button variant="ghost" className="w-full max-md:h-11" onClick={() => setDeclining(false)}>
          Keep it open
        </Button>
      </BottomSheet>
      <div className="relative">
        <Honeypot id="sign-website" value={website} onChange={setWebsite} />
      </div>
    </SigningFrame>
  );
}

/** One field on the page: theirs to tap, or someone else's as they filled it. */
function FieldBox({
  field,
  scale,
  value,
  active,
  onTap,
}: {
  field: SigningField;
  scale: number;
  value: DocumentValueInput | undefined;
  active: boolean;
  onTap: () => void;
}) {
  const style = boxStyle(field);
  if (!active)
    return (
      <div
        className={cn(
          'pointer-events-none absolute',
          !value && 'rounded-[3px] border border-dashed border-border-strong/70 bg-card-2/40',
        )}
        style={style}
        data-field={field.id}
      >
        {value ? (
          <ValueView value={value} type={field.type} fontSize={field.fontSize} scale={scale} />
        ) : (
          <span
            className="flex h-full w-full items-center overflow-hidden whitespace-nowrap px-1 text-text-3"
            style={{ fontSize: Math.max(8, Math.min(12, field.h * 400)) }}
          >
            {field.type === 'date_signed' && field.mine
              ? SIGNING_WORDS.dateSigned
              : field.roleLabel}
          </span>
        )}
      </div>
    );
  const auto = field.type === 'date_signed';
  const empty =
    !value ||
    (value.kind === 'check' && !value.checked) ||
    (value.kind === 'text' && !value.text.trim());
  return (
    <button
      type="button"
      className={cn(
        'absolute rounded-[3px] text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        auto
          ? 'cursor-default border border-dashed border-border-strong bg-card-2/50'
          : empty
            ? 'border-2 border-dashed border-accent bg-accent-soft/70 hover:bg-accent-soft'
            : 'border border-accent/40 bg-accent-soft/20 hover:bg-accent-soft/50',
      )}
      style={style}
      onClick={onTap}
      aria-label={`${promptOf(field)}${field.required ? '' : ' (optional)'}`}
      data-field={field.id}
      data-testid={`signing-field-${field.id}`}
    >
      {value && !empty ? (
        <ValueView value={value} type={field.type} fontSize={field.fontSize} scale={scale} />
      ) : (
        <span
          className={cn(
            'flex h-full w-full items-center overflow-hidden whitespace-nowrap px-1 font-medium',
            auto ? 'text-text-3' : 'text-accent-text',
          )}
          style={{ fontSize: Math.max(9, Math.min(13, field.h * 500)) }}
        >
          {auto ? SIGNING_WORDS.dateSigned : `${promptOf(field)}${field.required ? ' *' : ''}`}
        </span>
      )}
    </button>
  );
}

/** Filling in one field, in the sheet that opens over the page. */
function FieldInput({
  field,
  value,
  signerName,
  onDone,
}: {
  field: SigningField;
  value: DocumentValueInput | null;
  signerName: string;
  onDone: (value: DocumentValueInput | null) => void;
}) {
  const [text, setText] = useState(
    value?.kind === 'text' ? value.text : value?.kind === 'date' ? value.date : '',
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [resign, setResign] = useState(false);

  if (field.type === 'signature' || field.type === 'initials') {
    if (value?.kind === 'signature' && !resign)
      return (
        <div className="flex flex-col gap-3">
          <div className="flex h-28 items-center justify-center rounded-control border border-border bg-white p-2">
            <img
              src={value.image}
              alt={`Signed by ${value.name}`}
              className="max-h-full max-w-full object-contain"
            />
          </div>
          <Button size="lg" className="w-full" onClick={() => onDone(value)}>
            Keep it
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => setResign(true)}>
            Sign again
          </Button>
          {field.required ? null : (
            <Button variant="ghost" className="w-full" onClick={() => onDone(null)}>
              Take it off
            </Button>
          )}
        </div>
      );
    return (
      <SignatureInput initials={field.type === 'initials'} name={signerName} onAdopt={onDone} />
    );
  }

  const make = (): DocumentValueInput | null => {
    const t = text.trim();
    if (!t) return null;
    return field.type === 'date' ? { kind: 'date', date: t } : { kind: 'text', text: t };
  };
  const done = () => {
    const v = make();
    const p = valueProblem(asField(field), v as never);
    if (p) {
      setProblem(p);
      return;
    }
    onDone(v);
  };

  const id = `field-${field.id}`;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label htmlFor={id} className="sr-only">
          {promptOf(field)}
        </Label>
        {field.type === 'long_text' ? (
          <Textarea
            id={id}
            className="min-h-28"
            value={text}
            autoFocus
            maxLength={5000}
            onChange={(e) => setText(e.target.value)}
          />
        ) : field.type === 'choice' ? (
          <Select id={id} selectSize="lg" value={text} onChange={(e) => setText(e.target.value)}>
            <option value="">Pick one</option>
            {field.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            id={id}
            inputSize="lg"
            autoFocus
            type={
              field.type === 'date'
                ? 'date'
                : field.type === 'email'
                  ? 'email'
                  : field.type === 'phone'
                    ? 'tel'
                    : 'text'
            }
            inputMode={field.type === 'number' ? 'decimal' : undefined}
            autoComplete={
              field.type === 'name'
                ? 'name'
                : field.type === 'email'
                  ? 'email'
                  : field.type === 'phone'
                    ? 'tel'
                    : 'off'
            }
            value={text}
            maxLength={500}
            invalid={!!problem}
            onChange={(e) => {
              setText(e.target.value);
              setProblem(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && done()}
            data-testid="signing-field-input"
          />
        )}
        {problem ? (
          <p role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
            {problem}
          </p>
        ) : null}
      </div>
      <Button size="lg" className="w-full" onClick={done} data-testid="signing-field-done">
        Done
      </Button>
      {value && !field.required ? (
        <Button variant="ghost" className="w-full" onClick={() => onDone(null)}>
          Clear it
        </Button>
      ) : null}
    </div>
  );
}
