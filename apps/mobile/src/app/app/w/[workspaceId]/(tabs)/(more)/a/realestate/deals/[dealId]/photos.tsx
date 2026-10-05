import { useLocalSearchParams } from 'expo-router';

import { ListingPhotosScreen } from '@/addons/realestate/listing-photos';

/** A listing’s photos in order; more are taken on the spot with no signal (board 87). */
export default function PhotosRoute() {
  const { dealId } = useLocalSearchParams<{ dealId: string }>();
  return <ListingPhotosScreen dealId={dealId} />;
}
