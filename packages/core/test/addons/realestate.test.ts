/**
 * Real Estate Agent's manifest and operations, held to the add-on rules (docs/addon-architecture.md). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonModuleIssues,
  allAddonAiTools,
  commands,
  manifestIssues,
  queries,
} from '../../src/server';
import { realestateAddon } from '../../src/addons/realestate/manifest';
import { realestateAddonServer } from '../../src/addons/realestate/server';

describe('Real Estate Agent', () => {
  it('has a valid manifest', () => {
    expect(manifestIssues(realestateAddon)).toEqual([]);
  });

  it('keeps only files its phone rows hold, and says which aren’t current', () => {
    const offline = realestateAddon.offline;
    const broken = {
      ...realestateAddon,
      offline: {
        ...offline,
        files: [
          { table: 'documents', column: 'file_name' },
          { table: 'documents', column: 'file_id', skip: { column: 'state', values: ['void'] } },
          { table: 'nowhere', column: 'file_id' },
        ],
      },
    };
    expect(manifestIssues(broken).map((i) => i.message)).toEqual([
      `offline files of "documents" name "file_name", which it doesn't keep`,
      `offline files of "documents" skip by "state", which it doesn't keep`,
      `offline files come from "nowhere", which isn't one of its offline tables`,
    ]);
  });

  it('joins core’s operations cleanly', () => {
    const core = {
      commands: commands.filter((c) => c.addon?.id !== 'realestate'),
      queries: queries.filter((q) => q.addon?.id !== 'realestate'),
    };
    expect(addonModuleIssues(core, [realestateAddonServer])).toEqual([]);
  });

  it('declares every event its commands emit, and only those', () => {
    const emitted = (realestateAddonServer.commands ?? [])
      .flatMap((c) => c.emits)
      .filter((e) => e.startsWith('realestate.'));
    expect([...new Set(emitted)].sort()).toEqual([...(realestateAddon.events?.emits ?? [])].sort());
  });

  it('offers the AI only what it may use', () => {
    expect(addonAiIssues([realestateAddonServer])).toEqual([]);
  });
  it('gives the Assistant what a person does, within the owner’s rule for it', () => {
    const ops = [
      ...(realestateAddonServer.queries ?? []),
      ...(realestateAddonServer.commands ?? []),
    ];
    const tools = new Map(allAddonAiTools([realestateAddonServer]).map((t) => [t.op.name, t]));
    // Only people's operations can be tools: a client's portal, the public pages and HandsFreeOS's own work never are.
    const people = ops.filter((op) => (op.actors ?? ['human']).includes('human'));
    expect(ops.filter((op) => !people.includes(op) && tools.has(op.name))).toEqual([]);
    expect(people.filter((op) => !tools.has(op.name) && !NOT_THE_ASSISTANTS.has(op.name))).toEqual(
      [],
    );
    expect(people.filter((op) => tools.has(op.name) && NOT_THE_ASSISTANTS.has(op.name))).toEqual(
      [],
    );
    expect([...NOT_THE_ASSISTANTS].filter((n) => !ops.some((op) => op.name === n))).toEqual([]);
    // It looks things up on its own and changes things only with a person's OK: the changes that run on their own are
    // the agent's own notes, drafts and records, nothing a client or the public sees and nothing on a deal's state.
    expect(
      [...tools.values()]
        .filter((t) => t.op.kind === 'command' && t.autonomy === 'auto')
        .map((t) => t.op.name)
        .sort(),
    ).toEqual([
      'realestate.client_task.add',
      'realestate.cma.add_comp',
      'realestate.cma.find_comps',
      'realestate.cma.remove_comp',
      'realestate.cma.request_summary',
      'realestate.cma.save_summary',
      'realestate.cma.set_subject',
      'realestate.cma.start',
      'realestate.cma.update_comp',
      'realestate.document.read',
      'realestate.duty.acknowledge',
      'realestate.duty.chased',
      'realestate.duty.pick_vendor',
      'realestate.field_note.add',
      'realestate.financing.update_step',
      'realestate.finding.add',
      'realestate.finding.update',
      'realestate.home.add',
      'realestate.home.lookup',
      'realestate.inspection.add',
      'realestate.listing.description.request',
      'realestate.listing.description.save',
      'realestate.listing.lookup',
      'realestate.listing.paste',
      'realestate.listing.post_save',
      'realestate.listing.posts_request',
      'realestate.memory.add',
      'realestate.memory.request',
      'realestate.offer.add_version',
      'realestate.offer.start',
      'realestate.open_house.follow_up',
      'realestate.repair.receive',
      'realestate.showing.feedback',
      'realestate.status_email.request',
      'realestate.status_email.save',
      'realestate.suggestion.not_a_fit',
      'realestate.tour.feedback',
      'realestate.tour.record_visit',
      'realestate.walkthrough.add_item',
      'realestate.walkthrough.check_item',
      'realestate.walkthrough.plan',
      'realestate.walkthrough.start',
    ]);
  });
});

/**
 * People's operations the Assistant never runs. Most are the owner's decision (2026-09-30, docs/realestate.md): it
 * never makes exceptions, waives, ends or archives a deal, sets the final commission, changes the team or edits the
 * duty list. The rest are what they are.
 */
const NOT_THE_ASSISTANTS = new Set([
  // Exceptions: done without the proof, waived, or let through without the seller's sign-off.
  'realestate.duty.complete_with_exception',
  'realestate.duty.waive',
  'realestate.listing.description.let_through',
  'realestate.listing.price.let_through',
  // Ending or archiving a deal.
  'realestate.deal.end',
  'realestate.deal.archive',
  // The final commission.
  'realestate.deal.set_final_commission',
  // The team.
  'realestate.deal.add_person',
  'realestate.deal.remove_person',
  'realestate.deal.set_role',
  // The duty list.
  'realestate.template.set_override',
  'realestate.template.clear_override',
  'realestate.template.save_custom',
  'realestate.template.archive_custom',
  'realestate.template.publish',
  'realestate.deal.apply_template_version',
  // Search everything's own part, which core runs.
  'realestate.search',
  // A visitor signing in at an open house on the host's phone: theirs, not the agent's.
  'realestate.open_house.sign_in',
  // A lockbox's code never goes through the AI.
  'realestate.lockbox.save',
]);
