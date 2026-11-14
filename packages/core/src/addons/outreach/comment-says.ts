/**
 * A comment says something real about the post it's under, or there's no comment (docs/outreach.md, decision 165; the
 * owner, 14 Nov 2026, on "That caption got me, so real" under a reel whose joke was in the video: "this comment feels
 * like a bot, it’s not about the post at all it just feels like some generic ai or automated comment you see all over
 * the internet, not good").
 *
 * The AI is given a post's words and nothing else: its caption, or what the network says its picture shows. Never the
 * picture, never the video. A post whose words lean on what it can't see ("It be like that 😂") left it nothing real
 * to say, and it said something anyway. Three things keep that from waiting for an OK:
 *
 * - **It's told what it has** (`POST_WORDS_ONLY`), and to write nothing when the words aren't enough.
 * - **It points at what it's about** (`COMMENT_ABOUT_ASK`): the few words of the post its comment reacts to, copied
 *   out. A warm-up comment whose words aren't in the post is about nothing in it, and goes (`aboutInPost`).
 * - **Filler goes** (`saysNothing`): a comment made of words that fit under any post ("so real", "this!", "love
 *   this", "facts"), or that talks about the caption instead of what it says.
 * - **Brochure words go** (`COMMENT_PLAIN_WORDS`, `brochureWords`; the owner, the same day, on "That countryside
 *   setting looks so charming": "using not very popular words like charming ... a man would say something more like,
 *   that’s nice! or looks dope!"). People type "nice", "dope" and "congrats" under a post, not "charming".
 *
 * And a comment never puts the owner in the other person's group when nothing says they're in it (./about-owner.ts,
 * `claimsTheSame`): the rule is the AI's, and this is the check behind it for the plainest ways of saying it.
 *
 * No comment is the right answer when there's nothing real to say: the like still went, and the next visit picks
 * another post. Browser-safe: the worker's checks, the prompts and the Test console read it.
 */

/** What a comment's AI is told it has of the post. */
export const POST_WORDS_ONLY =
  'Under <post> are only the post’s words: its caption, or what the network says its picture shows. You can’t see its picture or its video, so never write as if you had.';

/** What a comment's AI is asked beside its drafts: the post's own words it reacts to, for `aboutInPost`. */
export const COMMENT_ABOUT_ASK =
  'Also give, as about, the few words of the post that the comment is about, copied exactly as they are under <post>. Leave it empty when you write no drafts, and for anything that isn’t a comment.';

/**
 * The words a comment is made of: the ones people really type under a post, never a brochure's. The list of what to
 * leave out is checked too (`brochureWords`).
 */
export const COMMENT_PLAIN_WORDS =
  'Use the everyday words people really type in comments (nice, cool, dope, clean, solid, big, congrats, let’s go), the way the owner would say it out loud. Never a brochure’s or a greeting card’s words: charming, stunning, lovely, delightful, gorgeous, breathtaking, captivating, heartwarming, exquisite, picturesque, unforgettable, remarkable, inspiring, wonderful, magnificent, splendid, adorable, impeccable, vibrant, a testament.';

/** The most of a post's words the AI copies out as what its comment is about. */
export const ABOUT_MOST = 200;

/** Letters and numbers only, in lower case, one space apart: how two pieces of text are compared. */
const plain = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Words that carry nothing on their own: the little words of any sentence, and the ones a comment under any post is
 * made of ("so real", "love this", "facts", "it be like that", "that caption got me").
 */
const EMPTY_WORDS = new Set(
  [
    // The little words.
    'a an and are as at be been but by can did do does for from had has have he her his i if im in is it its ive just',
    'me my of oh ok okay on one or our she so than that thats the their them then there these they this those to too',
    'us was we were what when which who will with would ya yall you youre your yours',
    // What fits under any post.
    'absolutely accurate agree agreed always amazing awesome beautiful best big brilliant caption content cool crying',
    'damn dead definitely different energy everything exactly fact facts fantastic feel feels felt fire funny goals',
    'good got great haha hahaha hard here hilarious hit hits home honestly iconic incredible inspiring internet legend',
    'lit literally lmao lol louder love loved loving made mood more much needed nice omg perfect period post real',
    'really reel relatable right said same say share sharing so spot stop such thanks thank totally true truth very',
    'vibe vibes video way well win wins wow yep yes',
  ]
    .join(' ')
    .split(' '),
);

/** A comment about the post as a thing ("that caption got me") rather than about what it says. */
const ABOUT_THE_POST_ITSELF = /\bcaptions?\b/i;

/**
 * Whether a drafted comment says nothing: fewer than two words that could only belong under this post, or about the
 * caption rather than what it says. "That caption got me, so real", "This hits different" and "Love this for you" do;
 * "Congrats on the new shop" and "That kitchen came out so clean" don't.
 */
export function saysNothing(text: string): boolean {
  if (ABOUT_THE_POST_ITSELF.test(text)) return true;
  const real = plain(text)
    .split(' ')
    .filter((w) => w && !EMPTY_WORDS.has(w));
  return new Set(real).size < 2;
}

/**
 * Whether the words the AI said its comment is about are the post's own: found in it as they are, give or take
 * capitals, marks and emoji. Empty, or not there, and the comment is about nothing in the post.
 */
export function aboutInPost(about: string | null | undefined, post: string): boolean {
  const said = plain(about ?? '');
  return said.length > 0 && plain(post).includes(said);
}

/** Words no one types under a post (`COMMENT_PLAIN_WORDS`): a brochure's, or a greeting card's. */
const BROCHURE =
  /\b(?:charming|stunning|lovely|delightful|gorgeous|breathtaking|captivating|heartwarming|exquisite|picturesque|unforgettable|remarkable|inspiring|inspirational|wonderful|magnificent|splendid|adorable|impeccable|vibrant|testament)\b/i;

/** Whether a drafted comment uses a word people don't type under a post. */
export const brochureWords = (text: string): boolean => BROCHURE.test(text);

/**
 * The plainest ways a short comment puts its writer in the other person's group: "same", "same here" or "me too" as a
 * remark of its own (at the start, or after a comma or a full stop at the end), "as a fellow …", "I can relate" and
 * "been there". "Same energy as last year" isn't one.
 */
const THE_SAME = new RegExp(
  [
    String.raw`(?:^|[,.!?…]\s*)(?:same(?:\s+here)?|me\s+too|us\s+too|i\s+feel\s+(?:this|that|seen))[\s!.…\p{Extended_Pictographic}\u{FE0F}]*(?:$|[,.!?…])`,
    String.raw`\bas\s+a\s+fellow\b`,
    String.raw`\b(?:i|we)\s+can\s+(?:so\s+|totally\s+|really\s+)?relate\b`,
    String.raw`\b(?:i[’']?ve\s+|we[’']?ve\s+)?been\s+there\b`,
  ].join('|'),
  'iu',
);

/** Whether a drafted comment says its writer is, or has been through, the same as the person it's under. */
export const claimsTheSame = (text: string): boolean => THE_SAME.test(text.trim());

/**
 * The drafted comments that may wait for an OK (decision 165): none that says nothing and none in a brochure's words.
 * A warm-up comment is only ever a reaction to someone's own post, so there's none at all unless the AI could point at
 * the post's own words it reacts to, and none that claims the owner is the same as them when the owner hasn't said so
 * of themselves. (An expert comment speaks from the owner's own field, where "we've been there" is the business's to
 * say; the rule the AI is given covers it.)
 */
export function realComments(
  drafts: readonly string[],
  told: {
    /** The post's words, as the AI was given them. */
    readonly post: string;
    /** What the AI said the comment is about. */
    readonly about: string | null | undefined;
    /** A warm-up's comment (decision 161). */
    readonly warm: boolean;
    /** What the owner said of themselves (./about-owner.ts); empty with nothing said. */
    readonly aboutOwner?: string | null;
  },
): string[] {
  if (told.warm && !aboutInPost(told.about, told.post)) return [];
  const known = !!told.aboutOwner?.trim();
  return drafts.filter(
    (d) => !saysNothing(d) && !brochureWords(d) && (known || !told.warm || !claimsTheSame(d)),
  );
}
