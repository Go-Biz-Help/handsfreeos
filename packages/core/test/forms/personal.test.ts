import { describe, expect, it } from 'vitest';
import {
  fillFormWords,
  fillWords,
  firstNameFor,
  formProblems,
  formState,
  knownTargetsOf,
  responseProblems,
} from '../../src/forms/index';
import { def, page, qid, shortText } from './fixtures';

describe('their name in the words', () => {
  it('puts it in where the tag is', () => {
    expect(fillWords('Glad you’re here, {{person.first_name}}!', { firstName: 'Dana' })).toBe(
      'Glad you’re here, Dana!',
    );
    expect(fillWords('Hi {{ person.first_name }}', { firstName: 'Dana' })).toBe('Hi Dana');
  });

  it('uses the default when we don’t know it', () => {
    expect(
      fillWords('Hi {{person.first_name | default:"there"}}, welcome', { firstName: null }),
    ).toBe('Hi there, welcome');
    expect(fillWords('Hi {{person.first_name | default:"there"}}', { firstName: 'Kai' })).toBe(
      'Hi Kai',
    );
  });

  it('reads naturally without a name or a default', () => {
    expect(fillWords('Glad you’re here, {{person.first_name}}!', { firstName: null })).toBe(
      'Glad you’re here!',
    );
    expect(fillWords('Hi {{person.first_name}}, welcome', { firstName: '' })).toBe('Hi, welcome');
    expect(fillWords('{{person.first_name}}, welcome', { firstName: null })).toBe('welcome');
    expect(fillWords('Nothing to fill', { firstName: 'Dana' })).toBe('Nothing to fill');
  });

  it('takes the name they typed before the one on file, first word only', () => {
    const definition = def({
      pages: [page('about', [shortText('name', { mapTo: 'person.first_name' })])],
    });
    expect(firstNameFor(definition, { [qid('name')]: 'Dana Ruiz' }, 'Danielle')).toBe('Dana');
    expect(firstNameFor(definition, {}, 'Danielle')).toBe('Danielle');
    expect(firstNameFor(definition, {}, null)).toBeNull();
  });

  it('fills every place a form has words, and leaves the definition alone', () => {
    const definition = def({
      title: 'Welcome {{person.first_name}}',
      pages: [
        page('about', [
          shortText('goal', { title: '{{person.first_name}}, what’s your goal?' }),
          {
            id: qid('note'),
            type: 'content',
            title: 'Note',
            config: { body: 'Hi {{person.first_name}}' },
          },
        ] as never),
      ],
    });
    const filled = fillFormWords(definition, { firstName: 'Dana' });
    expect(filled.title).toBe('Welcome Dana');
    expect(filled.pages[0]!.questions[0]!.title).toBe('Dana, what’s your goal?');
    expect((filled.pages[0]!.questions[1]!.config as { body: string }).body).toBe('Hi Dana');
    expect(definition.title).toBe('Welcome {{person.first_name}}');
  });
});

describe('what a personal link already knows', () => {
  const funnel = () =>
    def({
      settings: { onePageAtATime: true },
      pages: [
        page('name', [shortText('name', { required: true, mapTo: 'person.first_name' })]),
        page(
          'reach',
          [
            {
              id: qid('phone'),
              type: 'phone',
              title: 'Your phone',
              required: true,
              mapTo: 'person.phone',
              config: {},
            },
            shortText('city', { mapTo: 'person.city' }),
          ] as never,
          { savesContact: true },
        ),
      ],
    });

  it('knows the contact details on file, and only those', () => {
    expect([
      ...knownTargetsOf({ firstName: 'Dana', lastName: '', email: null, phone: '+15125550100' }),
    ]).toEqual(['person.first_name', 'person.phone']);
  });

  it('skips what we know, and a page left empty goes too', () => {
    const known = new Set(['person.first_name', 'person.phone']);
    const state = formState(funnel(), { [qid('name')]: 'Someone Else' }, { known });
    expect(state.pages.map((p) => p.page.id)).toEqual([funnel().pages[1]!.id]);
    expect(state.questions.map((q) => q.id)).toEqual([qid('city')]);
    // An answer to a skipped question is dropped, and a skipped required question isn't required.
    expect(state.answers).toEqual({});
    expect(responseProblems(funnel(), {}, { known })).toEqual([]);
  });

  it('asks everything when nothing is known', () => {
    expect(formState(funnel(), {}).questions).toHaveLength(3);
  });
});

describe('the page that saves their details', () => {
  it('needs a way to reach them, and there’s only one', () => {
    const asks = (questions: never[], extra: Record<string, unknown> = {}) =>
      formProblems(
        def({
          pages: [
            page('one', questions, { savesContact: true }),
            page('two', [shortText('more')], extra),
          ],
        }),
      );
    expect(asks([shortText('name') as never]).join(' ')).toContain(
      'needs a phone or an email question',
    );
    expect(
      asks([{ id: qid('email'), type: 'email', title: 'Email', config: {} } as never]),
    ).toEqual([]);
    expect(
      asks([{ id: qid('email'), type: 'email', title: 'Email', config: {} } as never], {
        savesContact: true,
      }).join(' '),
    ).toContain('Only one page can save their details.');
  });
});
