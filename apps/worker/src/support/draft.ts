/**
 * The AI's suggested answer to a support ticket (M13).
 *
 * Chris chose (2026-09-18) that it drafts and a person sends — always. So this writes a row and stops. There
 * is no path from here to an email; the only way a customer ever hears from us is a person pressing send.
 *
 * What it is given: the conversation so far, the saved replies the desk already trusts, and a few tickets
 * that were answered before and looked like this one. Those are the sources it lists, so whoever reads the
 * draft can check it against the thing it learned from rather than taking its word.
 */
import { AiOutputError, parseStructured, type AiMessage } from '@hfos/ai';
import { asWorker, rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { THINKING_ROOM } from '../ai/ask';
import type { JobContext } from '../jobs';
import type { WorkerServices } from '../services';

const DraftAnswer = z.object({
  /** Plain text. The reply box is plain text, and so is what the customer gets. */
  reply: z.string().min(1).max(4000),
  /** Left empty when it has nothing solid to go on — an honest blank beats a confident guess. */
  confident: z.boolean(),
});

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'confident'],
  properties: {
    reply: { type: 'string', description: 'The suggested reply, in plain text.' },
    confident: {
      type: 'boolean',
      description: 'False when the answer is a guess rather than something the sources support.',
    },
  },
} as const;

const SYSTEM = `You write draft replies for HandsFreeOS support. HandsFreeOS is software that runs the
day-to-day of a small home-services business: its customers, texts and calls, email, calendar and booking,
invoices and payments, workflows, and an AI teammate that answers for the business.

A person reads your draft, edits it, and sends it. You never send anything.

How to write:
- Plain English, short sentences, no jargon and no marketing.
- Answer the question that was asked. If part of it cannot be answered from what you were given, say so in
  the draft rather than inventing a screen, a setting or a price.
- Never promise a refund, a discount, a delivery date, or that something will be built.
- Never ask for a password, a card number or a code.
- No greeting line and no sign-off: the desk adds those.
- If you do not have enough to go on, set confident to false and write the two or three questions a support
  person should ask instead.`;

interface Source {
  kind: string;
  title: string;
  id: string | null;
}

/** Saved replies and old answers that look like this one: what the desk already knows how to say. */
async function sourcesFor(
  ctx: Pick<WorkerServices, 'db'>,
  ticketId: string,
  subject: string,
): Promise<{ text: string; sources: Source[] }> {
  return asWorker(ctx.db, {}, async (tx) => {
    const saved = await rows<{ id: string; title: string; body_text: string }>(
      tx,
      sql`select id, title, body_text from platform.canned_replies order by title limit 20`,
    );
    // Tickets answered before whose subject reads like this one (trigram similarity). Crude on purpose: it
    // is a hint for the model, not a search engine, and a wrong hint costs a person ten seconds of reading.
    const similar = await rows<{ id: string; number: string; subject: string; answer: string }>(
      tx,
      sql`select t.id, t.number, t.subject,
                 (select m.body_text from platform.ticket_messages m
                  where m.ticket_id = t.id and m.author = 'staff' and m.internal = false
                  order by m.created_at limit 1) as answer
          from platform.tickets t
          where t.id <> ${ticketId} and t.status in ('solved', 'closed')
            and extensions.similarity(t.subject, ${subject}) > 0.3
          order by extensions.similarity(t.subject, ${subject}) desc
          limit 3`,
    );
    const sources: Source[] = [
      ...saved.map((s) => ({ kind: 'saved_reply', title: s.title, id: s.id })),
      ...similar
        .filter((s) => s.answer)
        .map((s) => ({ kind: 'past_ticket', title: `#${s.number} ${s.subject}`, id: s.id })),
    ];
    const text = [
      saved.length ? 'Saved replies the desk uses:' : '',
      ...saved.map((s) => `- ${s.title}: ${s.body_text.slice(0, 1200)}`),
      similar.length ? '\nHow tickets like this were answered before:' : '',
      ...similar
        .filter((s) => s.answer)
        .map((s) => `- "${s.subject}" was answered: ${s.answer.slice(0, 1200)}`),
    ]
      .filter(Boolean)
      .join('\n');
    return { text, sources };
  });
}

/**
 * Writes (or replaces) the draft for one ticket. Quiet about failures on purpose: no draft is a small
 * disappointment, and a failed job that keeps retrying is a bigger one.
 */
export async function writeTicketDraft(
  ctx: Pick<WorkerServices, 'db' | 'ai' | 'log'>,
  ticketId: string,
): Promise<'written' | 'skipped'> {
  const provider = ctx.ai.provider;
  if (!provider) return 'skipped';
  const [ticket] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ subject: string; status: string; requester_name: string }>(
      tx,
      sql`select subject, status, requester_name from platform.tickets where id = ${ticketId}`,
    ),
  );
  if (!ticket || ticket.status === 'closed') return 'skipped';
  const conversation = await asWorker(ctx.db, {}, (tx) =>
    rows<{ id: string; author: string; internal: boolean; body_text: string }>(
      tx,
      sql`select id, author, internal, body_text from platform.ticket_messages
          where ticket_id = ${ticketId} order by created_at limit 30`,
    ),
  );
  const lastCustomer = [...conversation].reverse().find((m) => m.author === 'customer');
  if (!lastCustomer) return 'skipped';

  const messages: AiMessage[] = [
    {
      role: 'user',
      content: [
        `Subject: ${ticket.subject}`,
        '',
        ...conversation.map(
          (m) =>
            `${m.author === 'customer' ? 'Customer' : m.internal ? 'Internal note' : 'Support'}: ${m.body_text.slice(0, 4000)}`,
        ),
      ].join('\n'),
    },
  ];
  try {
    const { text: sourceText, sources } = await sourcesFor(ctx, ticketId, ticket.subject);
    const turn = await provider.stream({
      system: SYSTEM,
      context: sourceText || 'Nothing saved to go on yet.',
      messages,
      maxTokens: 1200 + THINKING_ROOM,
      responseFormat: { schema: SCHEMA as unknown as Record<string, unknown> },
    });
    const answer = parseStructured(turn, DraftAnswer);
    await asWorker(ctx.db, {}, (tx) =>
      tx.execute(sql`insert into platform.ticket_drafts
        (ticket_id, body_text, sources, model, answers_message_id, created_at)
        values (${ticketId}, ${answer.reply.slice(0, 20000)},
          ${JSON.stringify(answer.confident ? sources : [])}::jsonb,
          ${provider.model.slice(0, 100)}, ${lastCustomer.id}, now())
        on conflict (ticket_id) do update set
          body_text = excluded.body_text, sources = excluded.sources, model = excluded.model,
          answers_message_id = excluded.answers_message_id, created_at = now(),
          used_at = null, dismissed_at = null`),
    );
    return 'written';
  } catch (e) {
    ctx.log.warn(
      { err: e, ticketId, bad: e instanceof AiOutputError },
      'no support draft was written',
    );
    return 'skipped';
  }
}

/** The job the desk queues when a ticket arrives, or when somebody presses "Ask the AI". */
export const supportDraftJob = async (ctx: JobContext): Promise<void> => {
  const ticketId = (ctx.job.payload as { ticketId?: string }).ticketId;
  if (!ticketId) return;
  await writeTicketDraft(ctx, ticketId);
};

export const SUPPORT_JOBS = { 'support.draft': supportDraftJob };
