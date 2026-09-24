/**
 * Where a published form lives: `/f/<site>/<form>`, on HandsFreeOS's own address or the business's domain (M17).
 *
 * The shape is a promise to every customer already holding a link, so it is written once, here: the web's Share tab
 * and the phone's share sheet both build from it. Browser-safe.
 */
export const publicFormPath = (site: string, slug: string): string => `/f/${site}/${slug}`;
