'use client';
/**
 * Messenger's and Instagram's marks (20261025000200), drawn as line icons so they sit beside the inbox's others
 * (lucide's, which carry no brands): the list, the thread, the composer, the customer's page and Settings.
 */
import type { SocialChannel } from '@hfos/core';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface IconProps {
  readonly className?: string;
  readonly strokeWidth?: number;
}

function Line({
  className,
  strokeWidth = 1.5,
  children,
}: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('h-3.5 w-3.5 flex-none', className)}
    >
      {children}
    </svg>
  );
}

/** Messenger: the speech bubble with its zigzag. */
export function MessengerIcon(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M12 2.75c-5.2 0-9.25 3.84-9.25 8.75 0 2.62 1.16 4.94 3.05 6.53v3.22l3.05-1.68c1 .29 2.06.43 3.15.43 5.2 0 9.25-3.84 9.25-8.75S17.2 2.75 12 2.75z" />
      <path d="m7.25 13.75 3.25-3.5 2.6 2.25 3.65-3.75" />
    </Line>
  );
}

/** Instagram: the rounded camera. */
export function InstagramIcon(props: IconProps) {
  return (
    <Line {...props}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.5 6.5h.01" />
    </Line>
  );
}

export const SOCIAL_ICONS: Readonly<Record<SocialChannel, (props: IconProps) => ReactNode>> = {
  messenger: MessengerIcon,
  instagram: InstagramIcon,
};

/** The channel's mark, named for screen readers, the size of the inbox's other marks. */
export function SocialMark({
  channel,
  className,
  label = true,
}: {
  channel: SocialChannel;
  className?: string;
  /** Off where the words beside it already say which. */
  label?: boolean;
}) {
  const Icon = SOCIAL_ICONS[channel];
  const name = channel === 'messenger' ? 'Messenger' : 'Instagram';
  return label ? (
    <span role="img" aria-label={name} className="inline-flex flex-none">
      <Icon className={className} />
    </span>
  ) : (
    <Icon className={className} />
  );
}
