/**
 * Christina's recruiting funnel (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md §5), as a definition over a
 * pipeline's stage ids: the scenario the funnel tests share.
 */
import { FunnelDefinition, type FunnelDefinitionInput } from '../src/funnels/definition';

/** Her pipeline, in order: the stages she'd make for it. */
export const RECRUITING_STAGES = [
  { key: 'new', name: 'New lead', kind: 'open' },
  { key: 'funnel', name: 'In the funnel', kind: 'open' },
  { key: 'booked', name: 'Booked', kind: 'open' },
  { key: 'at', name: 'At the presentation', kind: 'open' },
  { key: 'after', name: 'After', kind: 'open' },
  { key: 'missed', name: 'Missed', kind: 'open' },
  { key: 'interested', name: 'Interested', kind: 'open' },
  { key: 'call', name: 'Three-way call', kind: 'won' },
  { key: 'out', name: 'Out', kind: 'lost' },
] as const;
export type RecruitingKey = (typeof RECRUITING_STAGES)[number]['key'];

export function christinaFunnel(
  id: Readonly<Record<RecruitingKey, string>>,
  over: Partial<FunnelDefinitionInput> = {},
): FunnelDefinition {
  return FunnelDefinition.parse({
    entry: { rules: [{ id: 'rnewlead', kind: 'new_lead' }], byHand: true, aiSuggests: true },
    approval: 'send',
    stages: [
      {
        stageId: id.new,
        goal: 'Get them to open their personal link',
        moves: [{ id: 'vopened', kind: 'event', event: 'form.submitted', to: id.funnel }],
        messages: [
          {
            id: 'mlink',
            when: { kind: 'arrive', minutes: 0 },
            wording: 'exact',
            text: 'Hi {first_name}! Here’s your link to get started: {join_link}',
          },
        ],
      },
      {
        stageId: id.funnel,
        goal: 'Get them to book a presentation',
        moves: [
          { id: 'vbooked', kind: 'event', event: 'appointment.booked', to: id.booked },
          { id: 'vquiet3', kind: 'quiet', minutes: 3 * 24 * 60, to: id.out },
        ],
        messages: [
          {
            id: 'mstopped',
            when: { kind: 'arrive', minutes: 30 },
            onlyIf: { has: true, event: 'form.stopped' },
            text: 'Nudge them back to where they left off in the form.',
          },
        ],
      },
      {
        stageId: id.booked,
        goal: 'Get them to the presentation',
        moves: [
          { id: 'vjoined', kind: 'event', event: 'attendee.joined', to: id.at },
          { id: 'vnoshow', kind: 'event', event: 'attendee.no_show', to: id.missed },
        ],
        messages: [
          {
            id: 'mdaybefore',
            when: { kind: 'booking_day', daysBefore: 1, at: '18:00' },
            wording: 'exact',
            text: 'See you tomorrow at {session_time}! Your link: {join_link}',
          },
          {
            id: 'mhour',
            when: { kind: 'booking', minutes: -60 },
            text: 'Remind them it starts in an hour, with their Join link.',
          },
          {
            id: 'mlogon',
            when: { kind: 'booking', minutes: 5 },
            onlyIf: { has: false, event: 'attendee.joined' },
            wording: 'exact',
            text: 'Were you able to log on, {first_name}?',
          },
        ],
      },
      {
        stageId: id.at,
        goal: 'Keep them on the presentation',
        moves: [{ id: 'vended', kind: 'event', event: 'attendee.attended', to: id.after }],
        messages: [
          {
            id: 'mhear',
            when: { kind: 'arrive', minutes: 10 },
            wording: 'exact',
            text: 'Can you hear the presenter okay?',
          },
        ],
      },
      {
        stageId: id.after,
        goal: 'Find out if they’re in',
        knows: 'The comp plan pays weekly. Licensing help is free.',
        moves: [
          { id: 'vyes', kind: 'reply', says: 'they say they’re interested', to: id.interested },
          { id: 'vnope', kind: 'reply', says: 'they say no', to: id.out },
        ],
        messages: [
          {
            id: 'mcheck',
            when: { kind: 'arrive', minutes: 60 },
            text: 'Say you’ll check back with them to go over next steps.',
          },
        ],
      },
      {
        stageId: id.missed,
        goal: 'Get them booked again',
        moves: [
          { id: 'vrebook', kind: 'event', event: 'appointment.booked', to: id.booked },
          { id: 'vquiet7', kind: 'quiet', minutes: 7 * 24 * 60, to: id.out },
        ],
        messages: [
          {
            id: 'mpick',
            when: { kind: 'arrive', minutes: 0 },
            text: 'Send a link to pick another night.',
          },
          {
            id: 'mpick2',
            when: { kind: 'arrive', minutes: 2 * 24 * 60 },
            text: 'Send the link to pick another night again.',
          },
        ],
      },
      {
        stageId: id.interested,
        goal: 'Get the three-way call booked',
        moves: [{ id: 'vthree', kind: 'event', event: 'appointment.booked', to: id.call }],
        messages: [
          {
            id: 'mleader',
            when: { kind: 'arrive', minutes: 0 },
            text: 'Send the Business Expansion Leader’s booking link.',
          },
        ],
        handOff: true,
      },
      { stageId: id.call },
      { stageId: id.out },
    ],
    ...over,
  });
}
