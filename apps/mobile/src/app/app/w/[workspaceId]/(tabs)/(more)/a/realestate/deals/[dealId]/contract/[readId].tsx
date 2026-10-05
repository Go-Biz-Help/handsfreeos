import { useLocalSearchParams } from 'expo-router';

import { ContractScreen } from '@/addons/realestate/contract';

/** The contract as HandsFreeOS read it: read offline, decided with signal (board 80). */
export default function ContractRoute() {
  const { dealId, readId } = useLocalSearchParams<{ dealId: string; readId: string }>();
  return <ContractScreen dealId={dealId} readId={readId} />;
}
