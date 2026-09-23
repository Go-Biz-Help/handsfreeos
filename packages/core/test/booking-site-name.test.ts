/**
 * Two businesses with the same name both publish a form: each gets its own public name. The second can't see the
 * first's booking site (row security shows only its own), so the name it wants looks free until the insert says
 * otherwise, and then it takes the next number instead of failing the publish.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser } from '@hfos/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { formCreate, formPublish, organizationCreate } from '../src/server';
import { admin, run } from './calendar-helpers';

afterAll(closeTestDbs);

describe('a business’s public name', () => {
  it('numbers the second business with the same name instead of failing', async () => {
    const businessName = `Same Name ${randomUUID().slice(0, 8)} HVAC`;
    const slugs: string[] = [];
    for (const label of ['a', 'b']) {
      const owner = await createTestUser(`site-name-${label}`);
      const { workspaceId } = await run(organizationCreate, { businessName }, owner);
      const made = await run(
        formCreate,
        { workspaceId, name: 'Quote request', starter: 'quote' },
        owner,
      );
      await run(
        formPublish,
        { workspaceId, formId: made.formId, baseRevision: made.revision },
        owner,
      );
      const [site] = await rows<{ slug: string }>(
        admin(),
        sql`select slug from app.booking_sites where workspace_id = ${workspaceId}`,
      );
      slugs.push(site!.slug);
    }
    expect(slugs[1]).toBe(`${slugs[0]}-2`);
  });
});
