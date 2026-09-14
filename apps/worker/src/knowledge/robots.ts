/**
 * robots.txt (RFC 9309) for the website scan: the groups that name our crawler (HandsFreeOS), or else the
 * `*` groups. Allow and Disallow use the longest match, Allow winning a tie; `*` matches any run of
 * characters and a final `$` anchors the end. Sitemap lines count wherever they are.
 */

export const ROBOTS_AGENT = 'handsfreeos';

export interface RobotsRule {
  readonly allow: boolean;
  readonly path: string;
}

export interface Robots {
  readonly rules: readonly RobotsRule[];
  readonly sitemaps: readonly string[];
}

/** No robots.txt: everything may be read. */
export const ALLOW_ALL: Robots = { rules: [], sitemaps: [] };

interface Group {
  readonly agents: string[];
  readonly rules: RobotsRule[];
}

export function parseRobots(text: string, agent: string = ROBOTS_AGENT): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let group: Group | null = null;
  let readingAgents = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*$/, ''));
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    if (key === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (!group || !readingAgents) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase().split('/')[0]!.trim());
      readingAgents = true;
      continue;
    }
    readingAgents = false;
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if ((key === 'allow' || key === 'disallow') && group && value) {
      // An empty Disallow allows everything: nothing to add.
      group.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const named = groups.filter((g) => g.agents.includes(agent.toLowerCase()));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes('*'));
  return { rules: chosen.flatMap((g) => g.rules), sitemaps };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  return new RegExp(`^${body.split('*').map(escapeRegExp).join('.*')}${anchored ? '$' : ''}`).test(
    path,
  );
}

/** Whether the rules let us read a path (with its query string). /robots.txt itself always may be. */
export function robotsAllows(robots: Pick<Robots, 'rules'>, pathAndQuery: string): boolean {
  if (pathAndQuery === '/robots.txt') return true;
  let best: RobotsRule | null = null;
  for (const rule of robots.rules) {
    if (!matches(rule.path, pathAndQuery)) continue;
    const longer = !best || rule.path.length > best.path.length;
    const tieToAllow = !!best && rule.path.length === best.path.length && rule.allow && !best.allow;
    if (longer || tieToAllow) best = rule;
  }
  return best ? best.allow : true;
}
