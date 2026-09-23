import { Redirect, useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { useSession } from '@/lib/auth';
import { chooseBusiness, lastOpenedBusiness, useMe } from '@/lib/businesses';

/**
 * Where an email about an idea opens (`/app/ideas/<id>`, the link the worker writes). The board is every business's,
 * so the link names none: the idea opens in the business the person had open last, as the web's own page does.
 */
export default function IdeaFromEmail() {
  const state = useSession();
  if (state.status !== 'signedIn') return null;
  return <Open userId={state.person.userId} />;
}

function Open({ userId }: { userId: string }) {
  const { ideaId } = useLocalSearchParams<{ ideaId: string }>();
  const { me } = useMe(userId);
  if (!me) return null;
  const business = chooseBusiness(me.businesses, lastOpenedBusiness(userId));
  if (!business) return <Redirect href="/app" />;
  return <Redirect href={`/app/w/${business.id}/ideas/${String(ideaId)}`} />;
}
