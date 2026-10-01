/**
 * A business with Real Estate Agent on, set up the way the worker sets it up when the add-on arrives: installed and
 * enabled, with its kinds of records and relationship types from the manifest. For the add-on's database tests.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { testDbs, type TestUser } from '@hfos/db/testing';
import type { AddonManifest } from '../../src/addons/manifest';
import { realestateAddon } from '../../src/addons/realestate/manifest';
import { executeCommand, organizationCreate, type HumanActor } from '../../src/server';

const manifest: AddonManifest = realestateAddon;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

/** A new business owned by `u`, with the add-on on. Its id. */
export async function realestateBusiness(u: TestUser, name: string): Promise<string> {
  const made = await executeCommand(api(), organizationCreate, { businessName: name }, human(u), {
    correlationId: randomUUID(),
    channel: 'test',
  });
  const id = made.output.workspaceId;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${id}, 'realestate', 'enabled', ${realestateAddon.version})`,
  );
  const kinds = new Map<string, string>();
  for (const [i, k] of (manifest.recordKinds ?? []).entries()) {
    const [row] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, name_label, icon, position,
            addon_id, write_permission, kept_to_team, see_all_permission)
          values (${id}, ${k.key}, ${k.singular}, ${k.plural}, ${k.nameLabel ?? 'Name'}, ${k.icon ?? 'box'},
            ${900 + i}, 'realestate', ${k.writePermission}, ${k.keptToTeam !== undefined},
            ${k.keptToTeam?.seeAllPermission ?? null})
          returning id`,
    );
    kinds.set(k.key, row!.id);
  }
  for (const [i, t] of (manifest.relationshipTypes ?? []).entries()) {
    const end = (e: typeof t.a) =>
      e.kind === 'record'
        ? { end: 'custom_record', kind: kinds.get(e.recordKind)! }
        : { end: e.kind, kind: null };
    const a = end(t.a);
    const b = end(t.b);
    await rows(
      admin(),
      sql`insert into app.relationship_types (workspace_id, a_end, a_record_type_id, a_label, b_end,
            b_record_type_id, b_label, cardinality, position, addon_id, addon_key, portal_visible)
          values (${id}, ${a.end}::app.relationship_end, ${a.kind}, ${t.aLabel}, ${b.end}::app.relationship_end,
            ${b.kind}, ${t.bLabel}, ${t.cardinality ?? 'many_to_many'}::app.relationship_cardinality, ${900 + i},
            'realestate', ${t.key}, ${t.portal === true})`,
    );
  }
  return id;
}
