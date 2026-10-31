import { randomUUID } from 'node:crypto';
import {
  AssistantCard,
  assistantToolByName,
  executeCommand,
  executeQuery,
  organizationCreate,
  registry,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { allScreenActionTools } from '../src/assistant/tools-screen-actions';
import { createToolExecutor } from '../src/assistant/tools-write';

/**
 * Settings → Texting & calls, by asking: the calls rows change the business's number as the screen does, the
 * recording notice is the screen's own switch, and asking for RCS stays the person's, because it is paid on
 * Stripe's page. Each change waits for Confirm.
 */

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
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

type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
interface Routing {
  forwarding: { e164: string; label: string; enabled: boolean }[];
  ringSeconds: number;
  voicemailEnabled: boolean;
  voicemailGreeting: string | null;
  forwardedCallerId: 'customer' | 'business';
  announceRecording: boolean;
}

const ctx = (): ToolContext => ({
  actor: actor(owner),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});
const exec = () => createToolExecutor(api());
const tool = (name: string) =>
  assistantToolByName.get(name) ?? allScreenActionTools().find((t) => t.name === name)!;
const argsOf = (name: string, args: Record<string, unknown>) =>
  tool(name).input.parse(args) as Record<string, unknown>;
const prepare = async (name: string, args: Record<string, unknown>) => {
  const out = await exec().prepare(tool(name), argsOf(name, args), ctx(), randomUUID());
  expect(AssistantCard.safeParse(out.card).success).toBe(true);
  return out as { card: ConfirmCard };
};
const commit = (name: string, args: Record<string, unknown>) =>
  exec().commit(tool(name), argsOf(name, args), ctx(), { toolCallId: randomUUID() });
const routingNow = async () =>
  (
    (await executeQuery(
      api(),
      registry.query('phone.setup_status')!,
      { workspaceId },
      actor(owner),
      meta(),
    )) as { number: { id: string; routing: Routing } | null }
  ).number;
const field = (card: ConfirmCard, label: string) =>
  card.fields.find((f) => f.label === label)?.value;

beforeAll(async () => {
  owner = await createTestUser('atext-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: `Texting HVAC ${mark}`, timezone: CHI },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
}, 60_000);

afterAll(closeTestDbs);

describe('Settings → Texting & calls', () => {
  it('won’t say calls are set up before there is a number to ring', async () => {
    await expect(prepare('update_texting_settings', { ringSeconds: 15 })).rejects.toMatchObject({
      rule: 'no_number',
    });
  });

  it('turns the RCS sender away with where to ask for one, which is paid on Stripe’s page', async () => {
    await expect(prepare('manage_rcs', { action: 'pause' })).rejects.toThrow(
      /no RCS sender connected.*Stripe/,
    );
  });

  describe('with a number', () => {
    beforeAll(async () => {
      const [account] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
            values (${workspaceId}, 'fake', ${`ACtx${mark}`}, 'active') returning id`,
      );
      const digits = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
      await rows(
        admin(),
        sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
            values (${workspaceId}, ${account!.id}, ${`PNtx${mark}`}, ${`+1512${digits}`}, 'local', 'active')`,
      );
    });

    it('rings a phone, for as long as asked, with its greeting, only on Confirm, and keeps what nobody mentioned', async () => {
      const before = (await routingNow())!.routing;
      const args = {
        ringPhones: [{ number: '+17135550142', label: 'Priya’s cell' }],
        ringSeconds: 15,
        voicemailGreeting: 'You’ve reached Texting HVAC. Leave a message.',
        showCustomerNumber: false,
      };
      const { card } = await prepare('update_texting_settings', args);
      expect(field(card, 'Phones that ring')).toBe('Priya’s cell (713) 555-0142');
      expect(field(card, 'Rings for')).toBe('15 seconds');
      expect(field(card, 'Forwarded calls show')).toBe('Your business number');
      expect((await routingNow())!.routing.ringSeconds).toBe(before.ringSeconds);

      await commit('update_texting_settings', args);
      const after = (await routingNow())!.routing;
      expect(after.forwarding).toEqual([
        { e164: '+17135550142', label: 'Priya’s cell', enabled: true },
      ]);
      expect(after.ringSeconds).toBe(15);
      expect(after.voicemailGreeting).toBe('You’ve reached Texting HVAC. Leave a message.');
      expect(after.voicemailEnabled).toBe(before.voicemailEnabled);
      expect(after.forwardedCallerId).toBe('business');
    });

    it('turns the recording notice off with the screen’s own switch, only on Confirm', async () => {
      const notice = tool('do_phone_number_set_recording_notice');
      expect(notice.permission).toBe('channels.manage');
      const number = (await routingNow())!;
      expect(number.routing.announceRecording).toBe(true);

      const args = { phoneNumberId: number.id, announceRecording: false };
      const { card } = await prepare('do_phone_number_set_recording_notice', args);
      expect(card.type).toBe('confirm');
      expect((await routingNow())!.routing.announceRecording).toBe(true);

      await commit('do_phone_number_set_recording_notice', args);
      expect((await routingNow())!.routing.announceRecording).toBe(false);
    });
  });

  it('gives the steps for asking for RCS, with the button the page shows', async () => {
    const out = (await exec().run(tool('settings_help'), { area: 'texting' }, ctx())) as {
      result: { theyDoThemselves: { what: string; why: string; steps: string[] }[] };
    };
    const rcs = out.result.theyDoThemselves.find((h) => h.what === 'ask for RCS, and pay for it')!;
    expect(rcs.why).toContain('Stripe');
    expect(rcs.steps.join(' ')).toMatch(/Press Pay \$[\d,.]+ and send/);
    expect(JSON.stringify(out.result)).not.toContain('own Twilio account');
  });
});
