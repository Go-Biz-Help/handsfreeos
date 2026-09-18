import type { ScriptRule } from '@hfos/ai';

/**
 * The scripted Assistant's setting-up phrases (M12, step six): "how do I create a calendar", the answer to it,
 * "what are my quiet hours", and "how do I connect Stripe" — the three shapes the milestone is about. One reads,
 * one proposes a change that waits for an OK, one hands back steps only the person can take.
 *
 * As with the other families, the rule decides which tool to call; everything a person reads about their own
 * setup comes back from the real query, so nothing here can invent a setting that isn't there.
 */

const parse = (json: string | undefined): Record<string, unknown> => {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** The teammate whose question it is, so a new calendar has somebody on it. */
const meIn = (context: string) => /\(user id ([0-9a-f-]{36})\)/.exec(context)?.[1] ?? undefined;

export const settingsRules: ScriptRule[] = [
  {
    // "Create a calendar called X" / "Set up a calendar called X for me"
    when: /\b(create|set up|add) (?:a )?calendar (?:called|named) ["“]?([^"”?.]+)["”]?/i,
    calls: (q, context) => {
      const name = /(?:called|named) ["“]?([^"”?.]+)["”]?/i.exec(q)?.[1]?.trim() ?? 'New calendar';
      const me = meIn(context);
      return [
        {
          name: 'manage_calendar',
          arguments: { action: 'create', name, ...(me ? { teammates: [me] } : {}) },
        },
      ];
    },
    reply: (q) => {
      const name = /(?:called|named) ["“]?([^"”?.]+)["”]?/i.exec(q)?.[1]?.trim() ?? 'the calendar';
      return `Here's ${name}, ready for your OK. Nothing is set up until you press Confirm.`;
    },
  },
  {
    // "How do I create a calendar?" — the question that started the milestone.
    when: /\b(how do i (create|set up|add) a calendar|create a calendar|set up a calendar|add a calendar)\b/i,
    calls: () => [{ name: 'get_settings', arguments: { area: 'calendars' } }],
    reply: () => 'I can set one up for you here. What should it be called, and who works it?',
  },
  {
    // "What are my quiet hours?" — reading the setup rather than changing it.
    when: /\b(what are my quiet hours|when are quiet hours|quiet hours)\b/i,
    calls: () => [{ name: 'get_settings', arguments: { area: 'texting' } }],
    reply: (_q, r) => {
      const out = parse(r['get_settings']);
      const texting = out['texting'] as { settings?: { quietHours?: Record<string, unknown> } };
      const quiet = texting?.settings?.quietHours;
      if (!quiet) return 'Texting isn’t set up yet, so there are no quiet hours.';
      return quiet['enabled']
        ? `Quiet hours run from ${String(quiet['start'])} to ${String(quiet['end'])}. Nothing goes out to customers in between.`
        : 'Quiet hours are off, so texts can go out at any hour.';
    },
  },
  {
    // "How do I connect Stripe?" — the part only they can do.
    when: /\b(connect (stripe|square)|how do i get paid|take card payments)\b/i,
    calls: () => [{ name: 'settings_help', arguments: { area: 'payments' } }],
    reply: () =>
      'That one is yours to do — you sign in to them yourself. The steps are on the card, and I can set up everything else about how you get paid.',
  },
];
