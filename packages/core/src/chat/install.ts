/**
 * Putting the website chat on a site, and who answers it, said once: Settings → Website chat shows them, a chat's page
 * under Forms does too, and the Assistant gives the same words. Browser-safe.
 */

/** The greeting a new chat starts with, as the screen's set-up fills it in. */
export const CHAT_DEFAULT_GREETING = 'Hi, thanks for stopping by. How can we help?';

/** Where the snippet goes on each site builder Add it to your site offers, in its words. */
export const CHAT_BUILDERS = [
  {
    key: 'wordpress',
    name: 'WordPress',
    steps: [
      'In WordPress, go to Plugins, Add New, and install a header and footer plugin (like WPCode).',
      'Paste the snippet into its footer box and save.',
      'Open your site and click the chat button once. The check above turns green within a minute.',
    ],
  },
  {
    key: 'wix',
    name: 'Wix',
    steps: [
      'In your Wix dashboard, go to Settings, then Custom code.',
      'Add the snippet, choose “All pages” and “Body - end”, and apply.',
      'Publish, then open your site and click the chat button once.',
    ],
  },
  {
    key: 'squarespace',
    name: 'Squarespace',
    steps: [
      'Go to Settings, Advanced, then Code injection.',
      'Paste the snippet into the Footer box and save.',
      'Code injection needs a Squarespace business plan or higher.',
    ],
  },
  {
    key: 'gohighlevel',
    name: 'GoHighLevel',
    steps: [
      'Open Sites, then your website or funnel, and go to its Settings.',
      'Paste the snippet into “Footer tracking code” and save.',
      'Publish, then open the site and click the chat button once.',
    ],
  },
  {
    key: 'webflow',
    name: 'Webflow',
    steps: [
      'Open Site settings, then Custom code.',
      'Paste the snippet into “Footer code” and save.',
      'Publish the site, then open it and click the chat button once.',
    ],
  },
  {
    key: 'other',
    name: 'Something else',
    steps: [
      'Paste the snippet just before </body> on every page.',
      'If your site uses a template, add it to the template once.',
      'Your web person can do this in a minute. Send them this page.',
    ],
  },
] as const;

/** The AI teammate as a chat's Who answers reads it: its Website chat channel, and the one chat it may answer. */
export interface ChatTeammateChannels {
  readonly chatOn: boolean;
  /** The one chat it answers, or null for every chat that names it. */
  readonly widgetId: string | null;
}

/** The channels out of the teammate's saved config, as ai_teammate.get gives it. */
export function chatChannelsOf(config: unknown): ChatTeammateChannels {
  const channels = (config as { channels?: { chat?: unknown; widgetId?: unknown } } | null)
    ?.channels;
  return {
    chatOn: channels?.chat === true,
    widgetId: typeof channels?.widgetId === 'string' ? channels.widgetId : null,
  };
}

/** Whether the teammate's Website chat channel answers this chat: on, and for every chat or this one. */
export const teammateAnswersChat = (t: ChatTeammateChannels, widgetId: string): boolean =>
  t.chatOn && (t.widgetId === null || t.widgetId === widgetId);

/**
 * Who answers one chat now, as its Who answers and the note under it say: the AI teammate only when the chat names it,
 * it isn't off, and its Website chat channel answers this chat; otherwise the team, with why and what fixes it.
 */
export function whoAnswersChat(
  widget: { readonly id: string; readonly teammate: { readonly id: string } | null },
  teammate:
    | (ChatTeammateChannels & {
        readonly id: string;
        readonly name: string;
        readonly status: string;
      })
    | null,
): { readonly ai: boolean; readonly words: string } {
  if (!widget.teammate || !teammate || widget.teammate.id !== teammate.id)
    return { ai: false, words: 'Your team answers from the inbox.' };
  if (teammate.status === 'off')
    return {
      ai: false,
      words: `${teammate.name} is off, so your team answers for now. Turn it on from the AI teammate page.`,
    };
  if (teammate.chatOn && teammate.widgetId !== null && teammate.widgetId !== widget.id)
    return {
      ai: false,
      words: `${teammate.name} answers another of your website chats, so your team answers this one. Which chat it answers is under Channels on the AI teammate page.`,
    };
  if (!teammate.chatOn)
    return {
      ai: false,
      words: `${teammate.name}’s Website chat channel is off, so your team answers for now. Turn on Website chat under Channels on the AI teammate page.`,
    };
  return { ai: true, words: `${teammate.name} answers, and your team can join.` };
}
