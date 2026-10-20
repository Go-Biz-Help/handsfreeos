'use client';
import { lastContactLine, SEARCH_WORDS, type SearchHit } from '@hfos/core';
import {
  GreyLine,
  HitTitle,
  linesOf,
  PersonMark,
  WhyChip,
  type RowContext,
  type RowView,
} from './parts';

/**
 * A contact: their avatar, name and Lead or Client badge, and "(504) 555-0142 · dana.smith@gmail.com · Texted 2 days
 * ago". Found by their address, the line is where they are; a second contact on the same number says so (board 4).
 * On the Search page the open lead or the company sits under the name, and phone, email and last contact are columns.
 */
export function contactRow(hit: SearchHit, ctx: RowContext): RowView {
  const f = hit.facts;
  const { line, under } = linesOf(hit, ctx);
  const shown =
    hit.duplicateOf && f.phone
      ? `${f.phone} · ${SEARCH_WORDS.sameNumber}`
      : hit.why.field === 'address' && f.where
        ? f.where
        : line;
  return {
    leading: <PersonMark hit={hit} />,
    title: <HitTitle hit={hit} ctx={ctx} />,
    line: <GreyLine text={shown} ctx={ctx} />,
    under: under ? <GreyLine text={under} ctx={ctx} /> : null,
    chips: <WhyChip hit={hit} />,
    columns: [
      f.phone ?? null,
      f.email ?? null,
      f.lastContact ? lastContactLine(f.lastContact, ctx) : null,
    ],
  };
}
