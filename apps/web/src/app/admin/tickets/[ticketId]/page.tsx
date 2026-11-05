import { apiServer, unwrapPage } from '@/lib/api/server';
import { TicketView } from '@/components/admin/ticket-view';
import type { TicketRow } from '@/components/admin/ticket-bits';

export default async function TicketPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const { api, userId } = await apiServer();
  const ticket = unwrapPage(
    await api.POST('/v1/queries/support.ticket.get', { body: { ticketId } }),
  );
  const [me, staff, replies, check] = await Promise.all([
    api.POST('/v1/queries/platform.me', { body: {} }).then(unwrapPage),
    api.POST('/v1/queries/support.staff.list', { body: {} }).then(unwrapPage),
    api.POST('/v1/queries/support.canned_reply.list', { body: {} }).then(unwrapPage),
    // A business's "Ask HandsFreeOS to check it" for its texting registration: shown with Approve and Send back.
    api
      .POST('/v1/queries/registration.review.for_staff', { body: { ticketId } })
      .then(unwrapPage)
      .then((r) => r.review)
      .catch(() => null),
  ]);
  const permissions = me.staff?.permissions ?? [];
  return (
    <TicketView
      ticket={ticket.ticket as unknown as TicketRow}
      messages={ticket.messages}
      events={ticket.events}
      draft={ticket.draft}
      business={ticket.business}
      alsoFrom={ticket.alsoFrom}
      staff={staff.staff
        .filter((s) => s.status === 'active')
        .map((s) => ({ userId: s.userId, fullName: s.fullName, displayName: s.displayName }))}
      savedReplies={replies.replies.map((r) => ({
        id: r.id,
        title: r.title,
        bodyText: r.bodyText,
      }))}
      can={{
        assign: permissions.includes('support.assign'),
        viewAs: permissions.includes('platform.view_as'),
        founder: me.staff?.founder === true,
      }}
      meUserId={userId}
      registrationReview={check}
    />
  );
}
