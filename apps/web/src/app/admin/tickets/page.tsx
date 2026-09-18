import { apiServer, unwrap } from '@/lib/api/server';
import { TicketQueue, type QueueFilter } from '@/components/admin/ticket-queue';
import type { TicketRow } from '@/components/admin/ticket-bits';

type TicketStatus = 'new' | 'open' | 'waiting_on_customer' | 'solved' | 'closed';

/** What each of the queue's tabs actually asks for. */
const FILTERS: Record<
  QueueFilter,
  { status?: TicketStatus[]; assignee?: 'mine' | 'unassigned' | 'anyone' }
> = {
  unanswered: { status: ['new', 'open'] },
  mine: { status: ['new', 'open', 'waiting_on_customer'], assignee: 'mine' },
  unassigned: { status: ['new', 'open'], assignee: 'unassigned' },
  waiting: { status: ['waiting_on_customer'] },
  all: {},
};

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; q?: string; cursor?: string }>;
}) {
  const { show, q, cursor } = await searchParams;
  const filter: QueueFilter = (show && show in FILTERS ? show : 'unanswered') as QueueFilter;
  const { api } = await apiServer();
  const where = FILTERS[filter];
  const [list, counts] = await Promise.all([
    api
      .POST('/v1/queries/support.ticket.list', {
        body: {
          ...(where.status ? { status: where.status } : {}),
          assignee: where.assignee ?? 'anyone',
          ...(q ? { search: q } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 25,
        },
      })
      .then(unwrap),
    api.POST('/v1/queries/support.queue.summary', { body: {} }).then(unwrap),
  ]);
  return (
    <TicketQueue
      tickets={list.tickets as unknown as TicketRow[]}
      filter={filter}
      search={q ?? ''}
      nextCursor={list.nextCursor}
      counts={counts}
    />
  );
}
