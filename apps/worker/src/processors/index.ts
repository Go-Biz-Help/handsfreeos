import type { ProcessorMap } from '../deliveries';
import { onEmailEvent, onInboundEmail } from './postmark';
import { onInboundText, onTextStatus } from './twilio-messaging';
import {
  onCallStatus,
  onInboundCall,
  onLegStatus,
  onOutboundCall,
  onRecording,
  onScreened,
  onTranscription,
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
  'twilio:voice.transcription': onTranscription,
  'postmark:email.inbound': onInboundEmail,
  'postmark:email.event': onEmailEvent,
};
