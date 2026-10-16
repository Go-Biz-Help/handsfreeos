/**
 * LinkedIn's copy of the person's data (src/addons/outreach/linkedin-export.ts), read from a made-up zip: their
 * connections with each profile's address and since when, invitations either way, and their one-to-one conversations'
 * latest messages, found by each file's header row past LinkedIn's notes.
 */
import { describe, expect, it } from 'vitest';
import { DownloadError } from '../../src/addons/outreach/download-read';
import {
  connectionsIn,
  csvRows,
  invitationsIn,
  linkedInChatsIn,
  linkedInProfileUrl,
  linkedInTime,
  readLinkedInExport,
} from '../../src/addons/outreach/linkedin-export';
import { makeZip } from './zip-maker';

const CONNECTIONS = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing, like this, here."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Jane,Doe,https://www.linkedin.com/in/jane-doe-cpa,,"Doe & Co, LLC",Owner,15 Oct 2025
Sam,Lee,https://www.linkedin.com/in/samlee,,Bright Books,"Bookkeeper, part time",02 Mar 2024
`;

const INVITATIONS = `From,To,Sent At,Message,Direction,inviterProfileUrl,inviteeProfileUrl
Morgan Owner,Ari Moss,"10/14/25, 3:04 PM",,OUTGOING,https://www.linkedin.com/in/morgan-owner,https://www.linkedin.com/in/ari-moss
Kim Park,Morgan Owner,"10/12/25, 9:15 AM","Hi Morgan, let's connect",INCOMING,https://www.linkedin.com/in/kim-park,https://www.linkedin.com/in/morgan-owner
`;

const MESSAGES = `CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER
2-abc==,,Morgan Owner,https://www.linkedin.com/in/morgan-owner,Jane Doe,https://www.linkedin.com/in/jane-doe-cpa,2025-10-15 14:03:22 UTC,,"Thanks for connecting, Jane!",INBOX
2-abc==,,Jane Doe,https://www.linkedin.com/in/jane-doe-cpa,Morgan Owner,https://www.linkedin.com/in/morgan-owner,2025-10-15 15:10:00 UTC,,"<p>Happy to, Morgan.<br>What do you do?</p>",INBOX
2-grp==,Team,Morgan Owner,https://www.linkedin.com/in/morgan-owner,"Jane Doe,Sam Lee",,2025-10-01 10:00:00 UTC,,Hello all,INBOX
2-spam==,,Spammy Seller,https://www.linkedin.com/in/spammy,Morgan Owner,https://www.linkedin.com/in/morgan-owner,2025-10-02 10:00:00 UTC,,Buy now,SPAM
`;

const PROFILE = `First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary
Morgan,Owner,,,,"I help small firms book more calls",
`;

describe('LinkedIn’s data file', () => {
  it('reads a CSV’s quoted fields, with commas, quotes and line breaks in them', () => {
    expect(csvRows('﻿a,"b, c","say ""hi""\nthere"\r\nd,e,f')).toEqual([
      ['a', 'b, c', 'say "hi"\nthere'],
      ['d', 'e', 'f'],
    ]);
  });

  it('reads LinkedIn’s times and profile addresses', () => {
    expect(linkedInTime('15 Oct 2025')).toBe('2025-10-15T00:00:00.000Z');
    expect(linkedInTime('10/14/25, 3:04 PM')).toBe('2025-10-14T15:04:00.000Z');
    expect(linkedInTime('10/14/25, 12:30 AM')).toBe('2025-10-14T00:30:00.000Z');
    expect(linkedInTime('2025-10-15 14:03:22 UTC')).toBe('2025-10-15T14:03:22.000Z');
    expect(linkedInTime('someday')).toBeNull();
    expect(linkedInProfileUrl('http://linkedin.com/in/sam-lee?trk=x')).toBe(
      'https://www.linkedin.com/in/sam-lee/',
    );
    expect(linkedInProfileUrl('https://www.linkedin.com/company/acme/')).toBeNull();
  });

  it('finds the connections under LinkedIn’s notes, by their columns', () => {
    expect(connectionsIn(CONNECTIONS)).toEqual([
      {
        name: 'Jane Doe',
        url: 'https://www.linkedin.com/in/jane-doe-cpa/',
        at: '2025-10-15T00:00:00.000Z',
      },
      {
        name: 'Sam Lee',
        url: 'https://www.linkedin.com/in/samlee/',
        at: '2024-03-02T00:00:00.000Z',
      },
    ]);
    expect(connectionsIn('Something,Else\n1,2')).toBeNull();
  });

  it('keeps each invitation with the other person, either way', () => {
    expect(invitationsIn(INVITATIONS)).toEqual([
      {
        name: 'Ari Moss',
        url: 'https://www.linkedin.com/in/ari-moss/',
        at: '2025-10-14T15:04:00.000Z',
        direction: 'sent',
      },
      {
        name: 'Kim Park',
        url: 'https://www.linkedin.com/in/kim-park/',
        at: '2025-10-12T09:15:00.000Z',
        direction: 'received',
      },
    ]);
  });

  it('keeps one-to-one conversations, never a group’s or spam, with the other person’s profile', () => {
    expect(linkedInChatsIn(MESSAGES, 'Morgan Owner')).toEqual([
      {
        name: 'Jane Doe',
        url: 'https://www.linkedin.com/in/jane-doe-cpa/',
        firstAt: '2025-10-15T14:03:22.000Z',
        lastAt: '2025-10-15T15:10:00.000Z',
        messages: 2,
        lastFromMe: false,
        recent: [
          { fromMe: true, text: 'Thanks for connecting, Jane!', at: '2025-10-15T14:03:22.000Z' },
          {
            fromMe: false,
            text: 'Happy to, Morgan.\nWhat do you do?',
            at: '2025-10-15T15:10:00.000Z',
          },
        ],
      },
    ]);
  });

  it('reads the whole zip, and says when there’s nothing to bring in', async () => {
    const zip = new Blob([
      makeZip([
        { name: 'Connections.csv', data: CONNECTIONS },
        { name: 'Invitations.csv', data: INVITATIONS },
        { name: 'messages.csv', data: MESSAGES },
        { name: 'Profile.csv', data: PROFILE },
        { name: 'Ad_Targeting.csv', data: 'Member Age\n25 to 34' },
      ]),
    ]);
    const read = await readLinkedInExport([zip]);
    expect(read.connections).toHaveLength(2);
    expect(read.invitations).toHaveLength(2);
    expect(read.chats.map((c) => c.name)).toEqual(['Jane Doe']);
    // When the zip says its files were written: never before the latest moment in them.
    expect(read).toMatchObject({ read: 4, unread: 0, madeAt: '2026-10-01T12:00:00.000Z' });
    await expect(
      readLinkedInExport([new Blob([makeZip([{ name: 'Ad_Targeting.csv', data: 'x' }])])]),
    ).rejects.toBeInstanceOf(DownloadError);
  });
});
