import type { ReactNode } from 'react';
import { loadPost } from '@/lib/opinly/load';

/** Checks the post exists before the loading skeleton below starts the response (see lib/opinly/load.ts). */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  await loadPost((await params).slug);
  return children;
}
