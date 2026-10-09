/**
 * A made-up Facebook download file, for the Friends tab's browser test: a zip built here, laid out as Facebook lays
 * one out, with made-up people in it. Core's tests make theirs the same way (packages/core/test/addons/zip-maker.ts).
 */
import { crc32, deflateRawSync } from 'node:zlib';

/** A zip of these files, each deflated and dated `at`. */
export function makeZip(files: readonly { name: string; data: string }[], at: Date): Buffer {
  const date =
    ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const parts: Buffer[] = [];
  const listed: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.data, 'utf8');
    const packed = deflateRawSync(raw);
    const name = Buffer.from(f.name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    parts.push(header, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    listed.push(entry, name);
    offset += header.length + name.length + packed.length;
  }
  const list = Buffer.concat(listed);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(list.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, list, end]);
}

const seconds = (iso: string) => Date.parse(iso) / 1000;

/**
 * Pat Owner's download: three friends (one not saved in HandsFreeOS), a request they sent, and a chat with each of
 * two friends.
 */
export function madeUpDownload(
  sentAt: string,
  lastMessageAt: string,
): { name: string; data: string }[] {
  const json = (name: string, data: unknown) => ({ name, data: JSON.stringify(data) });
  const chat = (folder: string, other: string, from: string) =>
    json(`your_facebook_activity/messages/inbox/${folder}/message_1.json`, {
      participants: [{ name: other }, { name: 'Pat Owner' }],
      messages: [
        { sender_name: from, timestamp_ms: Date.parse(lastMessageAt), content: 'Made-up words' },
      ],
    });
  return [
    json('personal_information/profile_information/profile_information.json', {
      profile_v2: { name: { full_name: 'Pat Owner' } },
    }),
    json('connections/friends/your_friends.json', {
      friends_v2: [
        { name: 'Sky Patel', timestamp: seconds('2016-05-01T12:00:00Z') },
        { name: 'Parker Reed', timestamp: seconds('2019-07-14T12:00:00Z') },
        { name: 'Zed Unsaved', timestamp: seconds('2020-01-01T12:00:00Z') },
      ],
    }),
    json('connections/friends/sent_friend_requests.json', {
      sent_requests_v2: [{ name: 'Quinn Harper', timestamp: seconds(sentAt) }],
    }),
    chat('skypatel_1', 'Sky Patel', 'Sky Patel'),
    chat('parkerreed_2', 'Parker Reed', 'Pat Owner'),
  ];
}
