import { useLocalSearchParams } from 'expo-router';

import { PartnerScreen } from '@/partners/screens';

/** A partner, at the web's own address (/app/w/<business>/settings/partners/<partner>). */
export default function PartnerRoute() {
  const { partnerId } = useLocalSearchParams<{ partnerId: string }>();
  return <PartnerScreen partnerId={String(partnerId ?? '')} />;
}
