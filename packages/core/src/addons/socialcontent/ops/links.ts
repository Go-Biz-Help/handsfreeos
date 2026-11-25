/**
 * The business's link in its own posts (docs/socialcontent.md, "Your link"; the owner, 24 Nov 2026): set on the
 * Playbook page, with where it goes on each network. A post carries it only when its words point people to it
 * (`content.link_place`), so the AI never promises a link that isn't there.
 */
import { rows, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand } from '../../server';
import { POSTING_NETWORKS, isPostingNetwork, type PostingNetwork } from '../calendar';
import { LinkOut, LinkSaveInput } from '../content-shapes';
import {
  cleanLink,
  linkPlacesChanged,
  mentionsLink,
  type LinkPlace,
  type LinkPlaces,
} from '../links';
import { socialcontentAddon } from '../manifest';
import { content, settings } from '../tables';
import { SOCIALCONTENT_WORDS as W } from '../words';
import { inWorkspace, settingsOf, type Ctx } from './common';

/** The business's link and where it goes on each network, as the Playbook shows them. */
export async function linkOf(
  ctx: Ctx,
): Promise<{ link: string | null; linkPlaces: Record<PostingNetwork, LinkPlace> }> {
  const s = await settingsOf(ctx);
  return { link: s.link, linkPlaces: s.linkPlaces };
}

/**
 * Posts not up yet whose words point people to a link but carry none, given the link where it goes on their network:
 * the posts written before there was a link to carry (the owner's ask, 24 Nov). A post whose words say where the link
 * is takes that place; any other, the network's. How many now carry it.
 */
async function carryLink(ctx: Ctx, places: LinkPlaces): Promise<number> {
  const waiting = await rows<{ id: string; network: string; words: string; chain: string[] }>(
    ctx.tx,
    sql`select c.record_id as id, c.network, c.words, c.chain
          from addon_socialcontent.content c
          join app.custom_records r on r.id = c.record_id and r.archived_at is null
         where c.workspace_id = ${ctx.scope.workspaceId!} and c.link_place is null
           and c.state in ('draft', 'ready', 'failed')`,
  );
  let carried = 0;
  for (const c of waiting) {
    if (!isPostingNetwork(c.network) || ![c.words, ...(c.chain ?? [])].some(mentionsLink)) continue;
    // Its words stay as they are, so an OK'd one keeps its OK: it now has the link it promised.
    await ctx.tx
      .update(content)
      .set({
        linkPlace: placeSaid(c.words) ?? places[c.network],
        updatedAt: changeMoment(ctx.meta),
      })
      .where(eq(content.recordId, c.id));
    carried++;
  }
  return carried;
}

/** Where the words themselves say the link is: in the bio, or in the comments or replies; null when they don't say. */
export function placeSaid(words: string): LinkPlace | null {
  if (
    /\b(?:in|on|from) (?:my|our|the) bio\b|\blink in bio\b|\blinks?(?:['’]s| is)? in (?:my |our |the )?(?:bio|profile)\b/i.test(
      words,
    )
  )
    return 'bio';
  if (
    /\b(?:in|see) the (?:first )?(?:comments?|repl(?:y|ies))\b|\blink (?:in|on) (?:the )?(?:first )?comment/i.test(
      words,
    )
  )
    return 'comment';
  return null;
}

export const linkSave = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.link.save',
  description:
    'Set the business’s link for its own posts (the Playbook page’s Your link), and where it goes on each network: "post" (on a line after the post’s words), "bio" (the words say the link is in the bio, where the business keeps it) or "comment" (the extension writes it as the first comment once the post is up; on Threads and X, a reply under it). The AI only points people to the link when the business has one, and says where it is. A link just added is carried by the posts not up yet whose words already point to one. What isn’t given stays as it is; a null or empty link takes it off.',
  risk: 1,
  input: LinkSaveInput,
  output: LinkOut,
  permission: 'socialcontent.manage',
  scope: inWorkspace,
  ai: {
    tool: 'socialcontent_save_link',
    autonomy: 'confirm',
    what: (input) => {
      const i = input as { link?: string | null; places?: Record<string, unknown> };
      const parts = [
        i.link === null || i.link === ''
          ? 'take the link off'
          : i.link !== undefined
            ? `set the link to ${i.link}`
            : null,
        i.places && Object.keys(i.places).length ? 'where it goes on each network' : null,
      ].filter((p): p is string => !!p);
      return parts.length
        ? `Change the link in your posts: ${parts.join(', ')}`
        : 'Change the link in your posts';
    },
    outcome: () => ({ words: W.link.saved, path: 'a/socialcontent/playbook' }),
  },
  emits: ['socialcontent.link.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const was = await settingsOf(ctx);
    let link = was.link;
    if (input.link !== undefined) {
      const typed = (input.link ?? '').trim();
      link = typed ? cleanLink(typed) : null;
      if (typed && !link)
        throw HfosError.rule(
          'socialcontent_link_not_a_link',
          400,
          `“${typed.slice(0, 80)}” isn’t a web address. Type the whole address, like yourbusiness.com/book.`,
        );
    }
    const linkPlaces = linkPlacesChanged(was.linkPlaces, input.places ?? {});
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .insert(settings)
      .values({ workspaceId: ctx.scope.workspaceId!, link, linkPlaces, updatedBy: me })
      .onConflictDoUpdate({
        target: settings.workspaceId,
        set: { link, linkPlaces, updatedBy: me, updatedAt: at },
      });
    // A link just added: the posts written before it, whose words point to a link, carry it now.
    const carried = link && !was.link ? await carryLink(ctx, linkPlaces) : 0;
    await ctx.emit({
      type: 'socialcontent.link.saved',
      entityType: 'socialcontent_settings',
      payload: {
        hasLink: link !== null,
        places: POSTING_NETWORKS.map((n) => `${n}:${linkPlaces[n]}`).join(','),
        carried,
      },
    });
    return { link, places: linkPlaces, carried };
  },
});

export const linkCommands = [linkSave] as const;
