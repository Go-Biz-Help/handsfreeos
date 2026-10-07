/** The words for a business's logo and colour, the same on the web and the phone. Browser-safe. */
import { LOOK_UPLOAD_MAX_BYTES } from './look';

const mb = Math.round(LOOK_UPLOAD_MAX_BYTES / (1024 * 1024));

/** A website's address as people say it: "lonestarhvac.com". */
export const siteNameOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
};

export const LOOK_WORDS = {
  title: 'Your logo and colour',
  intro: 'They go on your booking page, website chat, invoices and emails.',
  logo: 'Logo',
  color: 'Colour',
  colorHint: 'For buttons and headings on your pages, and your website chat.',
  fromSite: (url: string) => `Found on ${siteNameOf(url)}.`,
  uploaded: 'Uploaded.',
  searching: (url: string) => `Looking for your logo on ${siteNameOf(url)}…`,
  notFound: (url: string) =>
    `We didn’t find a logo on ${siteNameOf(url)}. Upload one if you have it.`,
  noLogo: 'Upload your logo if you have one. Your initials stand in until you do.',
  making: 'Getting your logo ready…',
  upload: 'Upload a logo',
  change: 'Change',
  remove: 'Remove',
  removed: 'Logo removed',
  saved: 'Colour saved',
  logoReady: 'Logo saved',
  findAgain: (url: string) => `Look on ${siteNameOf(url)} again`,
  uploadHint: `A PNG, JPG, WebP, GIF or SVG, up to ${mb} MB. One with a see-through background looks best.`,
  fromLogo: 'From your logo',
  fromWebsite: 'From your website',
  anyColor: 'Any colour',
  pickColor: (hex: string) => `Use ${hex}`,
  /** "Any colour" typed on the phone, when it isn't one. */
  typeColor: 'Type a colour like #2d69d8.',
  preview: 'How it looks',
  previewButton: 'Book a time',
  /** Settings → Workspace. */
  settingsTitle: 'Logo and colour',
  settingsHint:
    'On your booking page, website chat, invoices and the emails HandsFreeOS sends for you.',
  cantChange:
    'Your role can’t change the business’s logo and colour. Ask an owner of this business to change them.',
  /** The setup's summary line, once there's a logo or a colour. */
  summary: (logo: boolean) =>
    `Your ${logo ? 'logo and colour are' : 'colour is'} on your booking page, website chat, invoices and emails.`,
} as const;

/** Why an upload couldn't be used, said to the person who uploaded it. */
export const LOOK_PROBLEMS = {
  unreadable: 'That picture couldn’t be opened. Try a PNG or JPG of your logo.',
  tooSmall: 'That logo is too small to look sharp. Upload one at least 64 pixels across.',
  tooLight:
    'That logo is white, so it wouldn’t show on your white pages. Upload the one you use on light backgrounds.',
  tooBig: `That picture is over ${mb} MB. Upload a smaller one.`,
  unsafeSvg:
    'That SVG has parts we can’t show safely, like links to other files. Save your logo as a PNG and upload that.',
  missing: 'The picture didn’t finish uploading. Check your connection and upload it again.',
  failed: 'Your logo couldn’t be made ready just now. Upload it again in a minute.',
} as const;
