import { ADDON_CATALOG } from '@hfos/core/server';
import { addonDeliveryProcessor } from '../addons/webhooks';
import { ADDON_WORKER_MODULES } from '../addons/modules';
import type { ProcessorMap } from '../deliveries';
import { foundingProcessors } from '../founding/checkout';
import { rcsBillingProcessors } from '../telephony/rcs-billing';
import { textingFeeProcessors } from '../telephony/texting-fees';
import { paymentProcessors } from '../money/processors';
import { workflowProcessors } from '../workflows/index';
import { onSupportInboundEmail } from '../support/inbound';
import { onEmailEvent, onInboundEmail } from './postmark';
import { onInboundText, onTextStatus } from './twilio-messaging';
import { META_DELIVERY_KIND } from '../social/events';
import { onMetaMessaging } from '../social/receive';
import {
  onCallStatus,
  onInboundCall,
  onLegStatus,
  onOutboundCall,
  onRecording,
  onScreened,
} from './twilio-voice';

/** `provider:kind` → processor for stored webhooks. Deliveries without one are marked ignored. */
export const processors: ProcessorMap = {
  'twilio:messaging.inbound': onInboundText,
  'twilio:messaging.status': onTextStatus,
  'twilio:voice.inbound': onInboundCall,
  'twilio:voice.outbound': onOutboundCall,
  'twilio:voice.status': onCallStatus,
  'twilio:voice.leg_status': onLegStatus,
  'twilio:voice.screened': onScreened,
  'twilio:voice.recording': onRecording,
  // Facebook Messenger and Instagram: a message, a tapped button, a visit from an ad, a receipt or an edit, one
  // event per delivery (social/).
  [`meta:${META_DELIVERY_KIND}`]: onMetaMessaging,
  'postmark:email.inbound': onInboundEmail,
  'postmark:email.event': onEmailEvent,
  // Mail to support@handsfreeos.com, filed as a ticket instead of into anybody's business (M13).
  'postmark:support.inbound': onSupportInboundEmail,
  // A workflow's inbound webhook: match or create the customer, start the run.
  ...workflowProcessors,
  // Stripe's and Square's events, under our own names for them (money/webhook-events.ts): a payment landing,
  // settling or refused, a refund, a dispute, a plan's cycle, an account changing, and a revoked sign-in.
  ...paymentProcessors,
  // Stripe about our own account (0093): a founding seat paid for, or its page lapsing.
  ...foundingProcessors,
  ...rcsBillingProcessors,
  ...textingFeeProcessors,
  // What the services add-ons connect to tell them (round five), each handed to its add-on's receiver.
  'addon:*': addonDeliveryProcessor(ADDON_CATALOG, ADDON_WORKER_MODULES),
};
