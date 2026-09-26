import type { ReactNode } from 'react';
import { loadTag } from '@/lib/opinly/load';

/** Checks the tag exists before the loading skeleton below starts the response (see lib/opinly/load.ts). */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  await loadTag((await params).slug);
  return children;
}
