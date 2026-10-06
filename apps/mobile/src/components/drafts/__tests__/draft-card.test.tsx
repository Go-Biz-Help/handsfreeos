import { teammateDraftOf, type TeammateDraftRow } from '@hfos/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { DraftCard } from '../draft-card';
import type { DraftDecision } from '../use-draft-decision';

/**
 * The teammate's draft card on the phone (round seven, board 98): what it asks for with an add-on, approved or
 * rejected by someone on the record it's about, and a reply an add-on's check held, with what was found.
 */

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-10-05T20:20:00.000Z');

const row = (over: Partial<TeammateDraftRow>): TeammateDraftRow => ({
  id: 'd1',
  teammate_id: 't1',
  teammate_name: 'Ava',
  conversation_id: 'c1',
  channel: 'sms',
  person_id: 'p1',
  first_name: 'Dana',
  last_name: 'Reyes',
  lead_id: null,
  kind: 'reply',
  status: 'pending',
  preview: null,
  edits: null,
  expires_at: '2026-10-06T20:20:00.000Z',
  created_at: '2026-10-05T20:19:00.000Z',
  ...over,
});

const ASK = JSON.stringify({
  message: { channel: 'sms', body: '412 Oak St is on your list now.', subject: null },
  actions: [],
  discount: null,
  ask: {
    addonId: 'realestate',
    addonName: 'Real Estate Agent',
    operation: 'realestate.home.add',
    tool: 'realestate_ask_add_home',
    input: { address: '412 Oak St' },
    recordId: 'r1',
    summary: 'Add 412 Oak St to Dana’s homes',
  },
});

const HELD = JSON.stringify({
  message: {
    channel: 'sms',
    body: 'It’s a quiet street, and the area has good schools.',
    subject: null,
  },
  actions: [],
  discount: null,
  flags: [
    {
      addonId: 'realestate',
      addonName: 'Real Estate Agent',
      message: 'Fair housing: “good schools”.',
    },
  ],
});

function decisionOf(r: TeammateDraftRow): DraftDecision & { approve: jest.Mock } {
  return {
    draft: teammateDraftOf(r, { canManage: false }),
    mode: 'view',
    setMode: jest.fn(),
    body: '',
    setBody: jest.fn(),
    subject: '',
    setSubject: jest.fn(),
    reason: '',
    setReason: jest.fn(),
    busy: null,
    blank: false,
    approve: jest.fn(),
    sendEdit: jest.fn(),
    reject: jest.fn(),
    cancelEdit: jest.fn(),
  } as DraftDecision & { approve: jest.Mock };
}

describe('the teammate’s drafts on the phone', () => {
  it('shows what it asks for and what approving does, for someone on its record', async () => {
    const d = decisionOf(row({ kind: 'ask', preview: ASK, record_name: 'Reyes home search' }));
    await render(<DraftCard d={d} timeZone={TZ} now={NOW} />);
    expect(screen.getByText('Ava asks · Real Estate Agent')).toBeTruthy();
    expect(screen.getByText('Add 412 Oak St to Dana’s homes')).toBeTruthy();
    expect(
      screen.getByText(
        'Approving does it as you, then Dana gets: “412 Oak St is on your list now.”',
      ),
    ).toBeTruthy();
    // The message waits for the ask; it isn't shown as a reply.
    expect(screen.queryByTestId('draft-text')).toBeNull();
    expect(screen.queryByText('Passed the safety check')).toBeNull();
    await fireEvent.press(screen.getByTestId('draft-approve'));
    expect(d.approve).toHaveBeenCalled();
  });

  it('says who decides an ask when the record isn’t on this phone', async () => {
    const d = decisionOf(row({ kind: 'ask', preview: ASK, record_name: null }));
    await render(<DraftCard d={d} timeZone={TZ} now={NOW} />);
    expect(screen.getByTestId('draft-read-only')).toBeTruthy();
    expect(
      screen.getByText('Only someone who works the record it’s about can decide it.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('draft-approve')).toBeNull();
  });

  it('holds a reply an add-on’s check flagged, with what it found', async () => {
    const d = decisionOf(row({ preview: HELD }));
    await render(<DraftCard d={d} timeZone={TZ} now={NOW} />);
    expect(screen.getByText('Held for you · Ava’s reply')).toBeTruthy();
    expect(screen.getByTestId('draft-text')).toBeTruthy();
    expect(screen.getByTestId('draft-flags')).toBeTruthy();
    expect(screen.getByText('Ava answers on its own, but this reply waits for you')).toBeTruthy();
    expect(screen.getByText('Fair housing: “good schools”.')).toBeTruthy();
    expect(screen.getByText('Send as it is')).toBeTruthy();
  });
});
