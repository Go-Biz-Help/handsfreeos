import type { Metadata } from 'next';
import { FinishSignIn } from '@/components/settings/finish-sign-in';

export const metadata: Metadata = { title: 'Connecting' };

/** Where every sign-in to a provider comes back to, to be finished signed in (components/settings/finish-sign-in). */
export default function FinishSignInPage() {
  return <FinishSignIn />;
}
