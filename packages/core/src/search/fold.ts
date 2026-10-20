/**
 * Folding accents for search, so "jose" finds José and "lodz" finds Łódź (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md,
 * decision 23).
 *
 * Each letter turns into exactly one letter, never two: ł into l, ø into o, ß into s, æ into a, œ into o, İ into i.
 * So a folded text is as long as the original, and a match found in it marks the same place in what's shown. A
 * letter outside the map stays as it is, a combining accent included.
 *
 * The database folds with the same map: `private.search_fold` (20261027009700_search_windows.sql) is
 * `lower(translate(p, FOLD_FROM, FOLD_TO))`, with the two strings below copied in, and skips `translate` for text
 * that is all ASCII, since no ASCII letter is in the map. `test/search/fold.test.ts` runs
 * both over the same words and fails when they disagree, so a change here is a new migration with the new strings.
 * No `unaccent`: it isn't installed, and it turns ß into ss and æ into ae, which would move every mark after them.
 */

/** Every letter that folds, grouped under the letter it folds to. Both cases: the map runs before lower-casing. */
const FOLDS_TO: Readonly<Record<string, string>> = {
  a: 'ÀÁÂÃÄÅàáâãäåĀāĂăĄąǍǎǞǟǠǡǺǻȀȁȂȃȦȧḀḁẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặÆæǼǽǢǣ',
  b: 'ḂḃḄḅḆḇ',
  c: 'ÇçĆćĈĉĊċČčḈḉ',
  d: 'ĎďḊḋḌḍḎḏḐḑḒḓĐđÐð',
  e: 'ÈÉÊËèéêëĒēĔĕĖėĘęĚěȄȅȆȇȨȩḔḕḖḗḘḙḚḛḜḝẸẹẺẻẼẽẾếỀềỂểỄễỆệ',
  f: 'Ḟḟ',
  g: 'ĜĝĞğĠġĢģǦǧǴǵḠḡ',
  h: 'ĤĥȞȟḢḣḤḥḦḧḨḩḪḫẖĦħ',
  // İ is here because lower-casing it gives two characters (i and a combining dot), which would move every mark.
  i: 'ÌÍÎÏìíîïĨĩĪīĬĭĮįİǏǐȈȉȊȋḬḭḮḯỈỉỊịı',
  j: 'Ĵĵǰ',
  k: 'ĶķǨǩḰḱḲḳḴḵ',
  l: 'ĹĺĻļĽľḶḷḸḹḺḻḼḽŁłĿŀ',
  m: 'ḾḿṀṁṂṃ',
  n: 'ÑñŃńŅņŇňǸǹṄṅṆṇṈṉṊṋ',
  o: 'ÒÓÔÕÖòóôõöŌōŎŏŐőƠơǑǒǪǫǬǭȌȍȎȏȪȫȬȭȮȯȰȱṌṍṎṏṐṑṒṓỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợØøǾǿŒœ',
  p: 'ṔṕṖṗ',
  r: 'ŔŕŖŗŘřȐȑȒȓṘṙṚṛṜṝṞṟ',
  s: 'ŚśŜŝŞşŠšȘșṠṡṢṣṤṥṦṧṨṩßẞſ',
  t: 'ŢţŤťȚțṪṫṬṭṮṯṰṱẗŦŧ',
  u: 'ÙÚÛÜùúûüŨũŪūŬŭŮůŰűŲųƯưǓǔǕǖǗǘǙǚǛǜȔȕȖȗṲṳṴṵṶṷṸṹṺṻỤụỦủỨứỪừỬửỮữỰự',
  v: 'ṼṽṾṿ',
  w: 'ŴŵẀẁẂẃẄẅẆẇẈẉẘ',
  x: 'ẊẋẌẍ',
  y: 'ÝýÿŶŷŸȲȳẎẏẙỲỳỴỵỶỷỸỹ',
  z: 'ŹźŻżŽžẐẑẒẓẔẕ',
  // Not an accent: Σ lower-cases to σ or ς by where it falls in a word, and the database does that or doesn't by how
  // it was set up. One σ for all three keeps the phone, the server and every database the same.
  σ: 'Σς',
};

/** What `translate` replaces, in order. Copied into `private.search_fold`. */
export const FOLD_FROM: string = Object.values(FOLDS_TO).join('');

/** What each letter of `FOLD_FROM` becomes, letter for letter. Copied into `private.search_fold`. */
export const FOLD_TO: string = Object.entries(FOLDS_TO)
  .map(([to, from]) => to.repeat([...from].length))
  .join('');

// Every letter `FOLD_TO` holds is one UTF-16 unit, so it reads by index.
const FOLD = new Map([...FOLD_FROM].map((from, i) => [from, FOLD_TO[i]!]));

/**
 * A text as search compares it: accents folded by the map, then each character lower-cased on its own, so nothing
 * depends on the letters around it and the length never changes. `private.search_fold` gives the same text.
 */
export function fold(text: string): string {
  let out = '';
  for (const ch of text) out += (FOLD.get(ch) ?? ch).toLowerCase();
  return out;
}
