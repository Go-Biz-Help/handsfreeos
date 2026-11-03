/**
 * Assistant coverage in the Admin area (support/coverage-words.ts): the counts and gaps come from the lists the checks
 * hold the Assistant to, and Copy gaps hands every one to Claude, page by page in menu order.
 */
import { describe, expect, it } from 'vitest';
import {
  ADDON_CATALOG,
  ASSISTANT_NOT_YET,
  assistantCoverage,
  coverageCards,
  coverageGapsForClaude,
  DESK_COVERAGE_WORDS,
  deskSectionsFor,
  NEVER_FOR_THE_ASSISTANT,
  ROLE_PERMISSIONS,
  SCREEN_ACTIONS,
  SETTINGS_NOT_YET,
  SETTINGS_PAGES,
} from '../src';

const c = assistantCoverage();

describe('assistant coverage', () => {
  it('counts from the lists the checks use', () => {
    expect(c.screenActions).toBe(Object.keys(SCREEN_ACTIONS).length);
    expect(c.never.map((n) => n.command)).toEqual(Object.keys(NEVER_FOR_THE_ASSISTANT));
    expect(c.notYet).toBe(ASSISTANT_NOT_YET);
    expect(c.notYetActions).toBe(ASSISTANT_NOT_YET.flatMap((p) => p.actions).length);
    expect(c.settingRowsChecked).toBeLessThan(c.settingRows);
    expect(c.settingsToCheck.map((p) => p.key)).toEqual(SETTINGS_NOT_YET);
  });

  it('names each page to check as its menu does, with its rows', () => {
    // The pages change as they're closed: each one left is named as the Settings menu or its add-on names it.
    const named = new Map<string, string>([
      ...SETTINGS_PAGES.map((p) => [p.key, p.label] as const),
      ...ADDON_CATALOG.map((m) => [m.id, m.name] as const),
      ['phone', 'The phone app'],
    ]);
    for (const p of c.settingsToCheck) {
      expect(p.label, p.key).toBe(named.get(p.key));
      expect(p.rows.length, p.key).toBeGreaterThan(0);
    }
  });

  it('shows a gap in red only while there is one', () => {
    const cards = coverageCards(c);
    expect(cards.find((k) => k.key === 'notYet')!.gap).toBe(c.notYetActions > 0);
    expect(cards.find((k) => k.key === 'settings')!.value).toBe(
      DESK_COVERAGE_WORDS.settingsChecked(c),
    );
    expect(cards.find((k) => k.key === 'screenActions')!.gap).toBe(false);
  });

  it('hands Claude every gap, in menu order, with where the steps are', () => {
    const text = coverageGapsForClaude(c);
    expect(text).toContain('Keeping the Assistant able to do everything');
    expect(text).toContain('packages/core/src/assistant/coverage.ts');
    let at = 0;
    for (const p of c.notYet) {
      const next = text.indexOf(`- ${p.page}: ${p.actions.join(', ')}.`);
      expect(next, p.page).toBeGreaterThan(at);
      at = next;
    }
    for (const p of c.settingsToCheck) {
      const next = text.indexOf(`- ${p.label} (${p.key},`);
      expect(next, p.key).toBeGreaterThan(at);
      at = next;
    }
  });

  it('says so when there are none', () => {
    const none = { ...c, notYet: [], notYetActions: 0, settingsToCheck: [] };
    expect(coverageGapsForClaude(none)).toContain('There are no gaps');
  });

  it('is in the menu for those who read Health, and not for an agent', () => {
    const keys = (p: readonly string[]) => deskSectionsFor(p).map((s) => s.key);
    expect(keys(ROLE_PERMISSIONS.staff_lead)).toContain('assistant');
    expect(keys(ROLE_PERMISSIONS.staff_admin)).toContain('assistant');
    expect(keys(ROLE_PERMISSIONS.staff_agent)).not.toContain('assistant');
  });
});
