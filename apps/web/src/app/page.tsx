import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/supabase/server';

export default async function IndexPage() {
  redirect((await getServerSession()) ? '/app' : '/sign-in');
}
