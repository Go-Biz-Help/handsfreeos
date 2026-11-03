import type { Metadata } from 'next';
import { WebinarDoorPage } from '@/components/booking/webinar-door';
import { getWebinarDoor, pageData } from '@/lib/api/public-booking';

type Props = { params: Promise<{ key: string }> };

/** A webinar's link anyone can use (the owner's 5c): shared in posts, ads and emails, so it reads well in a preview. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params;
  const door = await pageData(getWebinarDoor(key));
  return {
    title: { absolute: `${door.title} · ${door.business.name}` },
    description: `${door.when} (${door.zone}). Save your seat for this live webinar.`,
  };
}

export default async function WebinarDoorRoute({ params }: Props) {
  const { key } = await params;
  const door = await pageData(getWebinarDoor(key));
  return <WebinarDoorPage doorKey={key} door={door} />;
}
