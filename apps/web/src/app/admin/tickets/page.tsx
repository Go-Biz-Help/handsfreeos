import { TICKET_QUEUE_QUERIES, type TicketQueueFilter } from '@hfos/core';
import { apiServer, unwrap } from '@/lib/api/server';
import { TicketQueue } from '@/components/admin/ticket-queue';
import type { TicketRow } from '@/components/admin/ticket-bits';

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; q?: string; cursor?: string }>;
}) {
  const { show, q, cursor } = await searchParams;
  const filter = (show && show in TICKET_QUEUE_QUERIES ? show : 'unanswered') as TicketQueueFilter;
  const { api } = await apiServer();
  const where = TICKET_QUEUE_QUERIES[filter];
  const [list, counts] = await Promise.all([
    api
      .POST('/v1/queries/support.ticket.list', {
        body: {
          ...(where.status ? { status: [...where.status] } : {}),
          assignee: where.assignee,
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
