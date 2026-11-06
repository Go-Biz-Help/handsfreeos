/**
 * What the Assistant reads of Social Outreach (its operations' `ai.answer` and `ai.outcome`, ai-answers.ts): each
 * chat's link written out as Open in Messenger opens it, the short facts ahead of a long list, where to get the
 * extension and how to install it, the words a confirmed change ends with as the screens' toasts say them, and the
 * same-name check before anyone goes in Contacts. Then the saves that change only what they're given (loose.ts): a
 * part left out stays left out, never a default.
 */
import { describe, expect, it } from 'vitest';
import {
  cancelAllOutcome,
  chatLinksAnswer,
  clientOutcome,
  contactOutcome,
  EXTENSION_DOWNLOAD_PATH,
  listsLast,
  retryOutcome,
  SAME_NAME_FIRST,
  setupAnswer,
  todayAnswer,
  withChatLinks,
} from '../../src/addons/outreach/ai-answers';
import { AutomationChanges, AutomationSaveInput } from '../../src/addons/outreach/automation';
import { givenOnly, loosened } from '../../src/addons/outreach/loose';
import { chatUrlOn, tidyWordsOn } from '../../src/addons/outreach/network-words';
import { profileContact } from '../../src/addons/outreach/ops/asks';
import { chatsList } from '../../src/addons/outreach/ops/chats';
import { clientSet } from '../../src/addons/outreach/ops/person-menu';
import { chatKeep } from '../../src/addons/outreach/ops/saves';
import { setupGet } from '../../src/addons/outreach/ops/setup';
import { friendsCancelAll } from '../../src/addons/outreach/ops/tidy';
import { needRetry } from '../../src/addons/outreach/ops/waiting';
import { PlaybookChanges, PlaybookSaveInput } from '../../src/addons/outreach/playbooks';
import { CHROME_EXTENSIONS_URL } from '../../src/addons/outreach/setup';
import { retriedWords } from '../../src/addons/outreach/waiting-words';
import { z } from 'zod';

const WS = '0b4f6a52-3b0e-4f8e-9d4b-1a2b3c4d5e6f';
const PERSON = '7c1f6a52-3b0e-4f8e-9d4b-1a2b3c4d5e6f';

describe('a chat’s link', () => {
  it('is written out beside its id, on the row’s own network, the one asked about, or its profile’s', () => {
    const got = withChatLinks({
      items: [
        { name: 'Ann', threadKey: '1001', platform: 'linkedin' },
        { name: 'Bo', threadKey: '1002', profileUrl: 'https://www.linkedin.com/in/bo' },
        { name: 'Cy', threadKey: '1003' },
        { name: 'Di', threadKey: null },
      ],
    }) as { items: Record<string, unknown>[] };
    expect(got.items[0]!['chatUrl']).toBe(chatUrlOn('linkedin', '1001'));
    expect(got.items[1]!['chatUrl']).toBe(chatUrlOn('linkedin', '1002'));
    expect(got.items[2]!['chatUrl']).toBe(chatUrlOn('facebook', '1003'));
    expect(got.items[3]).not.toHaveProperty('chatUrl');
    // The network asked about, when the row doesn't say.
    const asked = chatLinksAnswer({ chats: [{ threadKey: '9' }] }, { platform: 'instagram' }) as {
      chats: Record<string, unknown>[];
    };
    expect(asked.chats[0]!['chatUrl']).toBe(chatUrlOn('instagram', '9'));
  });

  it('comes on Today’s list after its short facts, never ahead of them', () => {
    const today = todayAnswer(
      { items: [{ threadKey: '5', name: 'Ann' }], goal: 10, requestsHeld: 'Not today' },
      {},
    ) as Record<string, unknown>;
    expect(Object.keys(today)).toEqual(['goal', 'requestsHeld', 'items']);
    expect((today['items'] as Record<string, unknown>[])[0]!['chatUrl']).toBe(
      chatUrlOn('facebook', '5'),
    );
    expect(listsLast('words')).toBe('words');
  });
});

describe('the extension, from Set up', () => {
  it('says where to get it, the business’s own link first, and the steps to install, update and get unstuck', () => {
    const ours = setupAnswer({ extensionLink: null, done: 3 }) as {
      done: number;
      download: { link: string; steps: string[]; update: unknown; stuck: string[]; note: string };
    };
    expect(ours.done).toBe(3);
    expect(ours.download.link).toBe(EXTENSION_DOWNLOAD_PATH);
    expect(ours.download.steps.join(' ')).toContain(CHROME_EXTENSIONS_URL);
    expect(ours.download.stuck.length).toBeGreaterThan(0);
    expect(ours.download.note).toMatch(/person’s own/);
    const own = setupAnswer({ extensionLink: 'https://files.acme.com/ext.zip' }) as {
      download: { link: string };
    };
    expect(own.download.link).toBe('https://files.acme.com/ext.zip');
    expect(setupGet.ai?.answer).toBe(setupAnswer);
  });
});

describe('a confirmed change’s last words', () => {
  it('say who went in Contacts, and open them there', () => {
    const added = { personId: PERSON, personName: 'Ann Lee', profileId: PERSON, addedPerson: true };
    expect(contactOutcome(added, { personId: null })).toEqual({
      words: 'Ann Lee is in Contacts now.',
      path: `customers/people/${PERSON}`,
    });
    expect(contactOutcome({ ...added, addedPerson: false }, {})?.words).toBe(
      'Ann Lee was in Contacts already.',
    );
    expect(contactOutcome(added, { personId: PERSON })?.words).toBe(
      'Ann Lee is tied to them in Contacts now.',
    );
    expect(profileContact.ai?.outcome).toBe(contactOutcome);
  });

  it('say what Mark as client did, and why Contacts may still count them one', () => {
    const out = {
      profileId: PERSON,
      personId: PERSON,
      client: true,
      tagged: true,
      because: null,
      addedPerson: true,
      skipped: 2,
    };
    const marked = clientOutcome(out, { client: true });
    expect(marked?.words).toContain('Needs you');
    expect(marked?.words).toContain('They were added to Contacts.');
    expect(marked?.words).toContain('2 messages to them waiting for an OK were skipped.');
    expect(marked?.path).toBe(`customers/people/${PERSON}`);
    expect(clientOutcome({ ...out, client: false }, { client: false })?.words).toMatch(
      /^Not a client any more/,
    );
    expect(clientOutcome({ ...out, because: 'paid' }, { client: false })?.words).toBe(
      'The Client tag is off, but Contacts still counts them a client: they paid a bill. To change that, open them in Contacts.',
    );
    expect(clientSet.ai?.outcome).toBe(clientOutcome);
  });

  it('say how many steps go again, and how many Cancel all is cancelling', () => {
    const retried = [{ needId: PERSON, at: '2026-11-06T10:00:00.000Z' }];
    expect(retryOutcome({ retried, passed: 1 })).toEqual({
      words: retriedWords(1, 1),
      path: 'a/outreach/needs-you',
    });
    expect(needRetry.ai?.outcome?.({ retried, passed: 0 }, {})?.words).toBe(retriedWords(1, 0));

    const all = tidyWordsOn('facebook').all!;
    expect(cancelAllOutcome({ marked: 3, leftOut: 0, first: [] }, { on: true })?.words).toBe(
      all.started(3),
    );
    expect(cancelAllOutcome({ marked: 0, leftOut: 0, first: [] }, { on: false })?.words).toBe(
      all.stopped,
    );
    // Instagram's follows wait for nobody: no Cancel all, so its card keeps the plain words.
    expect(cancelAllOutcome({ marked: 0, leftOut: 0, first: [] }, { platform: 'instagram' })).toBe(
      null,
    );
    expect(friendsCancelAll.ai?.outcome).toBe(cancelAllOutcome);
    expect(friendsCancelAll.ai?.description).toContain('outreach_ask_computer');
  });

  it('look in Contacts for the same name before anyone is added there', () => {
    for (const op of [profileContact, clientSet, chatKeep])
      expect(op.ai?.description, op.name).toContain(SAME_NAME_FIRST);
    expect(SAME_NAME_FIRST).toContain('search_customers');
    expect(chatsList.ai?.answer).toBe(chatLinksAnswer);
  });
});

describe('a save of only what changes', () => {
  it('keeps out what wasn’t given, never putting a default in its place', () => {
    const o = z.object({ a: z.number().default(1), b: z.string() });
    expect(loosened(o).parse({})).toEqual({});
    expect(loosened(o).parse({ a: 2 })).toEqual({ a: 2 });
    expect(givenOnly({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(givenOnly(undefined)).toEqual({});
  });

  it('takes the extension’s choices whole from the screens, or only what changes from the Assistant', () => {
    expect(AutomationChanges.parse({ sending: 'everything' })).toEqual({ sending: 'everything' });
    expect(AutomationChanges.parse({ networks: { linkedin: { on: true } } })).toEqual({
      networks: { linkedin: { on: true } },
    });
    expect(AutomationSaveInput.safeParse({ workspaceId: WS }).success).toBe(false);
    expect(
      AutomationSaveInput.safeParse({ workspaceId: WS, changes: { warmUp: false } }).success,
    ).toBe(true);
  });

  it('changes a playbook part by part, or starts one from a ready-made one', () => {
    expect(PlaybookChanges.parse({})).toEqual({});
    const name = 'Roofers';
    expect(PlaybookSaveInput.safeParse({ workspaceId: WS, name }).success).toBe(false);
    expect(
      PlaybookSaveInput.safeParse({ workspaceId: WS, playbookId: PERSON, name, changes: {} })
        .success,
    ).toBe(true);
    expect(
      PlaybookSaveInput.safeParse({ workspaceId: WS, name, template: 'crm_demos' }).success,
    ).toBe(true);
    // An existing playbook isn't started again from a template: it says what changes.
    expect(
      PlaybookSaveInput.safeParse({
        workspaceId: WS,
        playbookId: PERSON,
        name,
        template: 'crm_demos',
      }).success,
    ).toBe(false);
  });
});
