'use client';
/**
 * A ticket that's a business's "Ask HandsFreeOS to check it" for its texting registration (2026-11-05): what wasn't
 * green when they asked, their note, the details exactly as they'd be sent, and the two answers. **Approve and send**
 * sends it as the business left it (the carriers' fees as usual) and tells them on the ticket; **Send back** tells
 * them what to change, and nothing goes. The commands check support.reply themselves.
 */
import { Check, CircleAlert, Loader2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

export interface RegistrationReviewView {
  readonly reviewId: string;
  readonly status: 'waiting' | 'approved' | 'sent_back' | 'withdrawn';
  readonly kind: 'a2p_10dlc' | 'toll_free_verification';
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly sentAt: string | null;
  readonly businessName: string;
  readonly note: string | null;
  readonly notGreen: readonly string[];
  readonly submission: Record<string, unknown>;
}

const KIND_WORD = {
  a2p_10dlc: '10DLC brand and campaign',
  toll_free_verification: 'Toll-free verification',
} as const;

const PATH_WORD: Record<string, string> = {
  hosted: 'The website chat (we collect it)',
  own_site: 'A form on their own website',
  in_person: 'In person or on the phone',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function Row({ label, children }: { label: string; children: ReactNode }) {
  if (children === '' || children === null) return null;
  return (
    <div className="border-b border-border py-2 last:border-0">
      <dt className="text-xs text-text-3">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-line break-words text-[13px]">{children}</dd>
    </div>
  );
}

const link = (url: string) =>
  url ? (
    <a className="underline" href={url} target="_blank" rel="noreferrer">
      {url}
    </a>
  ) : (
    ''
  );

export function RegistrationReviewPanel({ review }: { review: RegistrationReviewView }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'send_back' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const b = review.submission;
  const contact = (b['contact'] ?? {}) as Record<string, unknown>;
  const others = Array.isArray(b['otherWays']) ? (b['otherWays'] as Record<string, unknown>[]) : [];
  const samples = Array.isArray(b['messageSamples']) ? (b['messageSamples'] as unknown[]) : [];

  async function decide(what: 'approve' | 'send_back') {
    if (what === 'send_back' && !note.trim()) {
      setError('Say what they need to change: it goes to them on this ticket.');
      return;
    }
    setBusy(what);
    setError(null);
    try {
      unwrap(
        await (apiBrowser().POST as (p: string, o: { body: unknown }) => Promise<never>)(
          what === 'approve'
            ? '/v1/commands/registration.review.approve'
            : '/v1/commands/registration.review.send_back',
          { body: { reviewId: review.reviewId, ...(note.trim() ? { note: note.trim() } : {}) } },
        ),
      );
      setNote('');
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="mt-5 rounded-card border border-border bg-card p-4"
      data-testid="registration-review-panel"
    >
      <h2 className="text-[15px] font-semibold">Texting registration to check</h2>
      <p className="mt-0.5 text-[13px] text-text-3">
        {review.businessName} · {KIND_WORD[review.kind]}
      </p>

      {review.status === 'waiting' ? null : (
        <p
          className="mt-3 rounded-menu bg-card-2 px-3 py-2 text-[13px]"
          data-testid="registration-review-status"
        >
          {review.status === 'approved'
            ? review.sentAt
              ? 'Approved and sent to the carriers.'
              : 'Approved. Sending it to the carriers…'
            : review.status === 'sent_back'
              ? 'Sent back to the business.'
              : 'The business changed it since asking (sent it, or asked again), so there’s nothing to decide.'}
        </p>
      )}

      <h3 className="mt-4 text-[13.5px] font-semibold">What wasn’t green when they asked</h3>
      {review.notGreen.length ? (
        <ul className="mt-1.5 space-y-1.5 text-[13px]">
          {review.notGreen.map((line, i) => (
            <li key={i} className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-none text-warning-text" aria-hidden />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[13px] text-text-2">Nothing: everything was green.</p>
      )}
      {review.note ? (
        <>
          <h3 className="mt-4 text-[13.5px] font-semibold">Their note</h3>
          <p className="mt-1 whitespace-pre-line text-[13px]">{review.note}</p>
        </>
      ) : null}

      <h3 className="mt-4 text-[13.5px] font-semibold">What would be sent</h3>
      <dl className="mt-1">
        <Row label="Legal name">{str(b['legalName'])}</Row>
        <Row label="Name customers know">{str(b['displayName'])}</Row>
        <Row label="EIN">{str(b['ein']) || 'Sole proprietor (none)'}</Row>
        <Row label="Website">{link(str(b['website']))}</Row>
        <Row label="Contact">
          {[
            `${str(contact['firstName'])} ${str(contact['lastName'])}`.trim(),
            str(contact['email']),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Row>
        <Row label="How customers agree">{PATH_WORD[str(b['optInPath'])] ?? ''}</Row>
        <Row label="Where a reviewer sees it">
          {link(str(b['optInPath']) === 'in_person' ? str(b['optInProofUrl']) : str(b['optInUrl']))}
        </Row>
        {others.map((w, i) => (
          <Row key={i} label={`Also: ${PATH_WORD[str(w['path'])] ?? str(w['path'])}`}>
            {link(str(w['url']))}
          </Row>
        ))}
        <Row label="Privacy policy">{link(str(b['privacyPageUrl']) || str(b['policyUrl']))}</Row>
        <Row label="Terms">{link(str(b['termsPageUrl']) || str(b['termsUrl']))}</Row>
        <Row label="What we tell the carriers">{str(b['optInDescription'])}</Row>
        <Row label="Example texts">{samples.map((s) => `“${str(s)}”`).join('\n')}</Row>
      </dl>

      {review.status === 'waiting' ? (
        <div className="mt-4 border-t border-border pt-4">
          <label htmlFor="registration-review-note" className="text-[13px] font-medium">
            Note to the business
          </label>
          <Textarea
            id="registration-review-note"
            className="mt-1"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 4000))}
            placeholder="Needed to send it back: what to change. Optional when approving."
            data-testid="registration-review-staff-note"
          />
          {error ? (
            <p role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void decide('approve')}
              disabled={busy !== null}
              data-testid="registration-review-approve"
            >
              {busy === 'approve' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Approve and send
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void decide('send_back')}
              disabled={busy !== null}
              data-testid="registration-review-send-back"
            >
              {busy === 'send_back' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Undo2 className="h-4 w-4" />
              )}
              Send back
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-text-3">
            Approving sends it to the carriers exactly as shown, with their fees as usual. Either
            way, the business gets your note on this ticket by email.
          </p>
        </div>
      ) : null}
    </section>
  );
}
