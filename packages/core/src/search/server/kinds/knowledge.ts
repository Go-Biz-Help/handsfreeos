/**
 * Knowledge (workspace.read): the business's knowledge items through knowledge's own ranked search
 * (`searchKnowledge`), drafts included, with its `**` markers turned into marks. Nobody owns an item, so Only mine
 * leaves knowledge out.
 */
import { KNOWLEDGE_SEARCH_MAX_RESULTS, searchKnowledge } from '../../../knowledge/search';
import { searchHref } from '../../href';
import { tierOf } from '../../rank';
import { marksFromStars } from '../../snippet';
import { hitOf } from '../hit';
import type { KindSearcher } from '../run';

/**
 * knowledge's own search reads at most this many, in the box and on the page alike, so the box counts as far as the
 * page can show. A full read is marked capped ("20+"): there may be more.
 */
const KNOWLEDGE_ROWS = KNOWLEDGE_SEARCH_MAX_RESULTS;

export const knowledgeSearcher: KindSearcher = {
  key: 'knowledge',
  async find(db, plan) {
    if (plan.onlyMine || plan.archivedOnly || plan.p.words.length === 0)
      return [{ kind: 'knowledge', label: null, icon: null, hits: [] }];
    const found = await db.run((sp) =>
      searchKnowledge(sp, plan.workspaceId, plan.p.words.join(' '), {
        limit: KNOWLEDGE_ROWS,
        includeDrafts: true,
      }),
    );
    return [
      {
        kind: 'knowledge',
        label: null,
        icon: null,
        capped: found.length >= KNOWLEDGE_ROWS,
        hits: found.map((k) => {
          const snippet = k.snippet ? marksFromStars(k.snippet) : null;
          return hitOf({
            kind: 'knowledge',
            id: k.id,
            title: k.title,
            href: searchHref(plan.workspaceId, { type: 'knowledge', id: k.id }),
            tier: tierOf(k.title, plan.p) ?? 4,
            why: {
              field: 'knowledge',
              label: null,
              snippet: snippet?.text ? snippet : null,
              page: null,
            },
            badges: k.status === 'draft' ? ['draft'] : [],
            at: k.updatedAt,
          });
        }),
      },
    ];
  },
};
