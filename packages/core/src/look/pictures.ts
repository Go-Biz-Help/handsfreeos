/**
 * Your pictures (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1): one library of pictures per business, put on
 * its forms, booking pages, emails, website chat and invoices. Browser-safe.
 *
 * - A person uploads a picture to the private `picture-uploads` bucket, at the place `picture.begin_upload` reserved
 *   (a row in `app.design_pictures`, `uploading`), and hands it over with `picture.use_upload` (`making`).
 * - The worker makes the copy everyone sees: WebP, at most 2000 pixels on its longer side, turned the way the camera
 *   held it, with the camera's hidden details (where it was taken, the phone) left out. It goes in the public
 *   `pictures` bucket, so it shows on a client's website and in an email, and `picture.note_made` keeps it (`ready`)
 *   or says why it couldn't be used (`failed`). The upload is removed either way; the original isn't kept.
 * - Removing a picture takes it out of the library; its file stays, so a page already showing it doesn't break.
 */

/** Where the made copies are kept: public, so pages and emails can show them. */
export const PICTURE_BUCKET = 'pictures' as const;
/** Where uploads wait for the worker: private. */
export const PICTURE_UPLOAD_BUCKET = 'picture-uploads' as const;

/** The pictures someone can upload, and the ending each waits with. */
export const PICTURE_UPLOAD_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
} as const;
export type PictureUploadType = keyof typeof PICTURE_UPLOAD_TYPES;

/** Some systems hand over a picture without its type: worked out from its ending. */
export const PICTURE_TYPE_BY_ENDING: Readonly<Record<string, PictureUploadType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/** An iPhone photo in Apple's own format, which the worker can't open: said so, with how to send a JPG instead. */
export const isAppleHeic = (mimeType: string, name: string): boolean =>
  /^image\/hei[cf]/i.test(mimeType) || /\.hei[cf]$/i.test(name);

/** The biggest upload: a phone's full-size photo fits. */
export const PICTURE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** The longest side of the copy everyone sees. */
export const PICTURE_MAX_SIDE = 2000;
/** The smallest a picture can be across and still be worth showing. */
export const PICTURE_MIN_SIDE = 32;
/** The most pictures a business keeps in its library. */
export const PICTURE_LIBRARY_MAX = 500;
/** The most pictures uploaded at once. */
export const PICTURE_UPLOAD_AT_ONCE = 20;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A picture waiting in `picture-uploads`: `<business>/<id>.<ending>`. */
export const PICTURE_UPLOAD_PATH = new RegExp(`^${UUID}/${UUID}\\.(?:png|jpg|webp|gif|avif)$`);
/** A made copy in `pictures`: `<business>/<id>.webp`. */
export const PICTURE_PATH = new RegExp(`^${UUID}/${UUID}\\.webp$`);

export const PICTURE_STATUSES = ['uploading', 'making', 'ready', 'failed'] as const;
export type PictureStatus = (typeof PICTURE_STATUSES)[number];

/** Where a made picture can be seen by anyone: Supabase Storage's public address for it. */
export const pictureUrlFor = (storageUrl: string, path: string): string =>
  `${storageUrl.replace(/\/+$/, '')}/storage/v1/object/public/${PICTURE_BUCKET}/${path}`;

/** What's said about the library, the same on the web and the phone. */
export const PICTURE_WORDS = {
  title: 'Your pictures',
  hint: 'Upload them once, then put them on your forms, booking pages and emails.',
  upload: 'Upload pictures',
  uploadHint: `PNG, JPG, WebP or GIF, up to ${PICTURE_UPLOAD_MAX_BYTES / (1024 * 1024)} MB each. We make a web copy of each, and leave out where it was taken.`,
  empty: 'No pictures yet. Upload job photos, your team or your truck.',
  making: 'Getting it ready…',
  failed: 'Couldn’t use this one',
  words: 'What it shows',
  wordsHint: 'Read out to people who can’t see it, and shown if it doesn’t load.',
  remove: 'Remove',
  removed: 'Picture removed. Pages already showing it still do.',
  saved: 'Saved',
  pick: 'Pick a picture',
  none: 'None',
  cantChange:
    'Your role can’t change the business’s pictures. Ask an owner of this business to add them, or to let you change forms or calendars.',
} as const;

/** Why an upload couldn't be used, said to the person who uploaded it. */
export const PICTURE_PROBLEMS = {
  unreadable: 'That picture couldn’t be opened. Try saving it as a JPG or PNG and upload it again.',
  tooSmall: `That picture is too small to show. Upload one at least ${PICTURE_MIN_SIDE} pixels across.`,
  tooBig: `That picture is over ${PICTURE_UPLOAD_MAX_BYTES / (1024 * 1024)} MB. Upload a smaller copy.`,
  missing: 'That picture didn’t finish uploading. Upload it again.',
  failed: 'Something went wrong getting that picture ready. Upload it again in a minute.',
  heic: 'That’s an iPhone photo in Apple’s own format (HEIC), which we can’t open. On a Mac, open it in Preview and pick File → Export → JPEG, then upload that. Photos picked on an iPhone come as JPGs already.',
} as const;
export type PictureProblem = keyof typeof PICTURE_PROBLEMS;
