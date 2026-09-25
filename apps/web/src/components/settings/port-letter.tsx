'use client';
import { CircleAlert, CircleCheck, Download, FileSignature, PenLine } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { SignaturePad } from '@/components/settings/signature-pad';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api/client';
import {
  buildLetterPdf,
  LETTER_FILE_NAME,
  numberTypeFor,
  type LetterDetails,
} from '@/lib/ports/loa';
import { uploadPortDocument } from '@/lib/ports/upload';
import type { PortInfo } from './port-step';

/**
 * What HandsFreeOS already knows about the business, to fill the letter in before anybody types.
 *
 * Almost all of it is the carrier registration's (the legal name, the EIN, the address, who the contact is),
 * because that is the one place a business has already written its legal details down for a carrier.
 */
export interface LetterProfile {
  readonly businessName: string;
  readonly registrationNumber: string;
  readonly address: string;
  readonly website: string;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
}

type LetterField =
  | 'businessName'
  | 'registrationNumber'
  | 'services'
  | 'country'
  | 'numberType'
  | 'address'
  | 'website'
  | 'signerName'
  | 'signerTitle'
  | 'signerPhone'
  | 'signerEmail';

/** What the business still has to fill in, in the words it would use. */
const REQUIRED: readonly [LetterField, string][] = [
  ['businessName', 'the business name'],
  ['registrationNumber', 'the registration number'],
  ['services', 'what the business does'],
  ['country', 'the country'],
  ['numberType', 'the kind of numbers'],
  ['signerName', 'who is signing'],
  ['signerTitle', 'their title'],
  ['signerPhone', 'their phone number'],
  ['signerEmail', 'their email'],
];

/**
 * The signed letter, made here (M17).
 *
 * Carriers turn down a port without a signed letter of authorisation, and the old way to get one was to find
 * the template, print it, sign it, scan it and upload the scan. This fills Twilio's template in from what the
 * business already told us, has the person sign it on the screen, and attaches the PDF to every number going
 * with it — one letter that names all of them.
 */
export function PortLetter({
  workspaceId,
  ports,
  profile,
  signerName,
  serviceAddress,
  onAttached,
}: {
  workspaceId: string;
  /** Every number the letter covers, and so every port it is attached to. */
  ports: readonly PortInfo[];
  profile: LetterProfile;
  /** Whoever was named as authorising the port in the details above, if anybody was yet. */
  signerName: string;
  /** The service address from the details above, if it was typed. */
  serviceAddress: string;
  onAttached: () => void;
}) {
  const allSigned = ports.every((p) => p.documents.loa);
  // Open whenever a number still has no letter — including one added after the letter was made.
  const [redo, setRedo] = useState(false);
  const open = redo || !allSigned;
  // `null` means "not touched": the field shows what we know, and keeps up if that changes — a name typed
  // into the details above, a number added to the list — until the person types over it.
  const [typed, setTyped] = useState<Partial<Record<LetterField, string>>>({});
  const [signMode, setSignMode] = useState<'draw' | 'type'>('draw');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState<'attach' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const known: Record<LetterField, string> = {
    businessName: profile.businessName,
    registrationNumber: profile.registrationNumber,
    services: '',
    country: 'the United States',
    numberType: numberTypeFor(ports.map((p) => p.e164)),
    address: profile.address || serviceAddress,
    website: profile.website,
    signerName: signerName || profile.contactName,
    signerTitle: '',
    signerPhone: profile.contactPhone,
    signerEmail: profile.contactEmail,
  };
  const value = (f: LetterField) => typed[f] ?? known[f];
  const set = (f: LetterField) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setTyped((t) => ({ ...t, [f]: e.target.value }));

  const many = ports.length > 1;

  function details(): LetterDetails {
    return {
      businessName: value('businessName'),
      registrationNumber: value('registrationNumber'),
      services: value('services'),
      country: value('country'),
      numberType: value('numberType'),
      letterhead: [value('address'), value('website')],
      date: new Date(),
      signer: {
        name: value('signerName'),
        title: value('signerTitle'),
        phone: value('signerPhone'),
        email: value('signerEmail'),
      },
      // Nothing drawn yet leaves the line blank, so a copy downloaded to check it is not signed by accident.
      signature:
        signMode === 'type' ? { kind: 'typed' } : drawn ? { kind: 'drawn', png: drawn } : null,
      numbers: ports.map((p) => p.display),
    };
  }

  /** The first thing still missing, said plainly. Null when the letter can be made. */
  function missing(signing: boolean): string | null {
    const gap = REQUIRED.find(([f]) => !value(f).trim());
    if (gap) return `Fill in ${gap[1]} first.`;
    if (!signing) return null;
    if (signMode === 'draw' && !drawn) return 'Sign in the box first.';
    if (!sure) return 'Tick the box to say you can sign for the business.';
    return null;
  }

  async function download() {
    const gap = missing(false);
    if (gap) return setError(gap);
    setBusy('download');
    setError(null);
    try {
      const bytes = await buildLetterPdf(details());
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = LETTER_FILE_NAME;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function attach() {
    const gap = missing(true);
    if (gap) return setError(gap);
    setBusy('attach');
    setError(null);
    try {
      const bytes = await buildLetterPdf(details());
      const file = new File([new Uint8Array(bytes)], LETTER_FILE_NAME, {
        type: 'application/pdf',
      });
      // One letter naming every number, on every port — each carrier request has to carry its own copy.
      // One at a time, so a failure names the number it failed on and the rest are still where they were.
      for (const p of ports) {
        try {
          await uploadPortDocument(workspaceId, p.id, 'loa', file);
        } catch (e) {
          throw new Error(`${p.display}: ${errorMessage(e)}`);
        }
      }
      toast.success(
        many
          ? `Letter signed and attached to all ${ports.length} numbers.`
          : 'Letter signed and attached.',
      );
      setRedo(false);
      onAttached();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-3 py-2" data-testid="port-letter-done">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-card">
          <CircleCheck className="h-4 w-4 text-success-text" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">Signed letter of authorisation</span>
          <span className="block text-xs text-text-3">
            {many ? `Attached to all ${ports.length} numbers.` : 'Attached.'}
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRedo(true)}
          data-testid="port-letter-redo"
        >
          <PenLine className="h-3.5 w-3.5" strokeWidth={1.8} />
          Make it again
        </Button>
      </div>
    );

  return (
    <div className="py-2" data-testid="port-letter">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-card">
          <FileSignature className="h-4 w-4 text-text-3" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">Sign the letter of authorisation</span>
          <span className="block text-xs text-text-3">
            The letter that tells your old carrier to release{' '}
            {many ? `these ${ports.length} numbers` : 'the number'}. We fill in Twilio’s template
            from what you type here; you sign it below and it is attached as a PDF.
            {ports.some((p) => p.documents.loa) && !allSigned
              ? ' Some numbers were added after the last one was made, so it needs making again to name them all.'
              : ''}
          </span>
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Legal business name" htmlFor="loa-business">
          <Input
            id="loa-business"
            value={value('businessName')}
            onChange={set('businessName')}
            data-testid="loa-business"
          />
        </Field>
        <Field
          label="Company registration number"
          htmlFor="loa-registration"
          hint="Your EIN, or your state registration number."
        >
          <Input
            id="loa-registration"
            value={value('registrationNumber')}
            onChange={set('registrationNumber')}
            placeholder="12-3456789"
            data-testid="loa-registration"
          />
        </Field>
        <Field
          label="What the business does"
          htmlFor="loa-services"
          className="sm:col-span-2"
          hint={`Finishes the sentence “${value('businessName').trim() || 'Your business'} provides …”.`}
        >
          <Input
            id="loa-services"
            value={value('services')}
            onChange={set('services')}
            placeholder="heating, cooling and roofing services to homes and businesses in Houston"
            data-testid="loa-services"
          />
        </Field>
        <Field label="Kind of numbers" htmlFor="loa-type">
          <Input
            id="loa-type"
            value={value('numberType')}
            onChange={set('numberType')}
            data-testid="loa-type"
          />
        </Field>
        <Field label="Where your customers are" htmlFor="loa-country">
          <Input
            id="loa-country"
            value={value('country')}
            onChange={set('country')}
            data-testid="loa-country"
          />
        </Field>
        <Field label="Business address (letterhead)" htmlFor="loa-address">
          <Input
            id="loa-address"
            value={value('address')}
            onChange={set('address')}
            placeholder="Street, city, state and ZIP"
            data-testid="loa-address"
          />
        </Field>
        <Field label="Website (letterhead)" htmlFor="loa-website">
          <Input
            id="loa-website"
            value={value('website')}
            onChange={set('website')}
            placeholder="Optional"
            data-testid="loa-website"
          />
        </Field>
      </div>

      <h4 className="mt-4 text-[13px] font-medium">Who signs it</h4>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="loa-signer">
          <Input
            id="loa-signer"
            value={value('signerName')}
            onChange={set('signerName')}
            autoComplete="name"
            data-testid="loa-signer"
          />
        </Field>
        <Field label="Title" htmlFor="loa-title">
          <Input
            id="loa-title"
            value={value('signerTitle')}
            onChange={set('signerTitle')}
            placeholder="Owner"
            autoComplete="organization-title"
            data-testid="loa-title"
          />
        </Field>
        <Field label="Phone number" htmlFor="loa-phone">
          <Input
            id="loa-phone"
            inputMode="tel"
            value={value('signerPhone')}
            onChange={set('signerPhone')}
            autoComplete="tel"
            data-testid="loa-phone"
          />
        </Field>
        <Field label="Email" htmlFor="loa-email">
          <Input
            id="loa-email"
            type="email"
            value={value('signerEmail')}
            onChange={set('signerEmail')}
            autoComplete="email"
            data-testid="loa-email"
          />
        </Field>
      </div>

      <div className="mt-4">
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
            label={`Signature of ${value('signerName') || 'the signatory'}`}
            onChange={setDrawn}
            testId="loa-signature"
          />
        ) : (
          <div className="flex h-32 items-center rounded-control border border-border-strong bg-white px-4">
            <span className="font-serif text-3xl italic text-[#111827]">
              {value('signerName') || 'Your name'}
            </span>
          </div>
        )}
      </div>

      <Checkbox
        className="mt-3 text-[13px]"
        checked={sure}
        onChange={(e) => setSure(e.target.checked)}
        label={`I am ${value('signerName').trim() || 'the person named above'}, and I am allowed to sign for ${value('businessName').trim() || 'this business'}.`}
        data-testid="loa-confirm"
      />

      {error ? (
        <Callout tone="danger" icon={CircleAlert} className="mt-3">
          {error}
        </Callout>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          loading={busy === 'attach'}
          disabled={busy !== null}
          onClick={() => void attach()}
          data-testid="loa-attach"
        >
          <FileSignature className="h-3.5 w-3.5" strokeWidth={1.8} />
          {many ? `Sign and attach to all ${ports.length} numbers` : 'Sign and attach'}
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
        {allSigned ? (
          <Button variant="ghost" onClick={() => setRedo(false)}>
            Keep the one attached
          </Button>
        ) : null}
      </div>
    </div>
  );
}
