import type { ProcessorMap } from '../deliveries';
import { onInboundText, onTextStatus } from './twilio-messaging';

/** `provider:kind` → processor for stored webhooks. Deliveries without one are marked ignored. */
export const processors: ProcessorMap = {
  'twilio:messaging.inbound': onInboundText,
  'twilio:messaging.status': onTextStatus,
};
