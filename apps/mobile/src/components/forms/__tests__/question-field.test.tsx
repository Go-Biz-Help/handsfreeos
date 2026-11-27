import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';
import { Linking } from 'react-native';

import { QuestionField } from '@/components/forms/question-field';

/**
 * Pictures on a form, on the phone (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 2): a picture shows at its
 * share of the width, lined up as picked, says what it shows to VoiceOver, and opens its web page when pressed; a
 * choice shows its picture beside its words; and words are lined up as the web lines them up.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const PATH = `${WS}/${ID}.webp`;

const base = {
  id: 'q1',
  title: 'Our crew at a job',
  help: 'Here since 2009',
  required: false,
  width: 'full',
  mapTo: null,
  showIf: { mode: 'all', conditions: [] },
} as const;

describe('a picture on a form', () => {
  it('shows the library’s copy, says what it shows, and its caption', async () => {
    await render(
      <QuestionField
        question={
          {
            ...base,
            type: 'picture',
            config: {
              picture: { path: PATH, width: 1200, height: 800 },
              size: 'medium',
              align: 'right',
              link: '',
            },
          } as never
        }
        value={null}
        onChange={() => undefined}
        problem={null}
      />,
    );
    const picture = screen.getByTestId('picture-q1');
    expect(picture.props.source.uri).toMatch(
      new RegExp(`/storage/v1/object/public/pictures/${PATH}$`),
    );
    expect(picture.props.accessibilityLabel).toBe('Our crew at a job');
    expect(screen.getByText('Here since 2009')).toBeTruthy();
  });

  it('opens its web page when pressed', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(
      <QuestionField
        question={
          {
            ...base,
            type: 'picture',
            config: {
              picture: { path: PATH, width: 10, height: 10 },
              size: 'full',
              align: 'center',
              link: 'https://example.com/work',
            },
          } as never
        }
        value={null}
        onChange={() => undefined}
        problem={null}
      />,
    );
    fireEvent.press(screen.getByRole('link'));
    expect(open).toHaveBeenCalledWith('https://example.com/work');
  });

  it('shows a choice’s picture beside its words', async () => {
    await render(
      <QuestionField
        question={
          {
            ...base,
            type: 'choice',
            config: {
              choices: [
                { id: 'c1', label: 'Shingle', picture: { path: PATH, width: 4, height: 3 } },
                { id: 'c2', label: 'Metal', picture: null },
              ],
            },
          } as never
        }
        value={null}
        onChange={() => undefined}
        problem={null}
      />,
    );
    expect(screen.getByTestId('choice-picture-q1-c1')).toBeTruthy();
    expect(screen.queryByTestId('choice-picture-q1-c2')).toBeNull();
  });

  it('lines up words in the middle when asked', async () => {
    await render(
      <QuestionField
        question={
          {
            ...base,
            title: '',
            help: '',
            type: 'content',
            config: { body: 'Hello', align: 'center' },
          } as never
        }
        value={null}
        onChange={() => undefined}
        problem={null}
      />,
    );
    expect(screen.getByText('Hello').props.className).toContain('text-center');
  });
});
