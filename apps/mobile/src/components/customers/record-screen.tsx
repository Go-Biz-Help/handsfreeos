import {
  fmtAt,
  leadOutcomeLine,
  money,
  RECORD_WORDS,
  TASK_WORDS,
  type FileOut,
  type LeadCard,
  type TagRef,
  type TaskOut,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { View } from 'react-native';

import { addNote, addPhoto, saveTags, type RecordRef } from '@/customers/actions';
import { TAGS_SQL } from '@/customers/queries';
import { useMembers } from '@/customers/names';
import type { NextVisit } from '@/customers/use-record';
import { addTask, completeTask, reopenTask } from '@/tasks/actions';
import { newId } from '@/changes';
import { takePhoto } from '@/changes/photo-device';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { StageBadge } from '@/components/pipeline/bits';
import { TaskRow } from '@/components/tasks/task-row';

import { ChangeMark, DetailRow, OwedCard, RecordTabs, type RecordTab } from './bits';
import { FileRow, FilesEmpty, UploadingRow } from './files';
import { NoteSheet, PhotoSheet, RECORD_SHEET_WORDS, TagSheet, TaskSheet } from './sheets';
import { TimelineEmpty, TimelineRow } from './timeline';
import type { RecordData } from '@/customers/use-record';

/**
 * Everything under a record's head: its tabs and what each shows, and the sheets its buttons open. A customer's page
 * and a company's share it, so the two never drift apart.
 */

export interface RecordBodyProps {
  readonly data: RecordData;
  readonly ref: RecordRef;
  readonly name: string;
  readonly kind: 'person' | 'company';
  readonly tags: readonly TagRef[];
  readonly tab: RecordTab;
  readonly onTab: (tab: RecordTab) => void;
  /** `key` tells two rows under the same label apart ("Work" twice); the label is the key otherwise. */
  readonly details: readonly {
    readonly key?: string;
    readonly label: string;
    readonly value: string | null;
  }[];
  readonly onEdit: () => void;
  readonly sheets: {
    readonly note: boolean;
    readonly tags: boolean;
    readonly task: boolean;
    readonly photo: boolean;
  };
  readonly onSheet: (which: 'note' | 'tags' | 'task' | 'photo', open: boolean) => void;
  readonly nextVisit: NextVisit | null;
}

/** "Not booked yet" for a time asked for with no signal, else "Fri, Sep 18 at 10:00 AM". */
export function nextVisitLine(visit: NextVisit, timeZone: string): string {
  return visit.notBookedYet ? 'Not booked yet' : fmtAt(visit.startsAt, timeZone);
}

export function RecordBody(props: RecordBodyProps) {
  const { data, tab } = props;
  const { business, me, userId } = useBusiness();
  const members = useMembers();
  const online = useNetwork().online;
  const { data: tagRows } = useQuery<{ id: string; name: string; color: string }>(TAGS_SQL, [
    business.id,
  ]);
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const refused =
    data.state.refused && data.state.refused.row.id !== dismissed ? data.state.refused : null;

  const openLead = (id: string) => router.push(businessHref(business.id, `leads/${id}`) as Href);

  const onPhoto = async (source: 'camera' | 'library') => {
    props.onSheet('photo', false);
    // An iPhone won't show the picker over a sheet that is closing (step 14, finding 2).
    await new Promise((r) => setTimeout(r, 450));
    const fileId = newId();
    const taken = await takePhoto({ userId, source, fileId });
    if (taken.kind === 'no-camera-permission') {
      toast.error(RECORD_SHEET_WORDS.photo.noCamera);
      return;
    }
    if (taken.kind !== 'kept') return;
    await addPhoto(props.ref, { ...taken.photo, fileId });
    toast.show(RECORD_SHEET_WORDS.photo.added);
  };

  return (
    <View className="gap-3">
      {refused ? (
        <ChangeMark waiting={0} why={refused.why} onClear={() => setDismissed(refused.row.id)} />
      ) : (
        <ChangeMark waiting={data.state.waiting} why={null} />
      )}
      <RecordTabs
        tab={tab}
        onChange={props.onTab}
        counts={{
          leads: data.leads.length,
          tasks: data.tasks.filter((t) => !t.doneAt).length,
          files: data.files.length + data.uploading.length,
        }}
        money={props.kind === 'person'}
      />

      {tab === 'timeline' ? (
        data.timeline.length === 0 ? (
          <TimelineEmpty />
        ) : (
          <Card className="px-3.5 py-3.5">
            {data.timeline.slice(0, 60).map((entry) => (
              <TimelineRow
                key={entry.id}
                entry={entry}
                recordType={props.kind}
                viewerId={me.user.id}
                timeZone={data.timeZone}
                subjectName={props.name}
                members={members}
                waiting={madeHere(data, entry.id)}
              />
            ))}
          </Card>
        )
      ) : null}

      {tab === 'money' ? (
        <OwedCard
          cents={data.balanceCents}
          onOpen={() =>
            void openWeb(`/app/w/${business.id}/customers/people/${props.ref.recordId}?tab=money`)
          }
        />
      ) : null}

      {tab === 'leads' ? (
        data.leads.length === 0 ? (
          <Card className="items-center gap-1 px-4 py-8" testID="record-leads-empty">
            <Text className="text-[15px] font-semibold">{RECORD_WORDS.noLeadsTitle}</Text>
            <Text className="text-center text-[13px] text-text-2">{RECORD_WORDS.noLeadsBody}</Text>
          </Card>
        ) : (
          <Card className="px-3.5 py-1" testID="record-leads">
            {data.leads.map((lead) => (
              <LeadRow key={lead.id} lead={lead} onPress={openLead} />
            ))}
          </Card>
        )
      ) : null}

      {tab === 'tasks' ? (
        <Card className="px-3.5 py-1" testID="record-tasks">
          {data.tasks.length === 0 ? (
            <View className="items-center gap-1 py-6">
              <Text className="text-[15px] font-semibold">{TASK_WORDS.emptyTitle}</Text>
              <Text className="text-center text-[13px] text-text-2">{RECORD_WORDS.tasksHint}</Text>
            </View>
          ) : (
            data.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggle={(t) => void toggleTask(business.id, t, me.user.id)}
              />
            ))
          )}
          <View className="py-2">
            <Button
              variant="secondary"
              size="sm"
              onPress={() => props.onSheet('task', true)}
              className="self-start"
              testID="record-new-task"
            >
              {TASK_WORDS.newTask}
            </Button>
          </View>
        </Card>
      ) : null}

      {tab === 'files' ? (
        data.files.length === 0 && data.uploading.length === 0 ? (
          <FilesEmpty onAdd={() => props.onSheet('photo', true)} />
        ) : (
          <Card className="px-3.5 py-1" testID="record-files">
            {data.uploading.map((photo) => (
              <UploadingRow key={photo.id} photo={photo} />
            ))}
            {data.files.map((file) => (
              <FileRow key={file.id} file={file} online={online} onOpen={openFile} />
            ))}
            <View className="py-2">
              <Button
                variant="secondary"
                size="sm"
                onPress={() => props.onSheet('photo', true)}
                className="self-start"
                testID="record-add-photo"
              >
                {RECORD_SHEET_WORDS.photo.title}
              </Button>
            </View>
          </Card>
        )
      ) : null}

      {tab === 'details' ? (
        <Card className="gap-1 px-3.5 py-2" testID="record-details">
          {props.details.map((d) => (
            <DetailRow key={d.key ?? d.label} label={d.label} value={d.value} />
          ))}
          <View className="py-2.5">
            <Button
              variant="secondary"
              size="sm"
              onPress={props.onEdit}
              className="self-start"
              testID="record-edit"
            >
              {RECORD_WORDS.edit}
            </Button>
          </View>
        </Card>
      ) : null}

      <NoteSheet
        open={props.sheets.note}
        name={props.name}
        onClose={() => props.onSheet('note', false)}
        onSave={async (body) => {
          await addNote(props.ref, body, me.user.id);
          toast.show(RECORD_SHEET_WORDS.note.saved);
          props.onTab('timeline');
        }}
      />
      <TagSheet
        open={props.sheets.tags}
        tags={tagRows}
        chosen={props.tags}
        onClose={() => props.onSheet('tags', false)}
        onSave={async (ids) => {
          const n = await saveTags(props.ref, props.tags, ids);
          if (n > 0) toast.show(n === 1 ? 'Tag saved.' : 'Tags saved.');
        }}
      />
      <TaskSheet
        open={props.sheets.task}
        members={members}
        myUserId={me.user.id}
        onClose={() => props.onSheet('task', false)}
        onSave={async (task) => {
          await addTask(
            business.id,
            {
              ...task,
              personId: props.kind === 'person' ? props.ref.recordId : null,
              companyId: props.kind === 'company' ? props.ref.recordId : null,
            },
            me.user.id,
          );
          toast.show(RECORD_SHEET_WORDS.task.saved);
          props.onTab('tasks');
        }}
      />
      <PhotoSheet
        open={props.sheets.photo}
        onClose={() => props.onSheet('photo', false)}
        onPick={(source) => void onPhoto(source)}
      />
    </View>
  );
}

/** A record's lead, in the list under its Leads tab. */
function LeadRow({ lead, onPress }: { lead: LeadCard; onPress: (id: string) => void }) {
  const outcome = leadOutcomeLine({
    status: lead.status,
    wonAt: lead.wonAt,
    lostAt: lead.lostAt,
    by: lead.assignee?.fullName ?? null,
  });
  return (
    <Button
      variant="ghost"
      onPress={() => onPress(lead.id)}
      className="min-h-14 flex-row items-center gap-3 border-b border-border px-0"
      testID={`record-lead-${lead.id}`}
    >
      <View className="min-w-0 flex-1 items-start gap-0.5">
        <Text className="text-[14.5px] font-medium">{lead.title}</Text>
        <Text className="text-[12px] text-text-3">
          {outcome ??
            `${money(lead.valueCents)} · ${lead.assignee?.fullName ?? RECORD_WORDS.unassigned}`}
        </Text>
      </View>
      <Text className="text-[13px] font-semibold">{money(lead.valueCents)}</Text>
      <StageBadge name={lead.stageName} kind={lead.stageKind} />
    </Button>
  );
}

function toggleTask(workspaceId: string, task: TaskOut, userId: string) {
  return task.doneAt
    ? reopenTask(workspaceId, task.id)
    : completeTask(workspaceId, task.id, userId).then(() => toast.show(TASK_WORDS.completed));
}

/** Opening a file needs signal: its link is short-lived and the file itself lives in Storage. */
function openFile(file: FileOut) {
  void openWeb(`/app/f/${file.id}`).then((opened) => {
    if (!opened) toast.error('Opening a file needs signal.');
  });
}

/**
 * Whether a timeline entry was made on this phone and hasn't reached HandsFreeOS: the note carries the id this phone
 * gave it, which is the change's own id in the queue. That's what puts "no signal · waiting to send" under it.
 */
function madeHere(data: RecordData, entryId: string): boolean {
  return data.changes.some((c) => c.waiting && c.about.includes(entryId));
}
