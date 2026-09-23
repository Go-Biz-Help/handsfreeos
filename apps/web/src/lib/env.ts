function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set (run \`pnpm env:local\`)`);
  return value;
}

/** Publishable values only. The web app never holds a Supabase secret key or a database URL. */
export const publicEnv = {
  supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabasePublishableKey: required(
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  ),
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, ''),
  /**
   * The app's own address, for telling a request that arrived on a business's own domain apart from one that
   * arrived on ours (M17). Only the host part is ever read.
   */
  appUrlForHost: (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  /** The worker's HTTP server: number search now, voice tokens and mailbox sign-in later. */
  workerUrl: (process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, ''),
  passkeysEnabled: process.env.NEXT_PUBLIC_PASSKEYS_ENABLED !== 'false',
  /** Connect Gmail opens up once Google finishes its security review of HandsFreeOS. */
  gmailEnabled: process.env.NEXT_PUBLIC_GMAIL_ENABLED === 'true',
  /**
   * M18: the browser key for Google Maps (restricted to our domains), for service areas by distance or drawn on
   * a map. Without it only ZIP areas are offered.
   */
  googleMapsBrowserKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY || null,
};
