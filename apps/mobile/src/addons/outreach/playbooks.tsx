import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import {
  blankPlaybook,
  PLAYBOOK_GOALS,
  PLAYBOOK_TEMPLATE_KEYS,
  PLAYBOOK_TEMPLATES,
  PlaybookSaveInput,
  type PlaybookListOutput,
  type PlaybookTemplateKey,
} from '@hfos/core/addons/outreach/playbooks';
import * as React from 'react';
import { View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { BookOpen, Plus } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { NeedsSignal, Note, openPlaybook, useOutreachAnswer, useOutreachContext } from './kit';

/**
 * Playbooks on the phone (decision 44): those in use, then the archived, each opening its own screen. Owners and
 * admins start a new one, blank or from a template, and change each a part at a time there. It needs signal.
 */

type Playbooks = PlaybookListOutput['playbooks'];

export function PlaybooksScreen() {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const list = useOutreachAnswer(
    async () =>
      unwrap(await api.POST('/v1/queries/outreach.playbook.list', { body: { workspaceId: ws } }))
        .playbooks,
    `playbooks:${ws}`,
    W.rows.playbooks,
  );
  return (
    <PlaybooksBody
      playbooks={list.data}
      error={list.error}
      manages={ctx.manages}
      online={ctx.online}
      onRetry={list.reload}
      onOpen={(id) => openPlaybook(ws, id)}
      onCreate={async (name, template) => {
        const input = PlaybookSaveInput.safeParse({
          workspaceId: ws,
          name,
          template,
          details: template ? PLAYBOOK_TEMPLATES[template].details : blankPlaybook(),
        });
        if (!input.success) {
          toast.error(input.error.issues[0]?.message ?? W.tryAgain);
          return false;
        }
        try {
          const made = await change('outreach.playbook.save', input.data);
          list.reload();
          openPlaybook(ws, made.output.id);
          return true;
        } catch (e) {
          toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
          return false;
        }
      }}
    />
  );
}

export function PlaybooksBody({
  playbooks,
  error,
  manages,
  online,
  onRetry,
  onOpen,
  onCreate,
}: {
  playbooks: Playbooks | null;
  error: string | null;
  manages: boolean;
  online: boolean;
  onRetry: () => void;
  onOpen: (playbookId: string) => void;
  onCreate: (name: string, template: PlaybookTemplateKey | null) => Promise<boolean>;
}) {
  const [creating, setCreating] = React.useState(false);
  const inUse = playbooks?.filter((p) => !p.archivedAt) ?? [];
  const archived = playbooks?.filter((p) => p.archivedAt) ?? [];
  const row = (p: Playbooks[number]) => (
    <ListRow
      key={p.id}
      icon={BookOpen}
      label={p.name}
      detail={PLAYBOOK_GOALS[p.details.goal]}
      onPress={() => onOpen(p.id)}
      testID="playbooks-item"
    />
  );
  return (
    <Screen title={W.rows.playbooks} leading="back" testID="outreach-playbooks">
      {playbooks ? (
        <>
          {manages ? (
            <Button
              icon={Plus}
              disabled={!online}
              onPress={() => setCreating(true)}
              testID="playbooks-new"
            >
              {W.newPlaybook}
            </Button>
          ) : (
            <Note>{W.readOnly}</Note>
          )}
          {inUse.length ? (
            <>
              <ListLabel>{W.inUse}</ListLabel>
              <List>{inUse.map(row)}</List>
            </>
          ) : (
            <Note testID="playbooks-empty">{W.playbooksEmpty}</Note>
          )}
          {archived.length ? (
            <>
              <ListLabel>{W.archived}</ListLabel>
              <List>{archived.map(row)}</List>
            </>
          ) : null}
        </>
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="playbooks-needs-signal" />
      ) : null}
      <NewSheet open={creating} onClose={() => setCreating(false)} onCreate={onCreate} />
    </Screen>
  );
}

/** A new playbook: its name, then blank or from a template. */
function NewSheet({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, template: PlaybookTemplateKey | null) => Promise<boolean>;
}) {
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const keyboard = useKeyboardHeight();
  const make = async (template: PlaybookTemplateKey | null) => {
    const named = name.trim() || (template ? PLAYBOOK_TEMPLATES[template].name : '');
    setBusy(true);
    const made = await onCreate(named, template);
    setBusy(false);
    if (made) {
      setName('');
      onClose();
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={W.newPlaybook} scroll testID="playbooks-new-sheet">
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="gap-3">
        <Input
          value={name}
          onChangeText={setName}
          placeholder={W.name}
          testID="playbooks-new-name"
        />
        <Button
          variant="secondary"
          loading={busy}
          disabled={!name.trim()}
          onPress={() => void make(null)}
          testID="playbooks-new-blank"
        >
          {W.blank}
        </Button>
        {PLAYBOOK_TEMPLATE_KEYS.map((key) => (
          <View key={key} className="gap-1">
            <Button
              variant="ghost"
              disabled={busy}
              onPress={() => void make(key)}
              testID={`playbooks-new-${key}`}
            >
              {W.fromTemplate(PLAYBOOK_TEMPLATES[key].name)}
            </Button>
            <Note>{PLAYBOOK_TEMPLATES[key].summary}</Note>
          </View>
        ))}
      </View>
    </Sheet>
  );
}
