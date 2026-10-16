/**
 * Groups: the list of the ones you're in, search results, a group's own page (its name, whether it's public, how
 * many members it has, and whether you've joined or asked to), and its About tab (what it says it's for, and its
 * rules from the admins: docs/outreach.md, decision 48).
 */
import { buttonLabels, clean, collectLinked, inTopBar, namesOn, textLines } from './dom';
import { bestName } from './people';
import type { GroupAbout, GroupLink, GroupPage, PageAddress } from './types';
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
  // The People tab's heading has the exact count ("Members · 34,718"); the top rounds it ("34.7K members").
  const exact = lines.map((line) => /^members\s*[·•]\s*([\d.,]+)$/i.exec(line)?.[1]).find(Boolean);
  let members = exact ? parseCount(exact) : null;
  for (const line of members === null ? lines : []) {
    const match = /([\d.,]+\s*[km]?)\s+members\b/i.exec(line);
    if (match?.[1]) {
      members = parseCount(match[1]);
      break;
    }
  }
  const labels = buttonLabels(root).map((label) => label.toLowerCase());
  // Asked to join and waiting for the admins: Facebook offers to cancel the request.
  const asked = labels.some((label) => ASKED.test(label));
  const joined = labels.includes('joined')
    ? true
    : asked || labels.some((label) => label === 'join group' || label === 'join')
      ? false
      : null;
  return {
    name,
    group: address.group,
    privacy: privacyLine ? (/^public/i.test(privacyLine) ? 'public' : 'private') : null,
    members,
    joined,
    asked,
  };
}

/** The buttons a group shows once the person asked to join and the admins haven't answered. */
const ASKED = /^(cancel request|pending|requested)$/i;

/** The headings on a group's About tab that start its rules, and the ones that come after them. */
const RULES_HEADING = /^(group rules( from the admins)?|rules)$/i;
const AFTER_RULES = /^(members|activity|recent media|group activity|featured|see all)$/i;
/** The parts of the About tab that aren't about what the group is for. */
const ABOUT_HEADING = /^(about( this group)?)$/i;
const NOT_ABOUT = /^(private|public|visible|hidden|history|general)$/i;
const LABELLED = /^(Private|Public|Visible|Hidden|History|General)\s+(?=[A-Z])/;

/** How much of the About tab is kept: what it's for, and the rules. */
const ABOUT_MOST = 30;
const RULES_MOST = 20;
const LINE_MOST = 300;
const RULE_MOST = 500;

/**
 * A group's About tab (/groups/<group>/about/): what it says it's for, where and who for, and its rules from the
 * admins, each rule with its explanation as one line ("No promotions or spam: Self-promotion is only allowed in the
 * Monday thread."). Its name, counts, buttons and tabs are left out.
 */
export function readGroupAbout(root: Element): GroupAbout {
  const name = clean(root.querySelector('h1')?.textContent) || null;
  const lines = textLines(root, 200, '[role="button"], button, [role="tablist"], h1')
    .filter(
      (line) =>
        line !== name &&
        // The heading after the rules ("Members") is a UI word too, but it says where they end.
        (AFTER_RULES.test(line) || !UI_WORDS.has(line.toLowerCase())) &&
        !/^\d+$/.test(line),
    )
    // A detail's label and a rule's number sit beside it: "Visible Anyone can find this group.", "1 Be kind".
    .map((line) => line.replace(LABELLED, '').replace(/^\d{1,2}\s+(?=\S)/, ''));
  const rulesAt = lines.findIndex((line) => RULES_HEADING.test(line));
  const aboutLines = (rulesAt < 0 ? lines : lines.slice(0, rulesAt)).filter(
    (line) =>
      !ABOUT_HEADING.test(line) &&
      !NOT_ABOUT.test(line) &&
      !AFTER_RULES.test(line) &&
      !/^(public|private) group\b/i.test(line) &&
      !/\bmembers?\b.*\d|\d.*\bmembers?\b/i.test(line),
  );
  const rules: string[] = [];
  if (rulesAt >= 0)
    for (const line of lines.slice(rulesAt + 1)) {
      if (AFTER_RULES.test(line)) break;
      // A rule's title, then the lines that explain it, joined into one.
      const last = rules.length - 1;
      if (last >= 0 && !/[.!?]$/.test(rules[last]!) && !rules[last]!.includes(': '))
        rules[last] = `${rules[last]}: ${line}`;
      else rules.push(line);
    }
  const cut = (line: string, most: number) =>
    line.length <= most ? line : `${line.slice(0, most - 1)}…`;
  return {
    about: aboutLines.slice(0, ABOUT_MOST).map((line) => cut(line, LINE_MOST)),
    rules: rules.slice(0, RULES_MOST).map((line) => cut(line, RULE_MOST)),
  };
}
