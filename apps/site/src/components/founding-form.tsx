'use client';

/**
 * The application form.
 *
 * Short on purpose. Every field past the fourth costs applications, and the only ones that actually decide
 * anything here are: who are you, how do we reach you, what do you do, and what is going wrong. The rest is
 * a conversation.
 *
 * It keeps what was typed on every failure. Somebody who wrote three paragraphs about their phone ringing
 * all day and lost them to a 502 does not write them again.
 */
import { useState } from 'react';
import { anonId, identify, track } from '@/lib/opinly/pixel';

/**
 * `ui.tsx`'s Button renders a Link — it is for navigation. A form needs a real submit control, so this is
 * the same styling on a real button rather than a Link pressed into a job it cannot do.
 */
const SUBMIT =
  'inline-flex items-center justify-center gap-2 rounded-[10px] px-7 py-4 text-lg font-semibold transition-colors bg-accent text-white hover:bg-accent-hover shadow-[var(--shadow-2)] disabled:opacity-60';

type State =
  | { kind: 'idle' | 'sending' }
  | { kind: 'done'; waitlisted: boolean }
  | { kind: 'error'; message: string };

const FIELD =
  'bg-card border-border focus:border-accent focus:ring-accent/25 w-full rounded-[var(--radius-control)] border px-3.5 py-2.5 text-base outline-none focus:ring-2';

export function FoundingForm({ offerId, full }: { offerId: string; full: boolean }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '');
    setState({ kind: 'sending' });
    try {
      const res = await fetch('/api/founding/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          offerId,
          businessName: String(data.get('businessName') ?? ''),
          contactName: String(data.get('contactName') ?? ''),
          email,
          phone: String(data.get('phone') ?? ''),
          industry: String(data.get('industry') ?? ''),
          note: String(data.get('note') ?? ''),
          // The honeypot. Hidden from people, irresistible to crawlers.
          company_website_url: String(data.get('company_website_url') ?? ''),
          source: typeof document === 'undefined' ? '' : document.referrer.slice(0, 300),
          // Opinly's visitor id, so the server's copy of this lead lands on this visit (api/founding/apply).
          anonId: anonId(),
        }),
      });
      if (!res.ok) {
        setState({
          kind: 'error',
          message:
            res.status === 429
              ? 'That is a few tries in a row. Give it a minute and try again.'
              : 'We could not get that to our side just now. Try again in a moment — what you typed is still here.',
        });
        return;
      }
      const body = (await res.json()) as { applicationId?: string; status?: string };
      // The form is reset only once the answer is in, so a failure never costs somebody their words.
      form.reset();
      setState({ kind: 'done', waitlisted: body.status === 'waitlisted' });
      /**
       * The site sells nothing, so an application is the conversion that matters. Only a real one has an id: the
       * honeypot's answer does not. The worker gives a second press of the button the same id, so it counts once.
       */
      if (body.applicationId) {
        identify({ email });
        track(
          'generate_lead',
          { offer: offerId, status: body.status },
          { externalEventId: body.applicationId },
        );
      }
    } catch {
      setState({
        kind: 'error',
        message:
          'That did not send — check your connection and try again. What you typed is still here.',
      });
    }
  }

  if (state.kind === 'done')
    return (
      <div className="border-border bg-card-2 rounded-[var(--radius-card)] border p-6">
        <h3 className="text-lg font-semibold">
          {state.waitlisted ? 'You are on the waitlist.' : 'That is with us.'}
        </h3>
        <p className="text-text-2 mt-2">
          {state.waitlisted
            ? 'Every seat is taken right now. If one frees up — and they do — you are near the front of the queue, and we will email you.'
            : 'We read every one of these ourselves. Expect an email within a few days, from a person, about your business rather than a form letter.'}
        </p>
      </div>
    );

  return (
    <form onSubmit={submit} className="grid gap-4">
      {full ? (
        <p className="border-border bg-card-2 text-text-2 rounded-[var(--radius-card)] border p-4 text-sm">
          Every seat is taken at the moment. Apply anyway and you go on the waitlist — seats do come
          back.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5">
          <span className="text-sm font-semibold">Your business</span>
          <input
            name="businessName"
            required
            maxLength={200}
            className={FIELD}
            autoComplete="organization"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-sm font-semibold">Your name</span>
          <input
            name="contactName"
            required
            maxLength={200}
            className={FIELD}
            autoComplete="name"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-sm font-semibold">Email</span>
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            className={FIELD}
            autoComplete="email"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-sm font-semibold">
            Phone <span className="text-text-3 font-normal">(optional)</span>
          </span>
          <input name="phone" type="tel" maxLength={40} className={FIELD} autoComplete="tel" />
        </label>
      </div>

      <label className="grid gap-1.5">
        <span className="text-sm font-semibold">What do you do?</span>
        <input
          name="industry"
          maxLength={120}
          className={FIELD}
          placeholder="Plumbing, HVAC, a dental practice, a cleaning company…"
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-sm font-semibold">What is going wrong right now?</span>
        <textarea
          name="note"
          rows={5}
          maxLength={4000}
          className={FIELD}
          placeholder="Missed calls, quotes nobody chased, a CRM you are always behind on updating — whatever made you read this far."
        />
        <span className="text-text-3 text-sm">
          This is the part we actually read. It is how we pick.
        </span>
      </label>

      {/* Hidden from people, and from screen readers, but not from a crawler filling in every input. */}
      <div aria-hidden className="absolute h-0 w-0 overflow-hidden opacity-0">
        <label>
          Company website URL
          <input name="company_website_url" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      {state.kind === 'error' ? (
        <p className="border-danger/40 bg-danger/5 text-danger rounded-[var(--radius-card)] border p-3.5 text-sm">
          {state.message}
        </p>
      ) : null}

      <div className="flex items-center gap-4">
        <button type="submit" className={SUBMIT} disabled={state.kind === 'sending'}>
          {state.kind === 'sending' ? 'Sending…' : 'Apply for a seat'}
        </button>
        <span className="text-text-3 text-sm">No card, and nothing to cancel.</span>
      </div>
    </form>
  );
}
