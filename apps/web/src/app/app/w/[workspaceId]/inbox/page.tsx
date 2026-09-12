import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/empty-state';

export const metadata: Metadata = { title: 'Inbox' };

/** Beside the list on wide screens until a conversation is picked; phones show only the list. */
export default function InboxPage() {
  return (
    <div className="hidden flex-1 items-center justify-center md:flex">
      <EmptyState title="Pick a conversation">
        Choose one on the left to read it and reply.
      </EmptyState>
    </div>
  );
}
