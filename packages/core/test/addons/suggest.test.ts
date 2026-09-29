/**
 * The one add-on Home may suggest, unasked (the owner's decision, 2026-09-28: occasionally, a small card for owners
 * and admins when an available add-on fits what the business does, easy to dismiss). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  profileText,
  SUGGESTION_QUIET_DAYS,
  suggestAddon,
  type CapabilityContext,
  type SuggestionDismissal,
  type SuggestionProfile,
} from '../../src/index';
import { FIXTURE_CATALOG } from './fixtures';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY);

const as = (
  permissions: readonly string[],
  installations: CapabilityContext['installations'] = {},
): CapabilityContext => ({ catalog: FIXTURE_CATALOG, installations, overrides: {}, permissions });
const manager = (installations: CapabilityContext['installations'] = {}) =>
  as(['workspace.read', 'addons.manage'], installations);

const business = (name: string, recordKinds: string[] = []): SuggestionProfile => ({
  name,
  industry: 'home_services',
  recordKinds,
});
const harbor = business('Harbor Property Rentals');

describe('suggestAddon', () => {
  it('suggests the add-on that fits what the business is, with what it would let them do', () => {
    expect(suggestAddon(manager(), harbor, [], NOW)).toEqual({
      addonId: 'fxprop',
      name: 'Property Management',
      summary: 'Properties, units, tenants and leases.',
      does: ['Properties and units', 'Leases'],
    });
  });

  it('reads the kinds of records the business made for itself', () => {
    const plain = business('Smith & Sons');
    expect(suggestAddon(manager(), plain, [], NOW)).toBeNull();
    expect(
      suggestAddon(manager(), business('Smith & Sons', ['Tenant', 'Tenants', 'Lease']), [], NOW)
        ?.addonId,
    ).toBe('fxprop');
  });

  it('suggests nothing when nothing fits, rather than something', () => {
    expect(suggestAddon(manager(), business('Paws Grooming', ['Pet', 'Pets']), [], NOW)).toBeNull();
  });

  it('is only ever for people who may add add-ons', () => {
    expect(suggestAddon(as(['workspace.read']), harbor, [], NOW)).toBeNull();
    expect(suggestAddon(as([]), harbor, [], NOW)).toBeNull();
  });

  it('never suggests what the business already has, or what can’t be installed here', () => {
    expect(suggestAddon(manager({ fxprop: 'enabled' }), harbor, [], NOW)).toBeNull();
    expect(suggestAddon(manager({ fxprop: 'disabled' }), harbor, [], NOW)).toBeNull();
    // Planned, beta, paid: never, however well they fit.
    for (const name of [
      'Influencer Promote Marketplace',
      'Loyalty Points Rewards',
      'Payroll Wages Paycheck',
    ])
      expect(suggestAddon(manager(), business(name), [], NOW), name).toBeNull();
  });

  it('rests after a card is set aside, then comes back; never again for one they aren’t interested in', () => {
    const notNow: SuggestionDismissal = { addonId: 'fxprop', choice: 'not_now', decidedAt: ago(5) };
    expect(suggestAddon(manager(), harbor, [notNow], NOW)).toBeNull();
    const later = { ...notNow, decidedAt: ago(SUGGESTION_QUIET_DAYS + 1) };
    expect(suggestAddon(manager(), harbor, [later], NOW)?.addonId).toBe('fxprop');
    const refused: SuggestionDismissal = {
      addonId: 'fxprop',
      choice: 'not_interested',
      decidedAt: ago(SUGGESTION_QUIET_DAYS * 4),
    };
    expect(suggestAddon(manager(), harbor, [refused], NOW)).toBeNull();
    // Setting aside any card quiets them all for a while, not only that add-on.
    const otherCard: SuggestionDismissal = {
      addonId: 'fxseo',
      choice: 'not_now',
      decidedAt: ago(2),
    };
    expect(suggestAddon(manager(), harbor, [otherCard], NOW)).toBeNull();
  });

  it('describes a business in its own words', () => {
    expect(profileText(business('Harbor Rentals', ['Unit', 'Units']))).toBe(
      'Harbor Rentals General home services Unit Units',
    );
    expect(profileText({ name: 'Harbor', industry: 'property_management', recordKinds: [] })).toBe(
      'Harbor Property management',
    );
    // "Other" says nothing about the business, so it isn't matched on.
    expect(profileText({ name: 'Harbor', industry: 'other', recordKinds: [] })).toBe('Harbor');
  });

  it('hears the line of work picked at sign-up', () => {
    const rentals = { name: 'Harbor', industry: 'property_management', recordKinds: [] };
    expect(suggestAddon(manager(), rentals, [], NOW)?.addonId).toBe('fxprop');
  });
});
