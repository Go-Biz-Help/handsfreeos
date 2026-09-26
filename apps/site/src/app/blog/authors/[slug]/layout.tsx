import type { ReactNode } from 'react';
import { loadAuthor } from '@/lib/opinly/load';

/** Checks the author exists before the loading skeleton below starts the response (see lib/opinly/load.ts). */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  await loadAuthor((await params).slug);
  return children;
}
