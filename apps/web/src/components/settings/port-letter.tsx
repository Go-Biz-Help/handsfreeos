'use client';
import { CircleAlert, CircleCheck, Download, FileSignature, PenLine, Save } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { SignaturePad } from '@/components/settings/signature-pad';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { LetterDetails } from '@/lib/ports/loa';
import { uploadPortDocument } from '@/lib/ports/upload';
import type { PortInfo } from './port-step';

/**
 * What HandsFreeOS already knows about the business, to fill the form in before anybody types.
 *
 * All of it is the carrier registration's, the one place a business has already written its legal name, its
 * address and who to talk to down for a carrier. The phone bill may say something else; the form says so.
 */
export interface LetterProfile {
  readonly businessName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
}

type Answer =
  | 'firstName'
  | 'lastName'
  | 'businessName'
  | 'street'
  | 'city'
  | 'state'
  | 'zip'
  | 'carrier'
  | 'accountNumber'
  | 'pin'
  | 'printName';

/** What has to be there, in the words a business would use, in the order the form asks. */
const NEEDED: readonly [Answer, string][] = [
  ['firstName', 'the first name on the bill'],
  ['lastName', 'the last name on the bill'],
  ['street', 'the service address'],
  ['city', 'the city'],
  ['state', 'the state'],
  ['zip', 'the ZIP code'],
  ['accountNumber', 'the account number'],
  ['pin', 'the transfer PIN'],
];

let template: Promise<ArrayBuffer> | null = null;

/** Twilio's form, fetched once per page and kept. A failed fetch is not kept, so the next press tries again. */
function loadTemplate(path: string): Promise<ArrayBuffer> {
  template ??= fetch(path)
    .then((r) => {
      if (!r.ok) throw new Error('The letter form didn’t load. Reload the page and try again.');
      return r.arrayBuffer();
    })
    .catch((e: unknown) => {
      template = null;
      throw e;
    });
  return template;
}

/** The filled-in letter. pdf-lib loads on the first press, not with the Texting page. */
async function buildLetter(
  details: LetterDetails,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const loa = await import('@/lib/ports/loa');
  const bytes = await loa.buildLetterPdf(details, await loadTemplate(loa.LETTER_TEMPLATE_PATH));
  return { bytes, fileName: loa.LETTER_FILE_NAME };
}

/**
 * The old carrier's details and Twilio's letter of authorisation, together (M17).
 *
 * They are the same answers: the name and service address on the phone bill, the carrier, the account number
 * and the PIN are what `number_port.save` keeps for the carrier and exactly what Twilio's form asks for. So they
 * are typed once, saved to every number in the batch, written into Twilio's own PDF, signed on the screen, and
 * the PDF is attached to every number — one letter that lists all of them.
 *
 * Signing on paper still works: "Save without signing" keeps the details, and the scan goes up below.
 *
 * The account number and PIN are cleared from the screen the moment they are saved, as before. They are on the
 * letter, because the carrier needs them there, and the letter goes where a scanned one would.
 */
export function PortPaperwork({
  workspaceId,
  ports,
  profile,
  onDone,
}: {
  workspaceId: string;
  /** Every number in the batch: the details are saved to each and the letter lists them all. */
  ports: readonly PortInfo[];
  profile: LetterProfile;
  onDone: () => void;
}) {
  const allSaved = ports.every((p) => p.detailsReady);
  const allSigned = ports.every((p) => p.documents.loa);
  // Open whenever something is missing — including a number added after the letter was made.
  const [redo, setRedo] = useState(false);
  const open = redo || !allSaved || !allSigned;
  // Untouched fields show what we know, and keep up with it until somebody types over them.
  const [typed, setTyped] = useState<Partial<Record<Answer, string>>>({});
  const [signMode, setSignMode] = useState<'draw' | 'type'>('draw');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState<'sign' | 'save' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const known: Record<Answer, string> = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    businessName: profile.businessName,
    street: profile.street,
    city: profile.city,
    state: profile.state,
    zip: profile.zip,
    carrier: '',
    accountNumber: '',
    pin: '',
    printName: '',
  };
  const value = (f: Answer) => typed[f] ?? known[f];
  const set = (f: Answer) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setTyped((t) => ({ ...t, [f]: e.target.value }));
  const fullName = `${value('firstName').trim()} ${value('lastName').trim()}`.trim();
  const printName = value('printName').trim() || fullName;
  const many = ports.length > 1;

  function letter(signed: boolean): LetterDetails {
    return {
      firstName: value('firstName'),
      lastName: value('lastName'),
      businessName: value('businessName'),
      address: {
        street: value('street'),
        city: value('city'),
        state: value('state').toUpperCase(),
        zip: value('zip'),
      },
      numbers: ports.map((p) => ({
        display: p.display,
        carrier: value('carrier'),
        accountNumber: value('accountNumber'),
        pin: value('pin'),
      })),
      // Nothing drawn yet leaves the line blank, so a copy downloaded to check it is not signed by accident.
      signature: !signed
        ? null
        : signMode === 'type'
          ? { kind: 'typed' }
          : drawn
            ? { kind: 'drawn', png: drawn }
            : null,
      printName,
      date: new Date(),
    };
  }

  /** The first thing still missing, said plainly. Null when there is nothing. */
  function missing(forLetter: boolean, signing: boolean): string | null {
    const gap = NEEDED.find(([f]) => !value(f).trim());
    if (gap) return `Fill in ${gap[1]} first.`;
    if (forLetter && !value('carrier').trim()) return 'Fill in who your old carrier is first.';
    if (!signing) return null;
    if (signMode === 'draw' && !drawn) return 'Sign in the box first.';
    if (!sure) return 'Tick the box to say you can sign for this account.';
    return null;
  }

  /** Runs one step per number, in order, and stops at the first that fails — naming its number. */
  async function eachPort(run: (p: PortInfo) => Promise<unknown>): Promise<boolean> {
    for (const p of ports) {
      try {
        await run(p);
      } catch (e) {
        setError(many ? `${p.display}: ${errorMessage(e)}` : errorMessage(e));
        return false;
      }
    }
    return true;
  }

  /** Keeps the details on every number: what the carrier is sent, besides the letter. */
  function saveDetails(): Promise<boolean> {
    const submission = {
      accountNumber: value('accountNumber').trim(),
      pin: value('pin').trim(),
      authorizedBy: fullName,
      serviceAddress: `${value('street').trim()}, ${value('city').trim()}, ${value('state').trim().toUpperCase()} ${value('zip').trim()}`,
    };
    return eachPort(async (p) =>
      unwrap(
        await apiBrowser().POST('/v1/commands/number_port.save', {
          body: { workspaceId, portId: p.id, submission },
        }),
      ),
    );
  }

  /**
   * Cleared the moment they are saved. They are the old carrier's credentials, and leaving them sitting in a
   * form on a shared office screen is the one avoidable way they leak.
   */
  function forgetCredentials() {
    setTyped((t) => ({ ...t, accountNumber: '', pin: '' }));
  }

  async function sign() {
    const gap = missing(true, true);
    if (gap) return setError(gap);
    setBusy('sign');
    setError(null);
    try {
      // The letter first: if Twilio's form will not load, nothing has been saved halfway.
      const { bytes, fileName } = await buildLetter(letter(true));
      const file = new File([new Uint8Array(bytes)], fileName, {
        type: 'application/pdf',
      });
      if (!(await saveDetails())) return;
      // Each carrier request carries its own copy of the one letter that names them all.
      if (!(await eachPort((p) => uploadPortDocument(workspaceId, p.id, 'loa', file)))) return;
      forgetCredentials();
      setRedo(false);
      toast.success(
        many ? `Saved and signed for all ${ports.length} numbers.` : 'Saved, signed and attached.',
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      onDone();
    }
  }

  async function saveOnly() {
    const gap = missing(false, false);
    if (gap) return setError(gap);
    setBusy('save');
    setError(null);
    try {
      if (!(await saveDetails())) return;
      forgetCredentials();
      toast.success(many ? `Saved for all ${ports.length} numbers.` : 'Saved.');
    } finally {
      setBusy(null);
      onDone();
    }
  }

  async function download() {
    const gap = missing(true, false);
    if (gap) return setError(gap);
    setBusy('download');
    setError(null);
    try {
      const { bytes, fileName } = await buildLetter(letter(true));
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-3 py-2" data-testid="port-paperwork-done">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-card">
          <CircleCheck className="h-4 w-4 text-success-text" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">
            Details saved and the letter of authorisation signed
          </span>
          <span className="block text-xs text-text-3">
            {many ? `For all ${ports.length} numbers.` : 'Attached.'} The account number and PIN are
            never shown here again.
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRedo(true)}
          data-testid="port-paperwork-redo"
        >
          <PenLine className="h-3.5 w-3.5" strokeWidth={1.8} />
          Change them
        </Button>
      </div>
    );

  return (
    <div data-testid="port-paperwork">
      <h3 className="text-[13px] font-medium">The account with your old carrier</h3>
      <p className="mt-0.5 text-xs text-text-3">
        Exactly as it is on your phone bill — carriers turn a move down for a name or address that
        doesn’t match.
        {many
          ? ' It goes on every number above, so they all have to be on this one account; send numbers on another account on their own.'
          : ''}
        {allSaved && !allSigned
          ? ' The details are saved; type the account number and PIN again to make the letter.'
          : ''}
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="First name" htmlFor="port-first">
          <Input
            id="port-first"
            value={value('firstName')}
            onChange={set('firstName')}
            autoComplete="given-name"
            data-testid="port-first"
          />
        </Field>
        <Field label="Last name" htmlFor="port-last">
          <Input
            id="port-last"
            value={value('lastName')}
            onChange={set('lastName')}
            autoComplete="family-name"
            data-testid="port-last"
          />
        </Field>
        <Field
          label="Business name"
          htmlFor="port-business"
          className="sm:col-span-2"
          hint="If the phone service is in the business’s name."
        >
          <Input
            id="port-business"
            value={value('businessName')}
            onChange={set('businessName')}
            autoComplete="organization"
            data-testid="port-business"
          />
        </Field>
        <Field
          label="Service address"
          htmlFor="port-street"
          className="sm:col-span-2"
          hint="Where the service is — a street address, not a PO box."
        >
          <Input
            id="port-street"
            value={value('street')}
            onChange={set('street')}
            autoComplete="street-address"
            data-testid="port-street"
          />
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <Field label="City" htmlFor="port-city">
          <Input
            id="port-city"
            value={value('city')}
            onChange={set('city')}
            autoComplete="address-level2"
            data-testid="port-city"
          />
        </Field>
        <Field label="State" htmlFor="port-state">
          <Input
            id="port-state"
            value={value('state')}
            onChange={set('state')}
            maxLength={2}
            placeholder="TX"
            autoComplete="address-level1"
            data-testid="port-state"
          />
        </Field>
        <Field label="ZIP" htmlFor="port-zip">
          <Input
            id="port-zip"
            value={value('zip')}
            onChange={set('zip')}
            inputMode="numeric"
            autoComplete="postal-code"
            data-testid="port-zip"
          />
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Old carrier" htmlFor="port-carrier">
          <Input
            id="port-carrier"
            value={value('carrier')}
            onChange={set('carrier')}
            placeholder="AT&T, Verizon, LeadConnector…"
            data-testid="port-carrier"
          />
        </Field>
        <Field label="Account number" htmlFor="port-account">
          <Input
            id="port-account"
            value={value('accountNumber')}
            onChange={set('accountNumber')}
            placeholder="On the bill — not the phone number"
            autoComplete="off"
            data-testid="port-account"
          />
        </Field>
        <Field label="Transfer PIN" htmlFor="port-pin">
          <Input
            id="port-pin"
            value={value('pin')}
            onChange={set('pin')}
            placeholder="Also called a port-out PIN"
            autoComplete="off"
            data-testid="port-pin"
          />
        </Field>
      </div>
      <p className="mt-1.5 text-xs text-text-3">
        The account number and PIN go to your old carrier and on the letter, and are never shown
        here again once saved.
      </p>

      <div className="mt-5 flex items-start gap-3 border-t border-border pt-4">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-card">
          <FileSignature className="h-4 w-4 text-text-3" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">
            Sign Twilio’s letter of authorisation
          </span>
          <span className="block text-xs text-text-3">
            The letter that lets Twilio ask your old carrier to release{' '}
            {many ? `these ${ports.length} numbers` : 'the number'}. The answers above go on
            Twilio’s own form; you sign it here and it is attached as a PDF.
            {ports.some((p) => p.documents.loa) && !allSigned
              ? ' A number was added after the last one was signed, so it needs signing again to list them all.'
              : ''}
          </span>
        </span>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium">Signature</span>
          <button
            type="button"
            className="text-xs text-text-3 hover:text-text"
            onClick={() => setSignMode(signMode === 'draw' ? 'type' : 'draw')}
            data-testid="loa-sign-mode"
          >
            {signMode === 'draw' ? 'Type it instead' : 'Draw it instead'}
          </button>
        </div>
        {signMode === 'draw' ? (
          <SignaturePad
            label={`Signature of ${printName || 'the account holder'}`}
            onChange={setDrawn}
            testId="loa-signature"
          />
        ) : (
          <div className="flex h-32 items-center rounded-control border border-border-strong bg-white px-4">
            <span className="font-serif text-3xl italic text-[#111827]">
              {fullName || 'Your name'}
            </span>
          </div>
        )}
      </div>
      <Field label="Printed name" htmlFor="loa-print" className="mt-3 max-w-sm">
        <Input
          id="loa-print"
          value={value('printName')}
          onChange={set('printName')}
          placeholder={fullName || 'Your name'}
          autoComplete="name"
          data-testid="loa-print"
        />
      </Field>
      <Checkbox
        className="mt-3 text-[13px]"
        checked={sure}
        onChange={(e) => setSure(e.target.checked)}
        label={`I am ${printName || 'the account holder'}, or I represent ${value('businessName').trim() || 'the business'}, I may move these numbers, and I am at least 18.`}
        data-testid="loa-confirm"
      />

      {error ? (
        <Callout tone="danger" icon={CircleAlert} className="mt-3">
          {error}
        </Callout>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          loading={busy === 'sign'}
          disabled={busy !== null}
          onClick={() => void sign()}
          data-testid="loa-attach"
        >
          <FileSignature className="h-3.5 w-3.5" strokeWidth={1.8} />
          {many ? `Save and sign for all ${ports.length} numbers` : 'Save and sign'}
        </Button>
        <Button
          variant="secondary"
          loading={busy === 'download'}
          disabled={busy !== null}
          onClick={() => void download()}
          data-testid="loa-download"
        >
          <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
          Download to check it
        </Button>
        <Button
          variant="ghost"
          loading={busy === 'save'}
          disabled={busy !== null}
          onClick={() => void saveOnly()}
          data-testid="port-save"
        >
          <Save className="h-3.5 w-3.5" strokeWidth={1.8} />
          Save without signing
        </Button>
        {allSaved && allSigned ? (
          <Button variant="ghost" onClick={() => setRedo(false)}>
            Keep what’s there
          </Button>
        ) : null}
      </div>
      <p className="mt-1.5 text-xs text-text-3">
        Signing on paper instead? Save without signing, then attach the scan below.
      </p>
    </div>
  );
}
