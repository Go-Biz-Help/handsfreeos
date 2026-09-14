import { describe, expect, it } from 'vitest';
import {
  aiBuilderReference,
  aiToolCallsToOps,
  applyWorkflowOps,
  blankDefinition,
  BUILDER_TOOL_NAMES,
  WORKFLOW_BUILDER_TOOLS,
  type AiToolCall,
} from '../../src/workflows/index';
import { rng } from '../calendar/random';

function depth(value: unknown): number {
  if (Array.isArray(value)) return Math.max(0, ...value.map(depth));
  if (value && typeof value === 'object')
    return 1 + Math.max(0, ...Object.values(value).map(depth));
  return 0;
}

describe('the builder’s tool schemas', () => {
  it('are flat, strict, non-recursive and at most 20', () => {
    expect(WORKFLOW_BUILDER_TOOLS.length).toBeLessThanOrEqual(20);
    expect(WORKFLOW_BUILDER_TOOLS.map((t) => t.name)).toEqual([...BUILDER_TOOL_NAMES]);
    for (const tool of WORKFLOW_BUILDER_TOOLS) {
      const schema = tool.inputSchema as {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
      const text = JSON.stringify(schema);
      expect(tool.strict).toBe(true);
      expect(text).not.toMatch(/\$ref|\$defs|definitions/);
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
      expect(depth(schema)).toBeLessThanOrEqual(5);
      for (const prop of Object.values(schema.properties) as Record<string, unknown>[]) {
        expect(prop.type === 'object').toBe(false);
        if ('anyOf' in prop) expect(prop.anyOf).toContainEqual({ type: 'null' });
      }
    }
  });

  it('come with a reference for the JSON shapes', () => {
    const ref = aiBuilderReference();
    expect(ref).toContain('send_text');
    expect(ref).toContain('lead.status');
    expect(ref).toContain('{{links.booking}}');
  });
});

describe('aiToolCallsToOps', () => {
  const call = (name: string, input: Record<string, unknown>): AiToolCall => ({ name, input });
  const add = (input: Record<string, unknown>) =>
    call('add_step', {
      ref: null,
      parentId: null,
      branchId: null,
      index: null,
      action: null,
      onError: null,
      ...input,
    });

  it('builds the tree, resolving refs, and reports bad calls as tool errors', () => {
    const start = blankDefinition();
    const out = aiToolCallsToOps(
      [
        call('set_trigger', { json: '{"kind":"event","event":"lead.created"}' }),
        add({
          ref: 'hello',
          type: 'action',
          action: 'send_text',
          json: '{"body":"Hi {{person.first_name}}"}',
        }),
        add({
          ref: 'wait',
          type: 'wait',
          json: '{"until":{"kind":"event","events":["message.received"],"timeout":{"amount":5,"unit":"minutes"}}}',
        }),
        add({
          ref: 'split',
          type: 'branch',
          json: JSON.stringify({
            mode: 'if_else',
            branches: [
              {
                ref: 'replied',
                name: 'Replied',
                condition: {
                  match: 'all',
                  conditions: [{ field: 'wait.timed_out', op: 'is_false' }],
                },
              },
              { ref: 'none', name: 'No reply', condition: null },
            ],
          }),
        }),
        add({
          ref: 'task',
          parentId: 'split',
          branchId: 'none',
          type: 'action',
          action: 'create_task',
          json: '{"title":"Call them","assignTo":{"kind":"lead_assignee"}}',
        }),
        add({
          parentId: 'split',
          branchId: 'none',
          type: 'goto',
          json: '{"target":"wait","maxVisits":2}',
        }),
        add({ type: 'action', action: 'send_text', json: '{"body":""}' }),
        call('update_step', { stepId: 'wait', json: '{"until":{"timeout":{"amount":10}}}' }),
        call('delete_step', { stepId: 'nope' }),
        add({ type: 'end', json: '{not json' }),
        add({ parentId: null, type: 'goto', json: '{"target":"hello"}' }),
        call('make_coffee', {}),
        call('finish', {
          summary: 'Texts new leads and follows up.',
          unsupported: ['Call them automatically'],
        }),
      ],
      start,
      rng(7).float,
    );

    expect(out.results.map((r) => r.ok)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
    // A later reply can't use this reply's refs, so a result names the ids it made.
    expect(out.results[1]!.message).toBe(`Done. The new step’s id is ${out.refs.hello}.`);
    expect(out.results[3]!.message).toBe(
      `Done. The new step’s id is ${out.refs.split}; its paths: “Replied” is ${out.refs.replied}, “No reply” is ${out.refs.none}.`,
    );
    expect(out.results[6]!.message).toMatch(/config\.body/);
    expect(out.results[8]!.message).toMatch(/no step “nope”/);
    expect(out.results[10]!.message).toMatch(/go-to/i);
    expect(out.finish).toEqual({
      summary: 'Texts new leads and follows up.',
      unsupported: ['Call them automatically'],
    });

    const d = out.definition;
    expect(applyWorkflowOps(start, out.ops).definition).toEqual(d);
    expect(d.trigger).toMatchObject({ kind: 'event', event: 'lead.created' });
    expect(d.steps.map((s) => s.type)).toEqual(['action', 'wait', 'branch']);
    const [, wait, split] = d.steps;
    expect(wait).toMatchObject({
      id: out.refs.wait,
      until: { timeout: { amount: 10, unit: 'minutes' } },
    });
    if (split?.type !== 'branch') throw new Error('expected a branch');
    expect(split.branches.map((b) => b.id)).toEqual([out.refs.replied, out.refs.none]);
    expect(split.branches[1]!.steps.map((s) => s.type)).toEqual(['action', 'goto']);
    expect(split.branches[1]!.steps[1]).toMatchObject({ target: out.refs.wait, maxVisits: 2 });
  });

  it('moves to the end when the index is null, and refuses a reused ref', () => {
    const start = blankDefinition();
    const out = aiToolCallsToOps(
      [
        add({ ref: 'a', type: 'end', json: '{}' }),
        add({
          ref: 'b',
          type: 'wait',
          json: '{"until":{"kind":"duration","duration":{"amount":1,"unit":"days"}}}',
          index: 0,
        }),
        call('move_step', { stepId: 'b', parentId: null, branchId: null, index: null }),
        add({ ref: 'a', type: 'end', json: '{}' }),
      ],
      start,
      rng(8).float,
    );
    expect(out.results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(out.definition.steps.map((s) => s.id)).toEqual([out.refs.a, out.refs.b]);
  });
});
