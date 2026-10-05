/**
 * A made-up add-on that connects a listing feed (round five's add-on connections): one service that takes a key or
 * HandsFreeOS's own account and sends updates, one that takes only a key, and one that signs in. For the core and
 * worker tests of connections; it isn't in the fixture catalogue, so nothing else sees it.
 */
import { defineAddon, type AddonManifest } from '../../src/addons/manifest';

export const ADDON = 'fxconn';
export const fxconn: AddonManifest = defineAddon({
  id: ADDON,
  name: 'Listing Feed Test',
  summary: 'A made-up add-on that connects a listing feed.',
  description: 'A test fixture.',
  category: 'industry',
  version: '1.0.0',
  dataVersion: 1,
  billing: { model: 'free' },
  catalog: { status: 'available', keywords: ['feed'] },
  capabilities: [
    {
      id: `${ADDON}.feed`,
      label: 'A listing feed',
      description: 'Homes from a listing feed.',
      permission: `${ADDON}.use`,
    },
  ],
  permissions: [
    {
      key: `${ADDON}.use`,
      label: 'Use it',
      description: 'Use the feed.',
      defaultRoles: ['admin', 'member'],
    },
    {
      key: `${ADDON}.manage`,
      label: 'Manage it',
      description: 'Connect the feed.',
      defaultRoles: ['admin'],
      requires: [`${ADDON}.use`],
    },
  ],
  connectors: [
    {
      key: 'listing_data',
      label: 'Listing data',
      permission: `${ADDON}.manage`,
      providers: [
        {
          id: 'acme',
          label: 'Acme Listings',
          auth: ['key', 'platform'],
          fields: [{ key: 'apiKey', label: 'API key', secret: true }],
          webhooks: true,
        },
        {
          id: 'other',
          label: 'Other Feed',
          auth: ['key'],
          fields: [{ key: 'token', label: 'Token', secret: true }],
        },
        { id: 'signin', label: 'Sign-in Feed', auth: ['oauth'] },
      ],
    },
  ],
});
