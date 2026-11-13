import type {
  Creator,
  Idea,
  Niche,
  Overview,
  Playbook,
  Post,
  Work,
} from '@hfos/core/addons/socialcontent/shapes';
import type { CalendarView, Content } from '@hfos/core/addons/socialcontent/content-shapes';
import type { SetupFacts } from '@hfos/core/addons/socialcontent/picking';
import { planOf } from '@hfos/core/addons/socialcontent/calendar';
import * as React from 'react';
import type * as ReactNative from 'react-native';

/**
 * What AI Social Media Content Creator's phone tests draw with: a stand-in Screen (its title and children, without the
 * shell's safe areas and navigation), and its records as the queries answer them. Each test file mocks
 * `@/components/shell/screen` with `TestScreen`.
 */
export function TestScreen({
  title,
  children,
  testID,
}: {
  title?: string;
  children?: React.ReactNode;
  testID?: string;
}) {
  const RN = jest.requireActual<typeof ReactNative>('react-native');
  return (
    <RN.View testID={testID}>
      <RN.Text testID="screen-title">{title}</RN.Text>
      {children}
    </RN.View>
  );
}

export const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Now, as the screens' own "days ago" reads it. */
export const NOW = Date.now();
export const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

export function overview(over: Partial<Overview> = {}): Overview {
  return {
    settings: {
      networks: ['instagram'],
      readerUserId: ME,
      readerName: 'Chris',
      watchVideos: false,
      readerSeenAt: ago(2),
      readerVersion: '0.128.2',
      plan: planOf({}),
      facebookPage: null,
      facebookWhere: ['profile'],
      autoFill: true,
      autoPick: true,
    },
    readerIsMe: true,
    mayManage: true,
    counts: { suggested: 2, studying: 1, skipped: 0, standouts: 4, waiting: 0 },
    work: [],
    ...over,
  };
}

export function niche(n: number, over: Partial<Niche> = {}): Niche {
  return {
    id: id(n),
    name: `Niche ${n}`,
    own: false,
    state: 'suggested',
    why: null,
    searches: {},
    addedBy: 'ai',
    createdAt: ago(600),
    ...over,
  };
}

export function creator(n: number, over: Partial<Creator> = {}): Creator {
  return {
    id: id(n),
    network: 'instagram',
    handle: `creator_${n}`,
    shown: `@creator_${n}`,
    name: `Creator ${n}`,
    link: `https://www.instagram.com/creator_${n}/`,
    bio: null,
    followers: 12_000,
    lastPostAt: ago(3 * 24 * 60),
    nicheId: id(900),
    nicheName: 'CRM software',
    state: 'suggested',
    foundBy: 'search',
    why: 'Posts short tips about sales follow-ups.',
    profileReadAt: ago(60),
    postsReadAt: null,
    postsCount: 0,
    standoutsCount: 0,
    reading: false,
    createdAt: ago(600),
    pickedBy: null,
    match: null,
    matchWhy: null,
    engagement: null,
    ...over,
  };
}

/** How setting up on its own stands: under way, with Instagram half picked. */
export function setupFacts(over: Partial<SetupFacts> = {}): SetupFacts {
  return {
    autoPick: true,
    autoFill: true,
    marks: { startedAt: ago(60), nichesAt: ago(60), findAt: ago(60) },
    readerSet: true,
    nichesPicked: 3,
    findsLeft: 0,
    readsLeft: 0,
    networks: [{ network: 'instagram', studying: 4, byAi: 4, pickable: 6 }],
    noted: 0,
    playbookAt: null,
    filledAt: null,
    offerLive: true,
    listsFilled: 8,
    listsAll: 11,
    ...over,
  };
}

export function post(n: number, over: Partial<Post> = {}): Post {
  return {
    id: id(n),
    creatorId: id(1),
    creatorName: 'Creator 1',
    creatorShown: '@creator_1',
    network: 'instagram',
    postKey: `code${n}`,
    link: `https://www.instagram.com/p/code${n}/`,
    postedAt: ago(20 * 24 * 60),
    kind: 'video',
    caption: `Caption ${n}`,
    views: 31_000,
    likes: 900,
    comments: 100,
    shares: null,
    seconds: 30,
    pinned: false,
    viewsTimes: 3.1,
    engagementTimes: 1.2,
    standout: true,
    standoutOn: 'views',
    waiting: null,
    notes: {
      why: 'A question in the first line stops the scroll.',
      hook: 'Starts with a question',
      format: 'Talking head',
      topic: 'Follow-ups',
      techniques: ['Big words on screen'],
      useIt: 'Open with the question your customers ask most.',
    },
    watched: null,
    watching: false,
    ...over,
  };
}

export function playbook(over: Partial<Playbook> = {}): Playbook {
  return {
    summary: 'Short videos that open with a question do best.',
    sections: [
      {
        title: 'Hooks',
        items: [{ do: 'Open with a question', why: 'It stops the scroll.', examples: [id(50)] }],
      },
    ],
    standouts: 4,
    noted: 6,
    writtenAt: ago(2 * 24 * 60),
    ...over,
  };
}

export function idea(n: number, over: Partial<Idea> = {}): Idea {
  return {
    id: id(n),
    title: `Idea ${n}`,
    hook: 'Still chasing leads by hand?',
    format: 'Reel',
    network: 'instagram',
    outline: 'Show the old way, then the new way.',
    why: 'Questions do well for these creators.',
    basedOn: [id(50)],
    angle: null,
    topic: null,
    source: null,
    state: 'new',
    createdAt: ago(60),
    ...over,
  };
}

export function work(n: number, over: Partial<Work> = {}): Work {
  return {
    id: id(n),
    kind: 'find',
    network: 'instagram',
    nicheId: id(900),
    nicheName: 'CRM software',
    creatorId: null,
    creatorShown: null,
    postId: null,
    state: 'waiting',
    askedFor: 'person',
    failure: null,
    doneCount: null,
    progress: null,
    createdAt: ago(30),
    takenAt: null,
    finishedAt: null,
    ...over,
  };
}

/** One of the business's own posts, a draft for Instagram tomorrow unless told otherwise. */
export function content(n: number, over: Partial<Content> = {}): Content {
  return {
    id: id(n),
    title: `Post ${n}`,
    network: 'instagram',
    format: 'photo',
    words: `The words of post ${n}.`,
    hook: null,
    hashtags: ['homes'],
    slides: [],
    chain: [],
    script: null,
    picture: 'A front porch at dusk',
    pictureWay: 'design',
    pictureState: 'made',
    pictureFailure: null,
    pictures: [],
    facebookWhere: ['profile'],
    state: 'draft',
    postAt: new Date(NOW + 24 * 60 * 60_000).toISOString(),
    approvedBy: null,
    approvedAt: null,
    postedAt: null,
    postLink: null,
    postedTo: [],
    numbers: {},
    doneWell: null,
    failure: null,
    madeBy: 'ai',
    placedBy: 'ai',
    angle: null,
    topic: null,
    ideaId: null,
    stillNeeds: null,
    createdAt: ago(60),
    updatedAt: ago(30),
    ...over,
  };
}

/** The Calendar as `socialcontent.calendar.get` answers it: two weeks from today, in UTC. */
export function calendarView(over: Partial<CalendarView> = {}): CalendarView {
  const today = new Date(NOW).toISOString().slice(0, 10);
  return {
    timeZone: 'UTC',
    today,
    from: today,
    days: 15,
    plan: planOf({}),
    open: [],
    posts: [],
    undated: [],
    recent: [],
    filledAt: ago(120),
    nextFillAt: new Date(NOW + 5 * 24 * 60 * 60_000).toISOString(),
    autoFill: true,
    offerLive: true,
    ideasSaved: 0,
    ready: 0,
    poster: { name: 'Chris', mine: true, seenAt: ago(1), version: '0.134.0' },
    postsOn: ['facebook', 'linkedin', 'instagram'],
    facebookPage: null,
    mayManage: true,
    ...over,
  };
}
