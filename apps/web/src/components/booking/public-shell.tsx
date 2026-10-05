/**
 * The frame every public booking page shares: the business's name and phone on top, no app chrome, and a
 * small "Booking by HandsFreeOS" line at the bottom. Light or dark follows the customer's device.
 */
import { CalendarOff, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/ui/brand';
import { buttonClassName } from '@/components/ui/button';
import type { PublicBusiness } from '@/lib/api/public-booking';
import { cn, initials } from '@/lib/utils';

export function PublicHeader({ business }: { business: PublicBusiness }) {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex w-full max-w-[860px] items-center gap-2.5 px-4 py-3 md:px-6">
        <span
          aria-hidden
          className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-accent text-[13px] font-bold tracking-[0.02em] text-white"
        >
          {initials(business.name)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-medium" data-testid="business-name">
            {business.name}
          </span>
          {business.phoneDisplay ? (
            <a
              href={`tel:${business.phone}`}
              className="w-fit text-xs text-text-3 hover:text-text-2"
            >
              {business.phoneDisplay}
            </a>
          ) : null}
        </span>
      </div>
    </header>
  );
}

export function Byline({
  className,
  words = 'Booking by HandsFreeOS',
}: {
  className?: string;
  /** What the page is: "Booking by HandsFreeOS" unless it's another kind of page. */
  words?: string;
}) {
  return (
    <p
      className={cn(
        'flex items-center justify-center gap-[5px] text-[11.5px] text-text-3',
        className,
      )}
    >
      <BrandMark size={13} />
      {words}
    </p>
  );
}

export function PublicFrame({
  business,
  byline,
  children,
}: {
  business: PublicBusiness | null;
  /** The line at the bottom, when the page isn't a booking page. */
  byline?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text" data-testid="public-page">
      {business ? <PublicHeader business={business} /> : null}
      <div className="flex flex-1 flex-col">{children}</div>
      <footer className="px-4 pb-5 pt-3">
        <Byline words={byline} />
      </footer>
    </div>
  );
}

const TONES = {
  neutral: 'bg-card-2 text-text-3',
  warning: 'bg-warning-soft text-warning-text',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success-text',
} as const;

/** A centered message: booking off, a link out of date, no open times, not found. */
export function PublicState({
  tone = 'neutral',
  icon,
  title,
  children,
  action,
  testId,
}: {
  tone?: keyof typeof TONES;
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="mx-auto flex w-full max-w-[480px] flex-1 flex-col items-center justify-center px-6 py-12 text-center"
      data-testid={testId}
    >
      <span
        aria-hidden
        className={cn(
          'mb-1 inline-flex h-[42px] w-[42px] items-center justify-center rounded-full',
          TONES[tone],
        )}
      >
        {icon}
      </span>
      <h1 className="mt-1.5 text-[15px] font-semibold">{title}</h1>
      {children ? (
        <div className="mt-1.5 max-w-[320px] text-[13px] text-text-2">{children}</div>
      ) : null}
      {action ? <div className="mt-3.5">{action}</div> : null}
    </div>
  );
}

/** "Call (713) 555-0100", when the business has a number. */
export function CallButton({
  business,
  variant = 'primary',
}: {
  business: PublicBusiness;
  variant?: 'primary' | 'secondary';
}) {
  if (!business.phone || !business.phoneDisplay) return null;
  return (
    <a href={`tel:${business.phone}`} className={buttonClassName({ variant, size: 'sm' })}>
      <Phone size={15} aria-hidden />
      Call {business.phoneDisplay}
    </a>
  );
}

/** "call (713) 555-0100", or "contact Lone Star HVAC" when there's no number. */
export const callPhrase = (business: PublicBusiness): string =>
  business.phoneDisplay ? `call ${business.phoneDisplay}` : `contact ${business.name}`;

/** The canvas's "Booking page off" state. */
export function BookingOff({ business }: { business: PublicBusiness }) {
  return (
    <PublicState
      icon={<CalendarOff size={20} />}
      title="Online booking is off"
      action={<CallButton business={business} />}
      testId="booking-off"
    >
      {business.name} isn’t taking bookings online right now.{' '}
      {business.phoneDisplay ? 'Call and we’ll find a time.' : 'Contact them to find a time.'}
    </PublicState>
  );
}
