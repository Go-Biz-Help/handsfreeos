import {
  hello,
  say,
  toolCall,
  unquote,
  type TeammateRule,
  type TeammateTurn,
} from '../../ai/scripted';

/**
 * Real Estate's lines for the scripted stand-in's teammate (round seven; local development and the browser suite,
 * never production): a client asking to add a home has their agent asked first, "where are we?" is answered from
 * their deal as their portal shows it, and asking what an area is like gets a reply the fair housing checks hold.
 * Each reply starts the way core's lines do: saying it's an AI when it's the teammate's first message.
 */

interface PortalDeal {
  readonly dealId: string;
  readonly name: string;
  readonly side: 'buyer' | 'listing';
  readonly stage: string;
  readonly step: number;
  readonly steps: readonly string[];
  readonly nextDate: { readonly label: string; readonly date: string } | null;
  readonly closed: boolean;
}

const dealsOf = (t: TeammateTurn): readonly PortalDeal[] =>
  (t.results['realestate_my_deals']?.at(-1)?.['deals'] ?? []) as PortalDeal[];

/** The customer's first name, from the context's record. */
const firstName = (t: TeammateTurn): string | null =>
  unquote(/^Name: (.+)$/m.exec(t.context)?.[1] ?? '').split(/\s+/)[0] || null;

const ADD_HOME = /\badd (.+?) to my (?:list|homes|search)\b/i;

export const REALESTATE_SCRIPTED_TEAMMATE: readonly TeammateRule[] = [
  {
    // "Can you add 412 Oak St to my list?": it finds their home search and asks their agent to add it.
    when: ADD_HOME,
    tool: 'realestate_ask_add_home',
    step: (t) => {
      if (!t.results['realestate_my_deals']) return toolCall('realestate_my_deals');
      const deal = dealsOf(t).find((d) => d.side === 'buyer' && !d.closed);
      if (!deal)
        return say(
          `${hello(t)}I don’t see a home search with us to add it to. Your agent will follow up.`,
        );
      const asked = t.results['realestate_ask_add_home']?.at(-1);
      if (!asked) {
        const address = ADD_HOME.exec(t.words)![1]!.trim();
        const who = firstName(t);
        return toolCall('realestate_ask_add_home', {
          dealId: deal.dealId,
          address,
          askSummary: `Add ${address} to ${who ? `${who}’s` : 'their'} homes`,
          messageOnceDone: `${address} is on your list now.`,
        });
      }
      return say(
        `${hello(t)}${
          asked['held']
            ? 'I’ve asked your agent to add it.'
            : 'I couldn’t ask your agent just now. They’ll follow up.'
        }`,
      );
    },
  },
  {
    // "Where are we?": the step their deal is at and its next date, as their portal shows them.
    when: /\b(?:where (?:are|do) (?:we|things) (?:stand|at)?|what(?:’|')?s next)\b/i,
    tool: 'realestate_my_deals',
    step: (t) => {
      if (!t.results['realestate_my_deals']) return toolCall('realestate_my_deals');
      const deal = dealsOf(t).find((d) => !d.closed);
      if (!deal)
        return say(`${hello(t)}I don’t see an open deal with us. Your agent will follow up.`);
      const at = deal.steps[deal.step] ?? deal.stage;
      const next = deal.nextDate ? ` Next up: ${deal.nextDate.label}, ${deal.nextDate.date}.` : '';
      return say(`${hello(t)}${deal.name} is at “${at}”.${next}`);
    },
  },
  {
    // "What's the area like?": a reply the fair housing checks hold for a person.
    when: /\bwhat(?:’|')?s the (?:area|neighborhood|neighbourhood) like\b/i,
    tool: 'realestate_my_deals',
    step: (t) => say(`${hello(t)}It’s a quiet street, and the area has good schools.`),
  },
];
