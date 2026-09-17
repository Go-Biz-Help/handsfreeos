/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { freshMinutesOf, isOnline, offlineClassOf, PHONE_COMMANDS } from '../commands';

/**
 * The commands a screen can make are the phone's contract, exactly: the same names, the same offline class, and input
 * schemas whose JSON Schema is the one the contract records. Typing the map from those schemas is what keeps a screen
 * from queueing a change the contract doesn't allow.
 */

const ROOT = resolve(__dirname, '../../../../..');
const contract = JSON.parse(
  readFileSync(join(ROOT, 'packages/core/test/contract/mobile-contract.json'), 'utf8'),
) as { commands: Record<string, { offline: unknown; input: unknown }> };

/** The contract's JSON Schema of an input: zod's input side, without the regex a format stands for. */
function inputSchema(schema: { toJSONSchema(options: object): object }): unknown {
  const { $schema: _drop, ...rest } = schema.toJSONSchema({
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  const tidy = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(tidy);
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(o)
        .filter(([k]) => !(k === 'pattern' && typeof o.format === 'string'))
        .map(([k, x]) => [k, tidy(x)]),
    );
  };
  return tidy(rest);
}

describe('the commands a phone may send', () => {
  it('are the contract’s, with the same classes', () => {
    expect(Object.keys(PHONE_COMMANDS).sort()).toEqual(Object.keys(contract.commands).sort());
    for (const [name, recorded] of Object.entries(contract.commands))
      expect({ name, offline: offlineClassOf(name) }).toEqual({ name, offline: recorded.offline });
  });

  it('take the inputs the contract records', () => {
    for (const [name, def] of Object.entries(PHONE_COMMANDS))
      expect({ name, input: JSON.parse(JSON.stringify(inputSchema(def.input as never))) }).toEqual({
        name,
        input: contract.commands[name]!.input,
      });
  });

  it('say which wait, which ask after 30 minutes, and which never queue', () => {
    expect(offlineClassOf('activity.log')).toBe('anytime');
    expect(freshMinutesOf('message.send')).toBe(30);
    expect(freshMinutesOf('activity.log')).toBeNull();
    expect(isOnline('call.connect_me')).toBe(true);
    expect(isOnline('person.create')).toBe(false);
    // A command the contract doesn't have can't be made at all.
    expect(offlineClassOf('payment.refund')).toBeNull();
  });
});
