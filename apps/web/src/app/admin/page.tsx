import { redirect } from 'next/navigation';

/** The desk opens on the queue, because that is what the day is. */
export default function AdminIndexPage() {
  redirect('/admin/tickets');
}
