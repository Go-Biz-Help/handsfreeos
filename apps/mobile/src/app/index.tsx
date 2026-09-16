import { Redirect } from 'expo-router';

import { useSession } from '@/lib/auth';

/** Where the app opens: the last business for someone signed in, otherwise signing in. */
export default function Index() {
  const state = useSession();
  return <Redirect href={state.status === 'signedIn' ? '/app' : '/sign-in'} />;
}
