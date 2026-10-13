import type { TouchedPostsOutput } from '@hfos/core/addons/outreach/activity';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';
import { Linking } from 'react-native';

import { TouchedPostsList } from '../posted';

/**
 * Results' posts liked and commented on, on the phone (docs/outreach.md): each with whose it was and what it said, the
 * extension's own comment and why it liked a post, the person's own comment without its words, a tap to the post, and
 * Show more while there are more.
 */

type Posted = TouchedPostsOutput['posts'][number];
const post = (more: Partial<Posted>): Posted => ({
  touchId: '7b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
  kind: 'like',
  at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  profileId: '8b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
  personId: null,
  name: 'Jo Hill',
  profileUrl: 'https://www.facebook.com/jo.hill.5',
  postUrl: 'https://www.facebook.com/jo.hill.5/posts/1',
  postText: 'Finally got the new roof on the shop!',
  commentText: null,
  why: 'A new roof on their shop',
  auto: true,
  group: null,
  by: null,
  ...more,
});

const list = (props: Partial<React.ComponentProps<typeof TouchedPostsList>>) =>
  render(
    <TouchedPostsList
      period="week"
      kind="all"
      onKind={jest.fn()}
      posts={[]}
      next={null}
      error={null}
      loading={false}
      onMore={jest.fn()}
      onRetry={jest.fn()}
      {...props}
    />,
  );

describe('posts liked and commented on', () => {
  it('shows each with what it said, why, and the extension’s comment', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const onMore = jest.fn();
    await list({
      posts: [
        post({}),
        post({
          touchId: '9b6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
          kind: 'comment',
          name: 'Kim Ng',
          why: null,
          commentText: 'We do roofs around Austin!',
          group: { name: 'Austin Owners', url: 'https://www.facebook.com/groups/1/' },
        }),
        post({
          touchId: 'ab6f5c4d-3e2a-4b1c-8d9e-0f1a2b3c4d5e',
          kind: 'comment',
          auto: false,
          postText: null,
          why: null,
        }),
      ],
      next: '2026-10-01T12:00:00.000Z',
      onMore,
    });
    expect(screen.getAllByTestId('results-post')).toHaveLength(3);
    expect(screen.getAllByText('“Finally got the new roof on the shop!”')).toHaveLength(2);
    expect(screen.getByText('Why this post: A new roof on their shop')).toBeTruthy();
    expect(screen.getByText('We do roofs around Austin!')).toBeTruthy();
    expect(screen.getByText('By the extension · in Austin Owners')).toBeTruthy();
    expect(screen.getByText('Your own comment: its words aren’t kept.')).toBeTruthy();
    expect(screen.getAllByText('3 h ago').length).toBeGreaterThan(0);
    await fireEvent.press(screen.getAllByText('Open the post')[0]!);
    expect(open).toHaveBeenCalledWith('https://www.facebook.com/jo.hill.5/posts/1');
    await fireEvent.press(screen.getByTestId('results-posts-more'));
    expect(onMore).toHaveBeenCalled();
  });

  it('says when there are none, and when it needs signal', async () => {
    const onKind = jest.fn();
    await list({ kind: 'like', period: 'today', onKind });
    expect(screen.getByText('No likes noted today.')).toBeTruthy();
    expect(screen.queryByTestId('results-posts-more')).toBeNull();
    await fireEvent.press(screen.getByTestId('results-posts-comment'));
    expect(onKind).toHaveBeenCalledWith('comment');
    await list({ posts: null, error: 'Posts liked and commented on needs signal.' });
    expect(screen.getByTestId('results-posts-needs-signal')).toBeTruthy();
  });
});
