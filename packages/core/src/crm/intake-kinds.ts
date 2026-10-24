/**
 * The ways a lead comes in (Lead intake, M14), and what each is called before a business renames it. Browser-safe:
 * a funnel's entry rules name them on the web and the phone.
 */
export type IntakeKind = (typeof INTAKE_KINDS)[number];
export const INTAKE_KINDS = [
  'text',
  'call',
  'email',
  'website_form',
  'api',
  'messenger',
  'instagram',
  'facebook_lead_ad',
  'indeed',
] as const;
/** What a channel is called before a business renames it. It is what its customers and leads are filed under. */
export const INTAKE_NAMES: Record<IntakeKind, string> = {
  text: 'Text message',
  call: 'Phone call',
  email: 'Email',
  website_form: 'Website form',
  api: 'Connected app',
  messenger: 'Facebook Messenger',
  instagram: 'Instagram',
  facebook_lead_ad: 'Facebook lead ad',
  indeed: 'Indeed',
};
