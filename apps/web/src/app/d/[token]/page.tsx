import type { Metadata } from 'next';
import { SigningPage } from '@/components/documents/signing-page';

/** The link carries the signer's key: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: { absolute: 'Your document to sign' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function SignDocumentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Everything is read from the signer's own browser, so the worker's per-address limits count per signer.
  return <SigningPage token={token} />;
}
