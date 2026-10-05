/**
 * Where this build signs in and saves, written in by scripts/build.mjs: HandsFreeOS itself unless the build was
 * pointed elsewhere (README.md, "Point it at your own computer"). The sign-in key is public, like the web app's, and
 * still never kept in the repo: a build without one reads pages and doesn't sign in.
 */
export interface HfosConfig {
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
}

declare const __HFOS_CONFIG__: HfosConfig | undefined;

export const config: HfosConfig =
  typeof __HFOS_CONFIG__ === 'undefined'
    ? { apiUrl: '', webUrl: '', supabaseUrl: '', supabasePublishableKey: '' }
    : __HFOS_CONFIG__;

/** Whether this build knows how to sign in to HandsFreeOS. */
export function canSignIn(): boolean {
  return Boolean(config.apiUrl && config.supabaseUrl && config.supabasePublishableKey);
}
