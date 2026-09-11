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
  passkeysEnabled: process.env.NEXT_PUBLIC_PASSKEYS_ENABLED !== 'false',
};
