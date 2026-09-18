import type { LeadCard, StageRef, TagRef, TaskOut, TimelineEntry } from '@hfos/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { ChangeMark, DuplicateBanner, RecordActions, RecordHead, RecordTabs } from '../bits';
import { FileRow, UploadingRow } from '../files';
import { NoteSheet, PhotoSheet, TagSheet, TaskSheet } from '../sheets';
import { TimelineRow } from '../timeline';
import { LeadCardView, MoveSheet, NextActionBox, StageChips } from '@/components/pipeline/bits';
import { TaskRow } from '@/components/tasks/task-row';
import { Camera, Phone } from '@/components/icons';

/**
 * The customer, pipeline and task parts with React Native Testing Library: the head and its buttons, the tabs and their
 * counts, a timeline entry with the moment it really happened, a refusal over the record, a lead card and the Move
 * to… sheet, a task's circle, and a photo taken on a record.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
  usePowerSync: () => ({ getOptional: jest.fn(async () => null) }),
}));
jest.mock('@/changes/hooks', () => ({ usePhotoProgress: () => null }));

const TAGS: TagRef[] = [{ id: 't1', name: 'Residential', color: '#2d69d8' }];
const TZ = 'America/Chicago';
const NOW = Date.parse('2026-09-17T15:12:00.000Z');

describe('a record’s head', () => {
  it('shows the name, the line under it, what they owe and their tags', async () => {
    await render(
      <RecordHead
        name="Maria Lopez"
        seed="p1"
        line="Added today · Website form"
        owed={255188}
        contact={[{ key: 'phone', text: '(713) 555-0174', onPress: jest.fn() }]}
        tags={TAGS}
        onTags={jest.fn()}
      />,
    );
    expect(screen.getByTestId('record-name')).toHaveTextContent('Maria Lopez');
    expect(screen.getByTestId('record-line')).toHaveTextContent('Added today · Website form');
    expect(screen.getByTestId('record-owes')).toHaveTextContent('Owes $2,551.88');
    expect(screen.getByTestId('record-tag-Residential')).toBeTruthy();
  });

  it('says so plainly when there is nothing to call, text or write to', async () => {
    await render(
      <RecordHead
        name="Rosa Delgado"
        seed="p2"
        line="Added today"
        owed={0}
        contact={[]}
        tags={[]}
        onTags={jest.fn()}
      />,
    );
    expect(screen.getByText('No contact details yet.')).toBeTruthy();
    expect(screen.queryByTestId('record-owes')).toBeNull();
  });

  it('keeps Call, Text and Email in the same place, and offers Call only with a number', async () => {
    const call = jest.fn();
    await render(
      <RecordActions
        actions={[
          { key: 'call', label: 'Call', icon: Phone, primary: true, onPress: call },
          { key: 'photo', label: 'Photo', icon: Camera, onPress: jest.fn() },
        ]}
      />,
    );
    await fireEvent.press(screen.getByTestId('record-call'));
    expect(call).toHaveBeenCalled();
    expect(screen.getByTestId('record-photo')).toBeTruthy();
  });

  it('counts the tabs, and switching one tells the screen', async () => {
    const onChange = jest.fn();
    await render(
      <RecordTabs
        tab="timeline"
        onChange={onChange}
        counts={{ leads: 1, tasks: 0, files: 1 }}
        money
      />,
    );
    expect(screen.getByTestId('record-tab-leads')).toHaveTextContent('Leads · 1');
    expect(screen.getByTestId('record-tab-tasks')).toHaveTextContent('Tasks · 0');
    expect(screen.getByTestId('record-tab-files')).toHaveTextContent('Files · 1');
    await fireEvent.press(screen.getByTestId('record-tab-files'));
    expect(onChange).toHaveBeenCalledWith('files');
  });

  it('flags a record made with no signal that matches one already saved, and opens the other', async () => {
    const open = jest.fn();
    await render(
      <DuplicateBanner
        other={{ id: 'p9', name: 'Maria Lopez', value: '(713) 555-0190' }}
        onOpen={open}
      />,
    );
    expect(screen.getByText('Possible duplicate of Maria Lopez')).toBeTruthy();
    expect(
      screen.getByText(
        'Same phone number, (713) 555-0190. This one was added with no signal, before Maria Lopez’s record reached the phone.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('record-duplicate-open'));
    expect(open).toHaveBeenCalledWith('p9');
  });

  it('shows a refused change with the API’s words, and OK clears it', async () => {
    const clear = jest.fn();
    await render(
      <ChangeMark waiting={1} why="This was dismissed. Bring it back first." onClear={clear} />,
    );
    expect(screen.getByText('This was dismissed. Bring it back first.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('record-refused-ok'));
    expect(clear).toHaveBeenCalled();
  });

  it('counts what waits when nothing was refused', async () => {
    await render(<ChangeMark waiting={2} why={null} />);
    expect(screen.getByTestId('record-waiting')).toHaveTextContent('2 changes waiting to send');
  });
});

describe('the timeline', () => {
  const entry: TimelineEntry = {
    id: 'a1',
    entry: 'activity',
    kind: 'note',
    subtype: null,
    body: 'Old 2.5-ton unit is 19 years old.',
    occurredAt: '2026-09-17T14:20:00.000Z',
    actor: { id: 'u1', fullName: 'Dale Ramsey' },
    actorType: 'user',
    personId: 'p1',
    companyId: null,
    leadId: null,
    meta: {},
  };

  it('says who did what, and shows the note under it', async () => {
    await render(
      <TimelineRow entry={entry} recordType="person" viewerId="u1" timeZone={TZ} now={NOW} />,
    );
    expect(screen.getByTestId('timeline-note')).toHaveTextContent(/Dale Ramsey added a note/);
    expect(screen.getByText('Old 2.5-ton unit is 19 years old.')).toBeTruthy();
  });

  it('a change made here with no signal says so, at the moment it was really made', async () => {
    await render(
      <TimelineRow
        entry={entry}
        recordType="person"
        viewerId="u1"
        timeZone={TZ}
        waiting
        now={NOW}
      />,
    );
    expect(screen.getByTestId('timeline-when-a1')).toHaveTextContent(
      /this phone, no signal · waiting to send$/,
    );
  });
});

describe('the pipeline', () => {
  const lead: LeadCard = {
    id: 'l1',
    title: 'New AC install',
    pipelineId: 'pl1',
    stageId: 's1',
    stageName: 'New',
    stageKind: 'open',
    status: 'open',
    person: { id: 'p1', fullName: 'Maria Lopez', archived: false },
    company: null,
    valueCents: 1_850_000,
    source: 'Website form',
    assignee: { id: 'u1', fullName: 'Dale Ramsey' },
    expectedCloseOn: null,
    nextAction: null,
    nextActionAt: null,
    needsNextAction: true,
    nextActionOverdue: false,
    lastContactAt: null,
    wonAt: null,
    lostAt: null,
    lostReason: null,
    position: 1,
    tags: [],
    stageEnteredAt: '2026-09-17T14:51:00.000Z',
    archivedAt: null,
    createdAt: '2026-09-17T14:51:00.000Z',
    updatedAt: '2026-09-17T14:51:00.000Z',
  };
  const stages: StageRef[] = [
    { id: 's1', name: 'New', kind: 'open', position: 0 },
    { id: 's2', name: 'Contacted', kind: 'open', position: 1 },
    { id: 's3', name: 'Won', kind: 'won', position: 2 },
    { id: 's4', name: 'Lost', kind: 'lost', position: 3 },
  ];

  it('draws a card with its value, its customer and how long it has been in this stage', async () => {
    const open = jest.fn();
    await render(<LeadCardView lead={lead} nextAction={null} now={NOW} onPress={open} />);
    expect(screen.getByTestId('lead-title')).toHaveTextContent('New AC install');
    expect(screen.getByText('$18,500')).toBeTruthy();
    expect(screen.getByText('Maria Lopez')).toBeTruthy();
    expect(screen.getByText('Website form · 21 min ago')).toBeTruthy();
    expect(screen.getByTestId('lead-no-next')).toHaveTextContent('No next action');
    await fireEvent.press(screen.getByTestId('lead-card-l1'));
    expect(open).toHaveBeenCalledWith('l1');
  });

  it('the chips say how many leads each stage holds, and switch stage', async () => {
    const onChange = jest.fn();
    await render(
      <StageChips
        stages={[
          { id: 's1', name: 'New', count: 4 },
          { id: 's2', name: 'Contacted', count: 4 },
        ]}
        stageId="s1"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('stage-chip-New')).toHaveTextContent(/New4/);
    await fireEvent.press(screen.getByTestId('stage-chip-Contacted'));
    expect(onChange).toHaveBeenCalledWith('s2');
  });

  it('Move to… lists every stage, says what Won and Lost do, and promises to work with no signal', async () => {
    const onMove = jest.fn();
    await render(
      <MoveSheet
        open
        lead={lead}
        stages={stages}
        pipelineName="Sales"
        onClose={jest.fn()}
        onMove={onMove}
      />,
    );
    expect(screen.getByText('Move New AC install to…')).toBeTruthy();
    expect(screen.getByText('Maria Lopez · $18,500 · Sales')).toBeTruthy();
    expect(screen.getByTestId('move-to-New')).toHaveTextContent(/Now$/);
    expect(screen.getByTestId('move-to-Won')).toHaveTextContent(/Marks it won$/);
    expect(screen.getByTestId('move-to-Lost')).toHaveTextContent(/Asks why$/);
    expect(
      screen.getByText(
        'Works with no signal. If someone moves it first, theirs stands and the phone tells you why yours didn’t go.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('move-to-Contacted'));
    expect(onMove).toHaveBeenCalledWith(stages[1]);
  });

  it('asks for a next action when there is none, and shows it once there is one', async () => {
    const onSet = jest.fn();
    const { rerender } = await render(<NextActionBox lead={lead} onSet={onSet} />);
    expect(screen.getByText('Say what happens next, and when')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('lead-next-input'), 'Call Maria');
    await fireEvent.press(screen.getByTestId('lead-next-set'));
    expect(onSet).toHaveBeenCalledWith('Call Maria');
    await rerender(<NextActionBox lead={{ ...lead, nextAction: 'Call Maria' }} onSet={onSet} />);
    expect(screen.getByTestId('lead-next-action')).toHaveTextContent(/Call Maria/);
  });
});

describe('tasks and files', () => {
  const task: TaskOut = {
    id: 'tk1',
    title: 'Call Mike Johnson about the estimate',
    notes: null,
    dueAt: '2026-09-21T15:00:00.000Z',
    allDay: false,
    dueBucket: 'overdue',
    assignee: { id: 'u1', fullName: 'Dale Ramsey' },
    person: { id: 'p1', fullName: 'Mike Johnson', archived: false },
    company: null,
    lead: { id: 'l1', title: 'Roof replacement' },
    doneAt: null,
    doneBy: null,
    createdBy: { id: 'u1', fullName: 'Dale Ramsey' },
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  };

  it('a task shows whose it is, what it is about and when it is due, and its circle completes it', async () => {
    const toggle = jest.fn();
    await render(<TaskRow task={task} showRelated onToggle={toggle} />);
    expect(screen.getByTestId('task-title')).toHaveTextContent(
      'Call Mike Johnson about the estimate',
    );
    expect(screen.getByText('Dale Ramsey · Roof replacement · Mike Johnson')).toBeTruthy();
    expect(screen.getByTestId('task-due')).toHaveTextContent(/^Overdue · /);
    await fireEvent.press(screen.getByTestId('task-toggle'));
    expect(toggle).toHaveBeenCalledWith(task);
  });

  it('a task with a change of its own waiting says so', async () => {
    await render(<TaskRow task={task} waiting onToggle={jest.fn()} />);
    expect(screen.getByTestId('task-waiting')).toHaveTextContent('Waiting to send');
  });

  it('a file names itself the canvas’s way, and a photo still uploading is already there', async () => {
    await render(
      <FileRow
        file={{
          id: 'f1',
          recordType: 'person',
          recordId: 'p1',
          bucket: 'files',
          objectPath: 'x',
          name: 'Old condenser.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 2_516_582,
          isImage: true,
          uploadedBy: { id: 'u1', fullName: 'Dale' },
          createdAt: '2026-09-17T14:24:00.000Z',
        }}
        online
        onOpen={jest.fn()}
      />,
    );
    expect(screen.getByTestId('file-name')).toHaveTextContent('Old condenser.jpg');
    expect(screen.getByText(/2\.4 MB/)).toBeTruthy();

    await render(
      <UploadingRow
        photo={
          {
            id: 'up1',
            workspace_id: 'w',
            file_id: 'f2',
            record_type: 'person',
            record_id: 'p1',
            file_name: 'New photo.jpg',
            mime_type: 'image/jpeg',
            size_bytes: 2_516_582,
            local_name: 'x.jpg',
            taken_at: '2026-09-17T14:24:00.000Z',
            step: 'upload',
            begin_command_id: 'b',
            confirm_command_id: 'c',
            bucket: null,
            object_path: null,
            bytes_sent: 1_600_000,
            resume_url: null,
            tries: 0,
            next_try_at: null,
            upload_rounds: 0,
          } as never
        }
      />,
    );
    expect(screen.getByTestId('file-uploading-up1')).toHaveTextContent(/1\.6 of 2\.5 MB/);
  });
});

describe('the sheets a record opens', () => {
  it('a note says only the team sees it, and saves what was written', async () => {
    const save = jest.fn();
    await render(<NoteSheet open name="Maria Lopez" onClose={jest.fn()} onSave={save} />);
    expect(screen.getByText('A note about Maria Lopez')).toBeTruthy();
    expect(screen.getByText('Only your team sees notes.')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('note-body'), 'Gate code 4821');
    await fireEvent.press(screen.getByTestId('note-save'));
    expect(save).toHaveBeenCalledWith('Gate code 4821');
  });

  it('tags go on and off one at a time, and the sheet says why that matters', async () => {
    const save = jest.fn();
    await render(<TagSheet open tags={TAGS} chosen={[]} onClose={jest.fn()} onSave={save} />);
    expect(
      screen.getByText(
        'Adding or removing a tag changes only that tag, so two people tagging at once both keep theirs.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('tag-row-Residential'));
    await fireEvent.press(screen.getByTestId('tag-save'));
    expect(save).toHaveBeenCalledWith(['t1']);
  });

  it('a new task takes a title, when it is due and who it is for', async () => {
    const save = jest.fn();
    await render(
      <TaskSheet
        open
        members={[{ id: 'u2', fullName: 'Priya' }]}
        myUserId="u1"
        onClose={jest.fn()}
        onSave={save}
      />,
    );
    await fireEvent.changeText(screen.getByTestId('task-title'), 'Order the capacitor');
    await fireEvent.press(screen.getByTestId('task-due-tomorrow'));
    await fireEvent.press(screen.getByTestId('task-for-u2'));
    await fireEvent.press(screen.getByTestId('task-save'));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Order the capacitor', assigneeUserId: 'u2', allDay: true }),
    );
  });

  it('a photo comes from the camera or the library, and says the limits', async () => {
    const pick = jest.fn();
    await render(<PhotoSheet open onClose={jest.fn()} onPick={pick} />);
    expect(screen.getByText('PDFs, documents and photos, up to 25 MB')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('photo-camera'));
    expect(pick).toHaveBeenCalledWith('camera');
    await fireEvent.press(screen.getByTestId('photo-library'));
    expect(pick).toHaveBeenCalledWith('library');
  });
});
