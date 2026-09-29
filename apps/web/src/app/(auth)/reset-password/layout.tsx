import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// A client component, so its title lives here. It only opens from an emailed link, so it stays out of search.
export const metadata: Metadata = {
  title: 'Choose a new password',
  robots: { index: false },
};

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
