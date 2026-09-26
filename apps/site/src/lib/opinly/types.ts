/**
 * The shapes the Opinly content API answers with, copied from https://sdk.opinly.ai/v1/openapi.json.
 *
 * Written out by hand rather than generated: the site uses eight read endpoints and a dozen fields, and a code
 * generator plus its output would be the largest thing in the blog. If Opinly adds a field we need, add it here.
 */

/** A picture on a post card or an author. `fileKey` is a path on Opinly's CDN (see `imageUrl`). */
export interface OpinlyImage {
  readonly fileKey: string | null;
  readonly alt: string | null;
  readonly title: string | null;
  readonly caption: string | null;
}

/** The same picture as it arrives on a full post, where the alt text is called `altText`. */
export interface OpinlyPostImage {
  readonly fileKey: string | null;
  readonly altText: string | null;
  readonly title: string | null;
  readonly caption: string | null;
}

export interface OpinlyPostCategory {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
}

export interface OpinlyPostAuthor {
  readonly name: string;
  readonly slug: string;
  readonly fileKey: string | null;
  readonly bio: string | null;
}

export interface OpinlyTagRef {
  readonly slug: string;
  readonly name: string;
}

/** The light version of a post that lists are made of. */
export interface OpinlyPost {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly firstPublishedAt: string;
  readonly lastPublishedAt: string;
  readonly image: OpinlyImage | null;
  readonly category: OpinlyPostCategory | null;
  readonly author: OpinlyPostAuthor | null;
  readonly tags: readonly OpinlyTagRef[];
}

export interface OpinlyPostList {
  readonly data: readonly OpinlyPost[];
  readonly has_more: boolean;
  /** Opaque. Passed back as `?cursor=` for the next page; null on the last one. */
  readonly next_cursor: string | null;
}

/** A post body: Tiptap (ProseMirror) JSON, not HTML. `render.tsx` turns it into elements. */
export interface OpinlyNode {
  readonly type?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: readonly OpinlyMark[];
  readonly text?: string;
  readonly content?: readonly OpinlyNode[];
}

export interface OpinlyMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface OpinlyFaq {
  readonly question: string;
  readonly answer: string;
}

export interface OpinlyFullPost {
  readonly content: OpinlyNode;
  readonly title: string;
  readonly slug: string;
  readonly description: string;
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  /** The hero picture. */
  readonly titleFile: OpinlyPostImage | null;
  readonly images: readonly OpinlyPostImage[];
  readonly firstPublishedAt: string;
  readonly modifiedAt: string;
  readonly author: OpinlyPostAuthor | null;
  readonly faqs: readonly OpinlyFaq[] | null;
  readonly category: OpinlyPostCategory | null;
  readonly tags: readonly OpinlyTagRef[];
}

export type OpinlyRouteType = 'home' | 'post' | 'category' | 'author' | 'tag';

/** One addressable page, from `/v1/content/routes` and from the webhook alike. The slug is bare. */
export interface OpinlyRoute {
  readonly type: OpinlyRouteType;
  readonly slug: string;
  readonly lastModified: string;
}

export interface OpinlyCategory {
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly imageUrl: string | null;
  /** Up to five of its latest posts. */
  readonly posts: readonly OpinlyPost[];
}

export interface OpinlyTag {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly postCount: number;
}

export interface OpinlyAuthor {
  readonly name: string;
  readonly slug: string;
  readonly image: OpinlyImage | null;
  readonly bio: string | null;
  readonly posts: readonly OpinlyPost[];
}

export interface OpinlyAuthors {
  readonly type: 'authors';
  readonly data: readonly OpinlyAuthor[];
}

export type OpinlyAuthorPage =
  | { readonly type: 'author'; readonly data: OpinlyAuthor }
  | { readonly type: 'not-found'; readonly data: null };

export interface OpinlyRssItem {
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly date: string;
  readonly categories?: readonly string[];
}
