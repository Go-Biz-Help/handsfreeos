/**
 * The person's own safety, by asking (the owner's rules for check-ins): starting a check-in, adding time and checking
 * out change only their own check-in, so they run on their own. Asking for help tells their contacts at once, so it
 * never runs on its own: it waits on a card that says who is told, and its words first say to call 911 when they're
 * in danger. Their own safety contacts are theirs to change, on a card. Each runs the phone's own command, as them.
 *
 * Sharing where the phone is stays the phone's: only the phone in their hand knows where it is.
 */
import { z } from 'zod';
import { uuid } from '../schemas/common';
import { define, text, when, type AssistantTool } from './tool-kit';

export const safetyTools: readonly AssistantTool[] = [
  define({
    name: 'my_check_in',
    description:
      'The person’s own check-in, for when they’re alone at a customer’s place (the phone’s Check in, and its banner’s Check out and +15 min): start one with where they are and when they plan to leave, add time to the one open now, or check out of it. If they don’t check out by then, HandsFreeOS asks them, then tells their safety contacts where they were. Starting one checks them out of any still open. Only ever their own, never a teammate’s. Sharing where their phone is stays on the phone: Check in there with Share where I am on. If they say they’re in danger or need help now, use ask_for_help.',
    input: z.object({
      action: z.enum(['start', 'add_time', 'check_out']),
      place: text(300)
        .optional()
        .describe('start: where they are, the address or a few words their contacts would find'),
      until: when.optional().describe('start: when they plan to leave, within 12 hours'),
      appointmentId: uuid
        .optional()
        .describe('start: the visit it’s for, from todays_schedule, when it’s for one'),
      minutes: z
        .int()
        .min(5)
        .max(240)
        .optional()
        .describe('add_time: how many minutes to add, 5 to 240; 15 when left out'),
    }),
    autonomy: 'auto',
    permission: 'workspace.read',
  }),
  define({
    name: 'ask_for_help',
    description:
      'The person needs help now (the phone’s Help): their safety contacts are told at once where they are, in the app or by text and email, and again every 10 minutes for an hour until someone says they’re OK. If they may be in danger, first tell them to call 911 now: HandsFreeOS never calls 911. It uses the check-in open now; with none, pass where they are. The card says who is told before they agree. Only ever for the person asking.',
    input: z.object({
      place: text(300)
        .optional()
        .describe('Where they are, when they have no check-in open: the address or a few words'),
    }),
    autonomy: 'confirm',
    permission: 'workspace.read',
  }),
  define({
    name: 'manage_my_safety_contacts',
    description:
      'Who the person wants told if they don’t check out or ask for help (the phone’s More, then Settings, then My safety): add a teammate, add someone outside by name with a phone, an email or both, or remove one. Up to 5. Someone outside gets one text asking them to agree, and nothing until they reply OK; an email alone is never asked, so they’re never told. Read who is there now with read_safety_mine. Only ever the person’s own contacts: nobody sees or changes anyone else’s.',
    input: z.object({
      action: z.enum(['add_teammate', 'add_outside', 'remove']),
      contactUserId: uuid.optional().describe('add_teammate: the teammate, from list_team'),
      name: text(120).optional().describe('add_outside: their name'),
      phone: z.string().trim().max(40).optional().describe('add_outside: their cell'),
      email: z.email().max(320).optional().describe('add_outside: their email'),
      contactId: uuid.optional().describe('remove: the contact, from read_safety_mine'),
    }),
    autonomy: 'confirm',
    permission: 'workspace.read',
  }),
];
