/**
 * Threads' and X's site (../looking/site.ts; decision 163), built from each one's spec (./types.ts): its own readers
 * (./read.ts) on every page read, its runner's presses (./auto.ts), unfollowing, its lists scrolled, the person's own
 * profile read for the AI's check, and Check's looks for Follow, Like and the box to reply in, pressing none of them.
 * No message is ever written there (decision 163): the site has no `openMessage`, and its `message` sends nothing.
 *
 * Both networks warn and limit accounts that go fast, so the extension reads only what the person lets it, at a
 * person's pace, and stops on any warning there.
 */
import { PROFILE_READ_LIMITS, type ProfileRead } from '@hfos/core/addons/outreach/profile-check';
import { clean } from '../facebook/dom';
import { scrollDialog } from '../instagram/browse';
import { outlineNow } from '../looking/read';
import { mainOf, namesIn, pause, waitFor, writeIn, writingIn } from '../looking/looks';
import type { LookingPlatform, LookingSite } from '../looking/site';
import { missingOf, TRY_WORD, untried, went } from '../tries';
import { followThem, likeTheirPost, theirPosts, unfollowThem, writeTheirComment } from './auto';
import { postRootFor, profileOn, postsOn, readFollow } from './read';
import type { FollowSpec } from './types';

/** A line cut to fit what the AI's check takes. */
const cut = (text: string | null | undefined, most: number): string | null => {
  const words = clean(text);
  return words ? words.slice(0, most) : null;
};

/** Closes a box over the page by Escape, as a person would: a box to reply in that a look opened. */
function closeBox(doc: Document): void {
  const box = doc.querySelector('[role="dialog"]') ?? doc.body;
  box.dispatchEvent(
    new (doc.defaultView ?? globalThis).KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
    }),
  );
}

export function followSite(spec: FollowSpec): LookingSite {
  const site: LookingSite = {
    platform: spec.platform as LookingPlatform,
    name: spec.name,
    hosts: spec.hosts,
    host: spec.host,
    url: spec.url,
    kindOf: spec.kindOf,
    profileOf: spec.profileOf,
    postOf: spec.postOf,
    pathWords: spec.pathWords,
    words: spec.words,
    warnings: spec.warnings,
    ...(spec.warnedAt ? { warnedAt: spec.warnedAt } : {}),
    ownLink: spec.ownLink,
    readFound: (doc, href) => readFollow(doc, href, spec),
    unfollow: unfollowThem(spec),
    lists: {
      // The person's followers: a box over their profile (Threads'), else the page itself (X's), a screen at a time.
      scroll: (doc) => scrollDialog(doc, false),
      showAll: (doc) => spec.openFollowers?.(doc) ?? false,
      closeDialog: async (doc) => {
        if (!doc.querySelector('[role="dialog"]')) return true;
        closeBox(doc);
        return (
          (await waitFor(() => (doc.querySelector('[role="dialog"]') ? null : true), 3_000)) ===
          true
        );
      },
    },
    auto: {
      theirPosts: theirPosts(spec),
      like: likeTheirPost(spec),
      connect: followThem(spec),
      // Nothing is ever written in anyone's messages there yet (decision 163).
      message: async () => 'none',
      comment: writeTheirComment(spec),
    },
    // Their own profile, read for the AI's check: its name, username, bio, links and latest posts.
    ownProfile: {
      read: (doc, href): ProfileRead => {
        const posts = postsOn(doc, href, spec);
        const profile = profileOn(doc, href, spec, posts);
        return {
          platform: spec.platform,
          url: profile?.url ?? href,
          name: cut(profile?.name, PROFILE_READ_LIMITS.line),
          username: profile?.username ?? null,
          links: (profile?.links ?? []).slice(0, PROFILE_READ_LIMITS.links),
          bio: cut(profile?.bio, PROFILE_READ_LIMITS.bio),
          posts: (profile?.posts ?? [])
            .map((p) => cut(p.text, PROFILE_READ_LIMITS.post))
            .filter((t): t is string => t !== null)
            .slice(0, PROFILE_READ_LIMITS.posts),
        };
      },
    },
    looks: {
      // On someone's profile: Follow (or Follow back), never pressed; one they follow already isn't tried.
      follow: {
        on: ['profile'],
        look: (doc) => {
          const header = spec.headerOf(doc);
          if (!header)
            return went(
              'follow',
              { header: false },
              ['no profile header on the page'],
              namesIn(mainOf(doc), site),
            );
          const standing = spec.followIn(header);
          if (standing.following && !standing.follow)
            return untried('follow', 'you follow them already, or asked to', { already: true });
          return went(
            'follow',
            { follow: standing.follow !== null },
            standing.follow ? [] : ['no Follow on their profile'],
            standing.follow ? [] : namesIn(header, site),
          );
        },
      },
      // On a post's own page: its own Like, never pressed.
      like: {
        on: ['post'],
        look: (doc, href) => {
          const page = spec.url(href);
          const url = page ? spec.postOf(page) : null;
          const root = url ? postRootFor(doc, href, spec, url) : null;
          if (!root)
            return went(
              'like',
              { post: false },
              ['the post its address names isn’t on the page'],
              namesIn(mainOf(doc), site),
            );
          const like = spec.likeIn(root);
          return went(
            'like',
            { like: like !== null, liked: like?.liked === true },
            like ? [] : ['no Like on the post'],
            like ? [] : namesIn(root, site),
          );
        },
      },
      // On a post's own page: the box to reply to it (under it, or opened by its own Reply), a word written in it and
      // its button looked for (never pressed), then the box emptied, and any box the look opened closed again.
      comment: {
        on: ['post'],
        look: async (doc, href) => {
          const page = spec.url(href);
          const url = page ? spec.postOf(page) : null;
          const root = url ? postRootFor(doc, href, spec, url) : null;
          if (!root)
            return went(
              'comment',
              { post: false },
              ['the post its address names isn’t on the page'],
              namesIn(mainOf(doc), site),
            );
          const find = () => {
            const boxes = spec.replyBoxes(doc);
            return boxes.filter((b) => b.closest('[role="dialog"]')).at(-1) ?? boxes[0] ?? null;
          };
          let box = find();
          let opened = false;
          if (!box) {
            const reply = spec.replyIn(root);
            if (!reply)
              return went(
                'comment',
                { box: false, reply: false },
                ['no box to reply in, and no Reply on the post'],
                namesIn(root, site),
              );
            reply.click();
            opened = true;
            box = await waitFor(find, 6_000);
          }
          if (!box) {
            const outline = outlineNow(doc, site);
            closeBox(doc);
            return {
              ...went(
                'comment',
                { box: false, reply: true },
                ['Reply opened no box to write in'],
                namesIn(mainOf(doc), site),
              ),
              outline,
            };
          }
          if (writingIn(box)) {
            if (opened) closeBox(doc);
            return untried('comment', 'writing in the reply box already, left alone', {
              box: true,
            });
          }
          box.focus();
          await pause(400);
          writeIn(doc, find() ?? box, TRY_WORD);
          const typed =
            (await waitFor(() => (find() && writingIn(find()!) ? true : null), 1_500)) === true;
          const send = await waitFor(() => {
            const b = find();
            return b ? spec.sendFor(b) : null;
          }, 3_000);
          const live = find();
          if (live) writeIn(doc, live, '');
          const emptied =
            (await waitFor(() => (find() && !writingIn(find()!) ? true : null), 2_000)) === true;
          const outline = typed && send && emptied ? null : outlineNow(doc, site);
          if (opened) {
            await pause(300);
            closeBox(doc);
          }
          const missing = missingOf([
            !typed && 'writing in the reply box didn’t take',
            typed && !send && 'no button to send by the reply box, with a word written in it',
            !emptied && 'the reply box didn’t empty again',
          ]);
          return {
            ...went(
              'comment',
              { box: true, opened, typed, send: send ? 1 : 0, emptied },
              missing,
              missing.length ? namesIn(live?.closest('[role="dialog"]') ?? root, site) : [],
            ),
            ...(outline ? { outline } : {}),
          };
        },
      },
    },
  };
  return site;
}
