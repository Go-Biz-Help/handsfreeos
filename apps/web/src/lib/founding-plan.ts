/**
 * Picking a founding spot straight after signing up (20261027012700): first come, first served, $497 a year or $97 a
 * month, paid before the business is set up. A business made while spots are on sale (`needsPlan`) is sent to the
 * plan page from its setup and from the app, until it holds one.
 */

/**
 * The plan page, with the spot the website's button named when there was one, and a trial or discount code to fill in
 * (a practice offer link's, 20261027027500).
 */
export const foundingPlanHref = (
  workspaceId: string,
  wanted?: string | null,
  code?: string | null,
): string => {
  const query = new URLSearchParams({
    ...(wanted ? { plan: wanted } : {}),
    ...(code ? { code } : {}),
  }).toString();
  return `/onboarding/${workspaceId}/plan${query ? `?${query}` : ''}`;
};

/** The website's buttons say which spot they're for: `?plan=yearly` or `?plan=monthly`. Anything else is nothing. */
export const wantedPlan = (value: unknown): 'yearly' | 'monthly' | null =>
  value === 'yearly' || value === 'monthly' ? value : null;
