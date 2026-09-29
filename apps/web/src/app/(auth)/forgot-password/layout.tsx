import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The page is a client component, so its title lives here. Nobody searches for it, so it stays out of results.
export const metadata: Metadata = {
  title: 'Reset your password',
  description: 'Get a link to choose a new password for your HandsFreeOS account.',
  robots: { index: false },
};

export default function ForgotPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
