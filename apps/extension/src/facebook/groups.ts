/**
 * Groups: the list of the ones you're in, search results, and a group's own page (its name, whether it's public, how
 * many members it has, and whether you've joined).
 */
import { buttonLabels, clean, collectLinked, inTopBar, namesOn, textLines } from './dom';
import { bestName } from './people';
import type { GroupLink, GroupPage, PageAddress } from './types';
import { groupFromUrl } from './urls';
import { parseCount, UI_WORDS } from './vocabulary';

/** Every group a part of the page links to, each once, in page order. */
export function readGroupLinks(root: Element, base: string): GroupLink[] {
  const linked = collectLinked(
    root,
    base,
    (url) => {
      const group = groupFromUrl(url);
      return group ? { key: group.id.toLowerCase(), value: group } : null;
    },
    { skip: inTopBar },
  );
  const groups: GroupLink[] = [];
  for (const entry of linked) {
    const name = bestName(namesOn(entry.anchors));
    if (!name) continue;
    const detail =
      textLines(entry.card, 8).find(
        (line) => !line.startsWith(name) && !UI_WORDS.has(line.toLowerCase()) && line.length <= 120,
      ) ?? null;
    groups.push({ name, group: entry.value, detail });
  }
  return groups;
}

export function readGroupPage(root: Element, address: PageAddress): GroupPage {
  const heading = root.querySelector('h1');
  const name = heading ? clean(heading.textContent) || null : null;
  const lines = textLines(root, 150);
  const privacyLine = lines.find((line) => /^(public|private) group\b/i.test(line));
  let members: number | null = null;
  for (const line of lines) {
    const match = /([\d.,]+\s*[km]?)\s+members\b/i.exec(line);
    if (match?.[1]) {
      members = parseCount(match[1]);
      break;
    }
  }
  const labels = buttonLabels(root).map((label) => label.toLowerCase());
  const joined = labels.includes('joined')
    ? true
    : labels.some((label) => label === 'join group' || label === 'join')
      ? false
      : null;
  return {
    name,
    group: address.group,
    privacy: privacyLine ? (/^public/i.test(privacyLine) ? 'public' : 'private') : null,
    members,
    joined,
  };
}
