/**
 * The kinds of business picked at sign-up and in Settings → Workspace: one list, searchable by the words people use.
 * Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  findIndustry,
  INDUSTRIES,
  INDUSTRY_GROUP_NAMES,
  industryFromText,
  industryLabel,
  isHomeServices,
  searchIndustries,
} from '../src/industries';
import { suggestedQuestions } from '../src/ai-team/presets';
import { industry } from '../src/schemas/common';

const ids = (query: string) => searchIndustries(query).map((i) => i.id);

describe('the list', () => {
  it('keeps the two ids workspaces already carry, with Other last', () => {
    expect(findIndustry('home_services')?.group).toBe('Home services & trades');
    expect(INDUSTRIES.at(-1)?.id).toBe('other');
  });

  it('has each id once, in a group the picker knows, in the groups’ order', () => {
    const seen = INDUSTRIES.map((i) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
    for (const i of INDUSTRIES) expect(i.id).toMatch(/^[a-z][a-z_]{1,39}$/);
    const order = INDUSTRIES.map((i) => INDUSTRY_GROUP_NAMES.indexOf(i.group));
    expect(order.every((g) => g >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(INDUSTRIES.length).toBeGreaterThan(80);
  });

  it('is what the schema accepts, and says what to do otherwise', () => {
    expect(industry.parse('plumbing')).toBe('plumbing');
    expect(industry.parse('home_services')).toBe('home_services');
    const bad = industry.safeParse('Plumbing');
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe(
      'Pick the kind of business from the list, or Other.',
    );
  });

  it('names an id, and shows one it doesn’t know as it is', () => {
    expect(industryLabel('hvac')).toBe('HVAC');
    expect(industryLabel('pet_grooming')).toBe('Pet grooming');
    expect(industryLabel('retired_id')).toBe('retired_id');
    expect(industryLabel(null)).toBe('');
  });
});

describe('searchIndustries', () => {
  it('is the whole list when nothing is typed', () => {
    expect(searchIndustries('  ')).toHaveLength(INDUSTRIES.length);
  });

  it('finds a kind by its name, first', () => {
    expect(ids('plumb')[0]).toBe('plumbing');
    expect(ids('Roof')[0]).toBe('roofing');
    expect(ids('dog')).toEqual(
      expect.arrayContaining(['dog_training', 'pet_grooming', 'pet_sitting', 'pet_boarding']),
    );
    expect(ids('dog')[0]).toBe('dog_training');
  });

  it('finds a kind by the words people use for it', () => {
    expect(ids('plumber')[0]).toBe('plumbing');
    expect(ids('realtor')[0]).toBe('real_estate');
    expect(ids('ac repair')[0]).toBe('hvac');
    expect(ids('maid')[0]).toBe('house_cleaning');
    expect(ids('lawyer')[0]).toBe('law_firm');
    expect(ids('Café')).toContain('restaurant');
    expect(ids('pest & termites')[0]).toBe('pest_control');
  });

  it('needs every word to match, and never offers Other as a match', () => {
    expect(ids('dog taxes')).toEqual([]);
    expect(ids('zzz')).toEqual([]);
    expect(ids('other')).not.toContain('other');
  });
});

describe('industryFromText', () => {
  it('reads an id, a name or another word for it', () => {
    expect(industryFromText('hvac')?.id).toBe('hvac');
    expect(industryFromText('Pet grooming')?.id).toBe('pet_grooming');
    expect(industryFromText('electrician')?.id).toBe('electrical');
    expect(industryFromText('dog walker')?.id).toBe('pet_sitting');
    expect(industryFromText('qwerty')).toBeUndefined();
  });
});

describe('what a kind of business changes', () => {
  it('asks a home-services trade about the job and the home, a salon about the visit, and anyone else general questions', () => {
    expect(isHomeServices('home_services')).toBe(true);
    expect(isHomeServices('plumbing')).toBe(true);
    expect(isHomeServices('dental')).toBe(false);
    expect(isHomeServices(null)).toBe(false);
    expect(suggestedQuestions('roofing').map((q) => q.id)).toEqual([
      'need',
      'timeline',
      'owner',
      'zip',
    ]);
    expect(suggestedQuestions('hair_salon').map((q) => q.id)).toEqual([
      'service',
      'when',
      'first_visit',
      'who',
    ]);
    expect(suggestedQuestions('food_truck')).toEqual(suggestedQuestions('other'));
  });
});
