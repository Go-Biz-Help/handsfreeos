/**
 * What the side panel asks the background worker about HandsFreeOS, and what it answers. The background holds the
 * sign-in and makes every call to HandsFreeOS (./session.ts), so the panels open in different windows share one
 * sign-in and never refresh it twice at once. Both ends are the extension's own; Facebook's tabs never see these.
 */
import type { paths } from '@hfos/api-client';

type Body<P extends keyof paths> = paths[P] extends {
  post: { requestBody?: { content: { 'application/json': infer B } } };
}
  ? B
  : never;
type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

/** Social Outreach's look-up and saves (packages/core/src/addons/outreach/saves.ts), as the API takes and answers them. */
export type LookupInput = Body<'/v1/queries/outreach.lookup'>;
export type Lookup = Ok<'/v1/queries/outreach.lookup'>;
export type ProfileInput = Body<'/v1/commands/outreach.profile.save'>;
export type ProfileSaved = Ok<'/v1/commands/outreach.profile.save'>;
export type ChatInput = Body<'/v1/commands/outreach.chat.save'>;
export type ChatSaved = Ok<'/v1/commands/outreach.chat.save'>;
export type Me = Ok<'/v1/queries/account.me'>;

/** A business the extension can save to: Social Outreach is on there, and the person may use it. */
export interface Business {
  readonly id: string;
  readonly name: string;
}

export type Account =
  | {
      readonly signedIn: false;
      /** Whether this build was given HandsFreeOS's sign-in key (./config.ts). */
      readonly canSignIn: boolean;
      readonly webUrl: string;
    }
  | {
      readonly signedIn: true;
      readonly email: string;
      readonly name: string;
      readonly businesses: readonly Business[];
      /** The one it saves to: the person's pick, or the first. Null when there are none. */
      readonly businessId: string | null;
      readonly webUrl: string;
    };

export type HfosAsk =
  | { readonly type: 'hfos-account'; readonly fresh?: boolean }
  | { readonly type: 'hfos-send-code'; readonly email: string }
  | { readonly type: 'hfos-check-code'; readonly email: string; readonly code: string }
  | { readonly type: 'hfos-password'; readonly email: string; readonly password: string }
  | { readonly type: 'hfos-sign-out' }
  | { readonly type: 'hfos-pick'; readonly businessId: string }
  | { readonly type: 'hfos-lookup'; readonly input: LookupInput }
  | { readonly type: 'hfos-save-profile'; readonly input: ProfileInput }
  | { readonly type: 'hfos-save-chat'; readonly input: ChatInput };

/** What each ask answers with. */
export interface HfosValues {
  readonly 'hfos-account': Account;
  readonly 'hfos-send-code': null;
  readonly 'hfos-check-code': Account;
  readonly 'hfos-password': Account;
  readonly 'hfos-sign-out': Account;
  readonly 'hfos-pick': Account;
  readonly 'hfos-lookup': Lookup;
  readonly 'hfos-save-profile': ProfileSaved;
  readonly 'hfos-save-chat': ChatSaved;
}

export const HFOS_ASKS: ReadonlySet<string> = new Set<keyof HfosValues>([
  'hfos-account',
  'hfos-send-code',
  'hfos-check-code',
  'hfos-password',
  'hfos-sign-out',
  'hfos-pick',
  'hfos-lookup',
  'hfos-save-profile',
  'hfos-save-chat',
]);

/** Why something didn't work, in words for the person, and HandsFreeOS's rule when one refused it. */
export interface Problem {
  readonly message: string;
  readonly rule: string | null;
  readonly status: number | null;
  /** The sign-in ended, or the business can't be saved to now: the panel asks for the account again. */
  readonly recheck: boolean;
}

export type HfosAnswer<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: Problem };
