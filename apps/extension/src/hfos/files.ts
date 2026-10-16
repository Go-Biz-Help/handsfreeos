/**
 * The zips Facebook gives the person, as Chrome downloaded them: the "Download your information" file (one or more
 * parts) and the chat backup; and LinkedIn's copy of their data. The panel finds them in Chrome's downloads, so it
 * doesn't matter whether the extension pressed Download or the person did, and reads them from the person's computer,
 * where they stay, once the person lets the extension open files (Chrome's **Allow access to file URLs**). What's read
 * goes to HandsFreeOS as the Friends tab's card sends it: names and moments, and each one-to-one chat's latest few
 * messages for the AI to read (@hfos/core/addons/outreach/download-read); LinkedIn's as its lists and its chats
 * (`linkedInFileParts`).
 */
import {
  downloadParts,
  nameKey,
  type DownloadChat,
} from '@hfos/core/addons/outreach/download-read';
import type { FriendList } from '@hfos/core/addons/outreach/friends';
import { FRIENDS_SAVE_MOST } from '@hfos/core/addons/outreach/limits';
import type { LinkedInExport } from '@hfos/core/addons/outreach/linkedin-export';
import { dataPage } from '../networks/linkedin/data';
import type { ProfileRef } from '../networks/linkedin/types';
import { profileKey, profileRefOf } from '../networks/linkedin/urls';

/** Facebook's own hosts, which its files come from: its pages, its file servers and Messenger. */
const FACEBOOK_HOST = /(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com|messenger\.com)$/i;

/** The host of an address, a page's own for a file it made itself (`blob:https://www.facebook.com/…`). */
function hostOf(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href.startsWith('blob:') ? href.slice(5) : href).hostname;
  } catch {
    return null;
  }
}

/** What the panel needs to know of a download. */
export interface DownloadSeen {
  readonly url: string;
  readonly finalUrl?: string;
  readonly referrer?: string;
  /** Where Chrome saved it, the whole path. */
  readonly filename: string;
  readonly mime?: string;
}

/** Whether a download is one of Facebook's zips: from Facebook, or started on one of its pages, and a zip. */
export function isFacebookZip(item: DownloadSeen): boolean {
  const zip = /\.zip$/i.test(item.filename) || item.mime === 'application/zip';
  return (
    zip &&
    [item.url, item.finalUrl, item.referrer].some((href) => FACEBOOK_HOST.test(hostOf(href) ?? ''))
  );
}

/** The name LinkedIn gives its zip: Basic_LinkedInDataExport_10-15-2026.zip, or Complete_… for the larger one. */
const LINKEDIN_ZIP_NAME = /LinkedInDataExport[^\\/]*\.zip$/i;
/** LinkedIn's own hosts: its pages and its file servers. */
const LINKEDIN_HOST = /(^|\.)(linkedin\.com|licdn\.com)$/i;

/**
 * Whether a download is LinkedIn's copy of the person's data: a zip LinkedIn named as it names that one, or one from
 * LinkedIn started on Get a copy of your data. Never a file someone sent them in LinkedIn messaging.
 */
export function isLinkedInZip(item: DownloadSeen): boolean {
  const zip = /\.zip$/i.test(item.filename) || item.mime === 'application/zip';
  if (!zip) return false;
  if (LINKEDIN_ZIP_NAME.test(fileNameOf(item.filename))) return true;
  const fromLinkedIn = [item.url, item.finalUrl, item.referrer].some((href) =>
    LINKEDIN_HOST.test(hostOf(href) ?? ''),
  );
  return fromLinkedIn && !!item.referrer && dataPage(item.referrer);
}

/** A file's name without its folders, on a Mac or Windows alike. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * The address the extension opens a downloaded file at: `/Users/me/Downloads/facebook-me.zip` on a Mac, and
 * `C:\Users\me\Downloads\facebook-me.zip` on Windows, each part spelled so a `#` or a space in a name can't break it.
 */
export function fileUrlOf(path: string): string {
  const windows = /^[a-z]:[\\/]/i.test(path);
  const parts = path.split(windows ? /[\\/]/ : '/');
  const spelled = parts.map((part, i) =>
    windows && i === 0 ? part.toUpperCase() : encodeURIComponent(part),
  );
  return windows ? `file:///${spelled.join('/')}` : `file://${spelled.join('/')}`;
}

// ---- LinkedIn's file, ready to save ----

/** Someone on one of the person's LinkedIn lists in their file, as LinkedIn's lists are saved (./saves.ts). */
export interface FilePerson {
  readonly name: string;
  readonly profile: ProfileRef;
  readonly mutualConnections: null;
  /** Since when they're connected, or when the invitation went. */
  readonly since: string | null;
}

/** A part of LinkedIn's file to send in one save: some of one list, or some of the chats. */
export type LinkedInFilePart =
  | { readonly list: FriendList; readonly people: readonly FilePerson[] }
  | { readonly chats: readonly DownloadChat[] };

export interface LinkedInParts {
  readonly parts: readonly LinkedInFilePart[];
  readonly connections: number;
  /** Invitations still waiting, either way: those to or from a connection were answered, and are left out. */
  readonly invitations: number;
  readonly chats: number;
  /** People the file gave no profile link for, who can't be saved. */
  readonly noLink: number;
}

/**
 * LinkedIn's file in parts, in the order they're saved: the connections as the friends list, then the invitations
 * got and sent as requests and sent ones, each with its profile from its link and since when, in parts of
 * FRIENDS_SAVE_MOST; then the one-to-one chats, in parts each save takes, to be matched by name to the people just
 * saved. An invitation to or from someone who's a connection now was accepted, so it's left out.
 */
export function linkedInFileParts(
  read: Pick<LinkedInExport, 'connections' | 'invitations' | 'chats'>,
): LinkedInParts {
  let noLink = 0;
  const person = (p: { name: string; url: string | null; at: string | null }) => {
    const profile = p.url ? profileRefOf(p.url) : null;
    if (!profile) {
      noLink++;
      return [];
    }
    return [{ name: p.name, profile, mutualConnections: null, since: p.at } satisfies FilePerson];
  };
  const connections = read.connections.flatMap(person);
  const connected = new Set([
    ...connections.map((c) => profileKey(c.profile)),
    ...read.connections.map((c) => `name:${nameKey(c.name)}`),
  ]);
  const waiting = read.invitations.filter((i) => {
    const profile = i.url ? profileRefOf(i.url) : null;
    return !connected.has(profile ? profileKey(profile) : `name:${nameKey(i.name)}`);
  });
  const lists: [FriendList, FilePerson[]][] = [
    ['friends', connections],
    ['requests', waiting.filter((i) => i.direction === 'received').flatMap(person)],
    ['sent', waiting.filter((i) => i.direction === 'sent').flatMap(person)],
  ];
  const parts: LinkedInFilePart[] = [];
  for (const [list, people] of lists)
    for (let at = 0; at < people.length; at += FRIENDS_SAVE_MOST)
      parts.push({ list, people: people.slice(at, at + FRIENDS_SAVE_MOST) });
  // Core takes a chat by name; the other person's link stays here.
  const chats: DownloadChat[] = read.chats.map(({ url: _url, ...chat }) => chat);
  for (const part of downloadParts({ people: [], chats }))
    if (part.chats.length) parts.push({ chats: part.chats });
  return {
    parts,
    connections: connections.length,
    invitations: waiting.length,
    chats: chats.length,
    noLink,
  };
}
