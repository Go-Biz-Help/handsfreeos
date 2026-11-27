/**
 * A campaign email written in blocks (design tools, part 5): its blocks, filled with the person's first name, for the
 * email's HTML. The message keeps the plain words (the blocks' words, then the small print); the blocks are drawn only
 * while they still match those words, so an email changed since this one was made goes out as its words say.
 */
import {
  emailBlocksOf,
  emailBlocksText,
  fillEmailBlocks,
  FIRST_NAME_PLACEHOLDER,
  pictureUrlFor,
  type EmailBlocksDraw,
} from '@hfos/core';
import { rows, sql, type Tx } from '@hfos/db/client';

export async function campaignBlocksFor(
  tx: Tx,
  storageUrl: string | null | undefined,
  m: { readonly campaignRecipientId: string | null; readonly bodyText: string | null },
): Promise<EmailBlocksDraw | null> {
  if (!m.campaignRecipientId || !storageUrl) return null;
  const [r] = await rows<{ blocks: unknown; first_name: string | null }>(
    tx,
    sql`select c.email_blocks as blocks, p.first_name
        from app.campaign_recipients r
        join app.campaigns c on c.id = r.campaign_id
        join app.people p on p.id = r.person_id
        where r.id = ${m.campaignRecipientId}`,
  );
  const blocks = emailBlocksOf(r?.blocks);
  if (!r || !blocks) return null;
  // As the campaign fills its words (automations/campaigns.ts, fillFirstName).
  const fill = (text: string) =>
    text.split(FIRST_NAME_PLACEHOLDER).join(r.first_name?.trim() || 'there');
  if (!(m.bodyText ?? '').startsWith(fill(emailBlocksText(blocks)))) return null;
  return {
    blocks: fillEmailBlocks(blocks, fill),
    pictureUrl: (path) => pictureUrlFor(storageUrl, path),
  };
}
