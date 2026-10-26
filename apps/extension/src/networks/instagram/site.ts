/**
 * Instagram (../looking/site.ts; docs/outreach.md decision 78): a follow network, where people are found by hashtags,
 * places and the followers of accounts like the business's (the plan's "The networks after LinkedIn"). Check Instagram
 * reads its pages and looks for Follow, Message, Like, the box to comment in and the bio's box, pressing none of them.
 * From the plan's part 10 its own readers read its pages (./read.ts), from part 11 the person's own steps there are
 * noted (./actions.ts), from part 12 it works in the app, and from part 14 its runner presses a few of its buttons on
 * its own once the person lets it (./auto.ts). Instagram's terms forbid automated collection and it blocks fast
 * ("Action blocked"), so the extension reads only what the person asks or lets it, at a person's pace, and stops on
 * any warning there.
 *
 * Its addresses are in ./urls.ts.
 *
 * From the owner's Check Instagram (17 Oct 2026): an account's Following is its word beside an arrow labelled "Down
 * chevron icon" (so a control's own words come before its picture's label, ../looking/read.ts), and a post's box to
 * comment in has no Post till something's written in it.
 */
import { clean } from '../facebook/dom';
import { visible } from '../facebook/fetch';
import { typeInto } from '../facebook/join';
import { outlineNow } from '../looking/read';
import {
  boxesSaying,
  controlsSaying,
  lookFor,
  mainOf,
  namesIn,
  pause,
  waitFor,
  writingIn,
} from '../looking/looks';
import type { LookingSite } from '../looking/site';
import { missingOf, TRY_WORD, went, untried } from '../tries';
import { instagramNoticer } from './actions';
import { followThem, likeTheirPost, openTheirChat, theirPosts, writeMessage } from './auto';
import { bioBoxOf, readOwnProfile, submitsOf, writeBio, writeBioSteps } from './own-profile';
import { readInstagram } from './read';
import { openChat, openFollowers, scrollList } from './browse';
import { readReplies } from './replies';
import { unfollow } from './unfollow';
import { HOST, instagramUrl, kindOf, partsOf, postOf, profileOf } from './urls';
import { INSTAGRAM_WARNINGS } from './warnings';

/** Instagram's own words on its pages, as the outline keeps them. */
const WORDS = new Set(
  [
    'Instagram',
    'Home',
    'Search',
    'Explore',
    'Reels',
    'Messages',
    'Notifications',
    'Create',
    'Profile',
    'More',
    'Threads',
    'Also from Meta',
    'Follow',
    'Following',
    'Follow Back',
    'Requested',
    'Unfollow',
    'Message',
    'Like',
    'Unlike',
    'Comment',
    'Share',
    'Share Post',
    'Save',
    'Remove',
    'Post',
    'Posts',
    'posts',
    'followers',
    'following',
    'Followers',
    'Edit profile',
    'Edit Profile',
    'View archive',
    'Bio',
    'Website',
    'Gender',
    'Submit',
    'Suggested for you',
    'Suggested for You',
    'See all',
    'See All',
    'Switch',
    'Log in',
    'Sign up',
    'Your messages',
    'Send message',
    'Send',
    'Primary',
    'General',
    'Requests',
    'Recent',
    'Clear all',
    'Tagged',
    'Saved',
    'Highlights',
    'New',
    'Options',
    'Close',
    'Back',
    'Next',
    'Cancel',
    'Done',
    'More options',
    'Original audio',
    'Sponsored',
    'Paid partnership',
    'Liked by',
    'others',
    'and',
    'View all comments',
    'View replies',
    'Hide replies',
    'Reply',
    'See translation',
    'Verified',
    'Meta',
    'About',
    'Help',
    'Privacy',
    'Terms',
    'Locations',
    'Language',
    'Meta Verified',
    'Add a comment…',
    'Add a comment...',
    'Emoji',
    'Comment as',
    'Top posts',
    'Most recent',
    'Not now',
    'Turn on',
    'Turn on Notifications',
    'Dismiss',
    'Audio',
    'Accounts',
    'Tags',
    'Places',
    'Log out',
    'Settings',
    'Your activity',
    'Report a problem',
    'Switch accounts',
    'Professional dashboard',
    'Insights',
    'Edit',
    'Story',
    'Stories',
    'Notes',
    'Your note',
    'Active now',
    'Seen',
    'Down chevron icon',
    'Similar accounts',
    'Discover people',
    'Suggested',
    'New post',
    'Reposts',
    'Message requests',
    'Message...',
    'Message…',
    'Write a message...',
    'Write a message…',
    'Follows you',
    'Accept',
    'Decline',
    'Block',
    'Delete',
    'likes',
    'You sent',
    'This week',
    'This month',
    'Earlier',
    'Today',
    'Yesterday',
    'Hidden requests',
    'started following you.',
    'liked your post.',
    'liked your photo.',
    'liked your reel.',
    'liked your comment:',
    'commented:',
    'Close chat',
    'Minimize chat',
    'Conversation information',
    'Voice clip',
    'Add photo or video',
    'Choose an emoji',
    'Audio call',
    'Video call',
    'View profile',
    // Its Accounts Center, where Put these in changes the username and the name (decision 89).
    'Accounts Center',
    'Profiles',
    'Personal details',
    'Password and security',
    'Username',
    'Name',
    'Done',
    'Back',
    'Cancel',
    'Continue',
    'Confirm',
    'Change username',
    'Change name',
  ].map((w) => w.toLowerCase()),
);

/** Instagram's own words in its addresses. */
const PATH_WORDS = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'explore',
  'tags',
  'search',
  'keyword',
  'locations',
  'direct',
  'inbox',
  't',
  'new',
  'requests',
  'accounts',
  'edit',
  'activity',
  'stories',
  'highlights',
  'followers',
  'following',
  'tagged',
  'saved',
  'guides',
  'featured',
  'notifications',
  'challenge',
  'about',
  'legal',
  'privacy',
  'terms',
  'your_activity',
  'audio',
  'liked_by',
  'comments',
  'people',
  'reposts',
  // A comment's own link: /p/<code>/c/<id>/.
  'c',
]);

const FOLLOW = /^(follow|follow back)$/i;
const FOLLOWING = /^(following|requested|unfollow)$/i;
const MESSAGE = /^message$/i;
const LIKE = /^(like|unlike)$/i;
const COMMENT_BOX = /^add a comment/i;
const POST = /^post$/i;
/** A chat's box to write in, as Message opens it. */
const CHAT_BOX = /^(message|write a message)/i;
const CLOSE_CHAT = /^(close|close chat|minimi[sz]e|minimi[sz]e chat)$/i;

/** The profile's own header: its name, its counts and its buttons. */
const headerOf = (doc: Document): ParentNode => mainOf(doc).querySelector('header') ?? mainOf(doc);

/** The boxes to write a message in, anywhere on the page: a chat opened over it, or the chat's own page. */
const chatBoxes = (doc: Document): HTMLElement[] => boxesSaying(doc, CHAT_BOX);

/**
 * Writes in a box as typing does (Chrome's own insertText, whose events the page takes as a person's), or empties it;
 * a plain box's value set by hand only where that can't be done. From the owner's third Check (0.60.0): a value set by
 * hand showed Post but didn't stay in Instagram's box. Typing goes where the focus is, so it's never done unless the box
 * has it.
 */
function writeIn(doc: Document, box: HTMLElement, text: string): void {
  box.focus();
  const focused = doc.activeElement === box;
  if (focused && box instanceof doc.defaultView!.HTMLTextAreaElement) box.select();
  else if (focused && typeof doc.execCommand === 'function') doc.execCommand('selectAll');
  const typed =
    focused &&
    typeof doc.execCommand === 'function' &&
    (text ? doc.execCommand('insertText', false, text) : doc.execCommand('delete'));
  if (!typed) typeInto(doc, box, text, true);
}

/** Whether a box is there with something written in it. */
const written = (box: Element | null): boolean => box !== null && writingIn(box);

/** Closes a chat opened over the page by its own Close: the nearest one around its box. */
async function closeChat(box: HTMLElement): Promise<boolean> {
  for (let up = box.parentElement, steps = 0; up && steps < 20; up = up.parentElement, steps++) {
    const close = controlsSaying(up, CLOSE_CHAT)[0];
    if (!close) continue;
    close.click();
    return (await waitFor(() => (!box.isConnected || !visible(box) ? true : null), 4_000)) === true;
  }
  return false;
}

export const INSTAGRAM: LookingSite = {
  platform: 'instagram',
  name: 'Instagram',
  // Its own Accounts Center too, where its tab changes the person's username and name (decision 89, from 0.93.0).
  hosts: ['https://www.instagram.com/*', 'https://accountscenter.instagram.com/*'],
  accountsCenter: 'instagram',
  // Its own readers (part 10): a profile, the person's followers, a post, a hashtag's and a place's posts, notifications,
  // messages and a chat, each counted in Check's notes so the next Check shows what they find on the real pages.
  readFound: readInstagram,
  // The person's own steps, noted as they take them (part 11): Follow, Like, a comment and a message.
  noticer: instagramNoticer,
  // Unfollowing those the person ticked who didn't follow back (part 12), by Following and Unfollow's own words.
  unfollow,
  // Its lists, for the person's asks (parts 12 and 13): their followers' box scrolled, and their chats' list too; a
  // chat opened for Check, or by its row's name for Read my chats. From 0.84.0 their followers' box opened by their
  // account's count of followers, where Instagram doesn't open it from its address.
  lists: {
    scroll: (doc, href) => scrollList(doc, href),
    showAll: (doc, href) => openFollowers(doc, href),
    openChat: (doc, _href, name) => openChat(doc, name),
  },
  // Who wrote back in their chats (part 13), as the person goes and as Read my chats goes.
  replies: readReplies,
  // What its runner presses on its own (part 14), each only on its own page: a like on a post of theirs, Follow and
  // Message under their name, and a message in their chat (./auto.ts). Never a comment.
  auto: {
    theirPosts,
    like: likeTheirPost,
    connect: followThem,
    openMessage: openTheirChat,
    message: writeMessage,
  },
  host: HOST,
  url: instagramUrl,
  kindOf,
  profileOf,
  postOf,
  pathWords: PATH_WORDS,
  words: WORDS,
  warnings: INSTAGRAM_WARNINGS,
  warnedAt: (url) =>
    partsOf(url)[0]?.toLowerCase() === 'challenge'
      ? 'Instagram is asking you to confirm it’s you before you go on.'
      : null,
  // The menu's Profile, which links to the person's own account.
  ownLink: (doc, href) => {
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const words = clean(anchor.textContent) || clean(anchor.getAttribute('aria-label'));
      if (
        !/^profile$/i.test(words) &&
        !/['’]s profile picture$/i.test(
          clean(anchor.querySelector('img[alt]')?.getAttribute('alt')),
        )
      )
        continue;
      const url = instagramUrl(anchor.getAttribute('href') ?? '', href);
      const own = url ? profileOf(url) : null;
      if (own) return own.url;
    }
    return null;
  },
  // Their own account, read for the AI's check, and the bio put in on its form (decision 80).
  ownProfile: { read: readOwnProfile, writeBio, writeBioSteps },
  looks: {
    // On their own profile's form: the bio's box and its Submit, neither written in nor pressed.
    bio: {
      on: ['edit-profile'],
      // Found as Put these in finds them (./own-profile.ts), so the look and the bio's writer never disagree.
      look: (doc) => {
        const main = mainOf(doc);
        const box = bioBoxOf(doc);
        const submit = submitsOf(doc);
        return went(
          'bio',
          { box: Boolean(box), submit: submit.length },
          [
            !box && 'no box for the bio on the form',
            !submit.length && 'no Submit on the form',
          ].filter((m): m is string => typeof m === 'string'),
          box && submit.length ? [] : namesIn(main, INSTAGRAM),
        );
      },
    },
    // On someone's account: Follow (or Follow Back), never pressed; one they follow already isn't tried.
    follow: {
      on: ['profile'],
      look: (doc) =>
        lookFor(
          'follow',
          headerOf(doc),
          INSTAGRAM,
          { words: FOLLOW, name: 'Follow' },
          {
            words: FOLLOWING,
            why: 'you follow them already, or asked to',
          },
        ),
    },
    // Message opens a chat, and nothing more: its box is looked for, nothing is written in it (Instagram shows the
    // other person when someone's writing), and a chat opened over the page is closed again.
    message: {
      on: ['profile'],
      look: async (doc, href) => {
        const header = headerOf(doc);
        const message = controlsSaying(header, MESSAGE)[0];
        if (!message)
          return went(
            'message',
            { message: false },
            ['no Message on their account'],
            namesIn(header, INSTAGRAM),
          );
        const before = new Set(chatBoxes(doc));
        message.click();
        const box = await waitFor(() => chatBoxes(doc).find((b) => !before.has(b)), 8_000);
        const at = doc.defaultView?.location.href ?? href;
        if (!box)
          return {
            ...went(
              'message',
              { message: true, box: false },
              ['Message opened no chat to write in'],
              namesIn(mainOf(doc), INSTAGRAM),
            ),
            outline: outlineNow(doc, INSTAGRAM),
          };
        // A chat on its own page (/direct/t/…) is left as it is: the Check opens its next page anyway.
        const own = INSTAGRAM.url(at);
        const onItsPage = own !== null && kindOf(own) === 'chat';
        const closed = onItsPage || (await closeChat(box));
        return went(
          'message',
          { message: true, box: true, chatPage: onItsPage, closed },
          closed ? [] : ['the chat Message opened didn’t close again'],
          closed ? [] : namesIn(box.parentElement ?? mainOf(doc), INSTAGRAM),
        );
      },
    },
    // On a post's own page: its Like (an icon labelled Like, or Unlike once liked), never pressed.
    like: {
      on: ['post'],
      look: (doc) => {
        const main = mainOf(doc);
        const likes = controlsSaying(main, LIKE, true);
        if (!likes.length)
          return went('like', { like: 0 }, ['no Like on the post'], namesIn(main, INSTAGRAM));
        return went(
          'like',
          {
            like: likes.length,
            liked: likes.some((l) =>
              /^unlike$/i.test(l.getAttribute('aria-label') ?? l.textContent ?? ''),
            ),
          },
          [],
        );
      },
    },
    // On a post's own page: its box to comment in, and its Post, which Instagram shows only once something's written:
    // a word written in the box, Post looked for (never pressed), and the box emptied again.
    comment: {
      on: ['post'],
      look: async (doc) => {
        const main = mainOf(doc);
        const box = boxesSaying(main, COMMENT_BOX)[0] ?? null;
        if (!box) {
          const off = /\bcomments? (on this post )?(have been|are) (limited|turned off)\b/i.test(
            clean(main.textContent),
          );
          if (off) return untried('comment', 'comments are off on that post', { box: false });
          return went(
            'comment',
            { box: false },
            ['no box to comment in on the post'],
            namesIn(main, INSTAGRAM),
          );
        }
        if (writingIn(box))
          return untried('comment', 'writing in the comment box already, left alone', {
            box: true,
          });
        // Instagram redraws the form once its box has the focus (Post shows), and again once something's written in it,
        // so each look finds the box as it is now (the owner's Check, 0.62.0: the word stayed in the box drawn after it
        // was written, while the one it was written in read empty).
        const now = () => boxesSaying(main, COMMENT_BOX)[0] ?? null;
        box.focus();
        await pause(400);
        writeIn(doc, now() ?? box, TRY_WORD);
        const typed = (await waitFor(() => (written(now()) ? true : null), 1_500)) === true;
        const post = await waitFor(() => {
          const live = now();
          return live ? controlsSaying(live.closest('form') ?? main, POST, true)[0] : null;
        }, 3_000);
        const live = now();
        if (live) writeIn(doc, live, '');
        const emptied =
          (await waitFor(() => {
            const after = now();
            return after && !writingIn(after) ? true : null;
          }, 2_000)) === true;
        const form = now()?.closest('form') ?? main;
        const missing = missingOf([
          !typed && 'writing in the comment box didn’t take',
          typed && !post && 'no Post by the box to comment in, with a word written in it',
          !emptied && 'the comment box didn’t empty again',
        ]);
        return {
          ...went(
            'comment',
            { box: true, typed, post: post ? 1 : 0, emptied },
            missing,
            missing.length ? namesIn(form, INSTAGRAM) : [],
          ),
          ...(missing.length ? { outline: outlineNow(doc, INSTAGRAM) } : {}),
        };
      },
    },
  },
};
