import { eq } from 'drizzle-orm';
import { brandedDomains } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import {
  BrandedDomainGetInput,
  BrandedDomainGetOutput,
  ownershipHost,
} from '../schemas/branded-domain';

/** A record the business still has to put in its DNS, in the order it should do them. */
const RECORDS = {
  ownership: 'Proves the domain is your business’s, not just pointed at HandsFreeOS.',
  verification: 'Proves the domain is yours before a certificate is issued for it.',
  cname: 'Points the domain at HandsFreeOS. This is what makes it work.',
} as const;

export const brandedDomainGet = defineQuery({
  name: 'branded_domain.get',
  description:
    'The business’s own domain, what is still needed in DNS for it, and whether it is serving yet.',
  input: BrandedDomainGetInput,
  output: BrandedDomainGetOutput,
  // Everybody reads it — the booking page shows the address it is on — and only `channels.manage` changes
  // it, which is the commands' business rather than this one's.
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select()
      .from(brandedDomains)
      .where(eq(brandedDomains.workspaceId, input.workspaceId));
    if (!row) return { domain: null };
    const serving = row.status === 'verified' && row.certificateReady;
    return {
      domain: {
        id: row.id,
        domain: row.domain,
        status: row.status,
        // Nothing is left to do once it is serving, and a record whose value the host has not sent yet is
        // not something to show half of.
        records: serving
          ? []
          : [
              ...(row.ownershipProvedAt
                ? []
                : [
                    {
                      kind: 'TXT' as const,
                      host: ownershipHost(row.domain),
                      value: row.ownershipToken,
                      why: RECORDS.ownership,
                    },
                  ]),
              ...(row.verificationHost && row.verificationValue
                ? [
                    {
                      kind: 'TXT' as const,
                      host: row.verificationHost,
                      value: row.verificationValue,
                      why: RECORDS.verification,
                    },
                  ]
                : []),
              ...(row.cnameHost && row.cnameValue
                ? [
                    {
                      kind: 'CNAME' as const,
                      host: row.cnameHost,
                      value: row.cnameValue,
                      why: RECORDS.cname,
                    },
                  ]
                : []),
            ],
        certificateReady: row.certificateReady,
        lastError: row.lastError,
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
        lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      },
    };
  },
});
