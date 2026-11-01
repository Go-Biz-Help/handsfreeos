import { randomUUID } from 'node:crypto';
import {
  aiTeammateCreate,
  AssistantCard,
  assistantToolByName,
  executeCommand,
  executeQuery,
  organizationCreate,
  registry,
  type HumanActor,
} from '@hfos/core/server';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { createToolExecutor } from '../src/assistant/tools-write';

/**
 * Settings → Website chat, by asking: setting the chat box up, who answers, the daily limit, its look, the away
 * message, what it asks visitors for and the texts box, each drawn as a card that changes nothing until Confirm,
 * and refused in plain words when there is no chat box, no AI teammate, or a site the screen wouldn't take.
 */

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
const mark = randomUUID().slice(0, 8);
// A bare domain, so the www version is added beside it (a subdomain gets none).
const site = `chat-${mark}.com`;

type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
interface Widget {
  id: string;
  name: string;
  ownTextColor: string | null;
  headerColor: string | null;
  showLogo: boolean;
  whenAway: 'chat' | 'away_form';
  placement: {
    desktop: { position: 'right' | 'left'; lift: number; button: string };
    mobile: { position: 'right' | 'left'; ownPosition: boolean; lift: number; button: string };
  };
  allowedOrigins: string[];
  teammate: { id: string; name: string } | null;
  greeting: string | null;
  position: 'right' | 'left';
  awayMessage: string | null;
  askFor: { name: string; phone: string; email: string };
  smsConsent: boolean;
  dailyCap: number;
  paused: boolean;
}

const ctx = (): ToolContext => ({
  actor: actor(owner),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});
const tool = assistantToolByName.get('manage_website_chat')!;
const argsOf = (args: Record<string, unknown>) => tool.input.parse(args) as Record<string, unknown>;
const prepare = async (args: Record<string, unknown>) => {
  const out = await createToolExecutor(api()).prepare(tool, argsOf(args), ctx(), randomUUID());
  expect(AssistantCard.safeParse(out.card).success).toBe(true);
  return out as { card: ConfirmCard };
};
const commit = (args: Record<string, unknown>) =>
  createToolExecutor(api()).commit(tool, argsOf(args), ctx(), { toolCallId: randomUUID() });
const chats = async () =>
  (
    (await executeQuery(
      api(),
      registry.query('chat_widget.list')!,
      { workspaceId },
      actor(owner),
      meta(),
    )) as { items: Widget[] }
  ).items;
const chat = async () => (await chats())[0];
const field = (card: ConfirmCard, label: string) =>
  card.fields.find((f) => f.label === label)?.value;

beforeAll(async () => {
  owner = await createTestUser('achat-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: `Chat HVAC ${mark}`, timezone: CHI },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
}, 60_000);

afterAll(closeTestDbs);

describe('Settings → Website chat', () => {
  it('says there is no chat box yet, rather than failing, when asked to change one', async () => {
    await expect(prepare({ action: 'change', greeting: 'Hi!' })).rejects.toMatchObject({
      rule: 'no_chat',
    });
    await expect(prepare({ action: 'turn_off' })).rejects.toMatchObject({ rule: 'no_chat' });
  });

  it('won’t say the AI teammate answers when the business has none', async () => {
    await expect(
      prepare({ action: 'create', websites: [site], answeredByAi: true }),
    ).rejects.toMatchObject({ rule: 'no_teammate' });
  });

  it('turns away a site the screen wouldn’t take, in the screen’s words', async () => {
    await expect(prepare({ action: 'create', websites: ['*.acme.com'] })).rejects.toThrow(
      'Wildcards like *.acme.com don’t work here.',
    );
  });

  it('sets the chat box up on the site and its www twin, only on Confirm', async () => {
    const args = { action: 'create', websites: [site], greeting: 'Hi! How can we help?' };
    const { card } = await prepare(args);
    expect(field(card, 'Shows on')).toBe(`${site}, www.${site}`);
    expect(field(card, 'Who answers')).toBe('Only your team');
    expect(field(card, 'Greeting')).toBe('Hi! How can we help?');
    expect(await chat()).toBeUndefined();

    await commit(args);
    const made = (await chat())!;
    expect(made.allowedOrigins).toEqual([`https://${site}`, `https://www.${site}`]);
    expect(made.greeting).toBe('Hi! How can we help?');
    expect(made.teammate).toBeNull();
  });

  it('changes where the button sits on computers and phones, its colours, logo and name, only on Confirm', async () => {
    const args = {
      action: 'change',
      name: 'Main website',
      textColor: '#ffee00',
      topBarColor: '#191d25',
      showLogo: false,
      phonePosition: 'left',
      phoneLift: 90,
      computerButton: 'icon',
      phoneButton: 'label',
      whenNobodyAnswers: 'chat',
    };
    const { card } = await prepare(args);
    expect(field(card, 'Name')).toBe('Main website');
    expect(field(card, 'Corner on phones')).toBe('Bottom left');
    expect(field(card, 'Height on phones')).toBe('90 px higher');
    expect(field(card, 'Button on computers')).toBe('Icon only');
    expect(field(card, 'Logo')).toBe('Initials instead');
    expect(field(card, 'While nobody is answering')).toBe('They can chat anyway');
    expect((await chat())!.placement.mobile.lift).toBe(0);

    await commit(args);
    const after = (await chat())!;
    expect(after.name).toBe('Main website');
    expect(after).toMatchObject({
      ownTextColor: '#ffee00',
      headerColor: '#191d25',
      showLogo: false,
      whenAway: 'chat',
    });
    expect(after.placement).toEqual({
      desktop: { position: 'right', lift: 0, button: 'icon' },
      mobile: { position: 'left', ownPosition: true, lift: 90, button: 'label' },
    });

    // Back to automatic, and the phone's corner following the computer's again.
    await commit({ action: 'change', textColor: 'automatic', phonePosition: 'same_as_computer' });
    const back = (await chat())!;
    expect(back.ownTextColor).toBeNull();
    expect(back.placement.mobile).toMatchObject({ position: 'right', ownPosition: false });
  });

  it('adds another chat box beside the first, saying only one shows on a page', async () => {
    const { card } = await prepare({
      action: 'create',
      websites: [`es.${site}`],
      name: 'Spanish site',
    });
    expect(card.warnings.map((w) => w.text).join(' ')).toContain(
      'This adds another chat beside the one on Main website.',
    );
    await commit({ action: 'create', websites: [`es.${site}`], name: 'Spanish site' });
    const items = await chats();
    expect(items.map((w) => w.name)).toEqual(['Main website', 'Spanish site']);
    // Changing without naming one still changes the first, as Settings → Website chat shows it.
    expect((await chat())!.name).toBe('Main website');
  });

  it('changes the daily limit, position, away message, what it asks for and the texts box, keeping the rest', async () => {
    const before = (await chat())!;
    const args = {
      action: 'change',
      dailyCap: 25,
      position: 'left',
      awayMessage: 'We’re out on jobs. Leave your number and we’ll call you back.',
      askFor: { phone: 'after_first_message' },
      askForSmsConsent: false,
    };
    const { card } = await prepare(args);
    // The chat was named Main website above, so the card calls it that rather than by its site.
    expect(card.title).toBe('Change the website chat on Main website');
    expect(field(card, 'New chats a day')).toBe('25');
    expect(field(card, 'Position')).toBe('Bottom left');
    expect(field(card, 'Ask for their mobile')).toBe('After their first message');
    expect(field(card, 'Box to get texts')).toBe('Not offered');
    expect((await chat())!.dailyCap).toBe(before.dailyCap);

    await commit(args);
    const after = (await chat())!;
    expect(after).toMatchObject({
      dailyCap: 25,
      position: 'left',
      awayMessage: 'We’re out on jobs. Leave your number and we’ll call you back.',
      smsConsent: false,
      greeting: before.greeting,
      allowedOrigins: before.allowedOrigins,
    });
    expect(after.askFor).toEqual({ ...before.askFor, phone: 'after_first_message' });
  });

  it('has the AI teammate answer, saying when it is off, only on Confirm', async () => {
    await executeCommand(
      api(),
      aiTeammateCreate,
      { workspaceId, preset: 'lead_responder', name: 'Ava' },
      actor(owner),
      meta(),
    );
    const args = { action: 'change', answeredByAi: true };
    const { card } = await prepare(args);
    expect(field(card, 'Who answers')).toBe('Ava (AI)');
    expect(card.warnings.map((w) => w.text).join(' ')).toMatch(/Ava .*so your team answers/);
    expect((await chat())!.teammate).toBeNull();

    await commit(args);
    expect((await chat())!.teammate?.name).toBe('Ava');

    await commit({ action: 'change', answeredByAi: false });
    expect((await chat())!.teammate).toBeNull();
  });

  it('turns the chat box off, only on Confirm', async () => {
    const { card } = await prepare({ action: 'turn_off' });
    expect(field(card, 'Chat box')).toBe('Off');
    expect((await chat())!.paused).toBe(false);
    await commit({ action: 'turn_off' });
    expect((await chat())!.paused).toBe(true);
  });

  it('asks what to change when nothing is given', async () => {
    await expect(prepare({ action: 'change' })).rejects.toMatchObject({
      rule: 'nothing_to_change',
    });
  });
});
