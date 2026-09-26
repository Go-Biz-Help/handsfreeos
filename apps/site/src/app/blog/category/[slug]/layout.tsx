import type { ReactNode } from 'react';
import { loadCategory } from '@/lib/opinly/load';

/** Checks the category exists before the loading skeleton below starts the response (see lib/opinly/load.ts). */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  await loadCategory((await params).slug);
  return children;
}
