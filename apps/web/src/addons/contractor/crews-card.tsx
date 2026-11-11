'use client';
/**
 * The business's crews (docs/contractor.md, "Crews and work orders"; the owner's decision 7): named groups of people
 * on its team and subcontractors. Putting a crew on a visit books everyone in it. A subcontractor is a contact: for
 * a company, the person the business deals with there. A crew no longer used is archived, never deleted, so the
 * visits it worked still say its name. Owners and admins (`contractor.manage`).
 */
import { LIMITS } from '@hfos/core/addons/contractor/schemas';
import { CONTRACTOR_WORDS } from '@hfos/core/addons/contractor/words';
import { X } from 'lucide-react';
import { useState } from 'react';
import { CustomerPicker } from '@/components/calendar/customer-picker';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { ConfirmDialog } from './job-dialogs';
import type { Crew, Overview } from './types';
import { useAct } from './use-act';

const C = CONTRACTOR_WORDS.crews;

export function CrewsCard({
  workspaceId,
  crews,
  people,
}: {
  workspaceId: string;
  crews: readonly Crew[];
  people: Overview['people'];
}) {
  /** The crew being changed; `'new'` for one being made. */
  const [editing, setEditing] = useState<Crew | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Crew | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const { busy, act } = useAct();
  const inUse = crews.filter((c) => !c.archived);
  const archived = crews.filter((c) => c.archived);
  const setArchived = (crew: Crew, to: boolean) =>
    apiBrowser()
      .POST('/v1/commands/contractor.crew.archive', {
        body: { workspaceId, crewId: crew.id, archived: to },
      })
      .then(unwrap);
  return (
    <Card className="mt-6 p-0" data-testid="contractor-crews">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold">{C.title}</h2>
          <p className="mt-0.5 text-[13px] text-text-2">{C.hint}</p>
        </div>
        {inUse.length < LIMITS.crews ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEditing('new')}
            data-testid="crew-new"
          >
            {C.add}
          </Button>
        ) : null}
      </div>
      {inUse.length === 0 ? (
        <p className="px-5 py-4 text-[13.5px] text-text-2">{C.none}</p>
      ) : (
        <ul>
          {inUse.map((crew) => (
            <li
              key={crew.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3 text-[13.5px] last:border-b-0"
              data-testid="crew-row"
            >
              <span className="min-w-0">
                <span className="block font-medium">{crew.name}</span>
                <span className="block truncate text-[12.5px] text-text-3">
                  {[...crew.people.map((p) => p.name), ...crew.subs.map((s) => s.name)].join(
                    ', ',
                  ) || C.size(0, 0)}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(crew)}
                  data-testid="crew-edit"
                >
                  {C.edit}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setArchiving(crew)}
                  data-testid="crew-archive"
                >
                  {C.archive}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {archived.length ? (
        <div className="border-t border-border px-5 py-3">
          <Checkbox
            label={<span className="text-[13px] text-text-2">{C.showArchived}</span>}
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            data-testid="crews-show-archived"
          />
          {showArchived ? (
            <ul className="mt-2 space-y-1.5 text-[13.5px]">
              {archived.map((crew) => (
                <li key={crew.id} className="flex items-center justify-between gap-2">
                  <span className="text-text-2">
                    {crew.name}{' '}
                    <span className="text-[12.5px] text-text-3">
                      {C.size(crew.people.length, crew.subs.length)}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === `back:${crew.id}`}
                    onClick={() =>
                      void act(
                        `back:${crew.id}`,
                        () => setArchived(crew, false),
                        C.restored(crew.name),
                      )
                    }
                    data-testid="crew-restore"
                  >
                    {C.restore}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <CrewDialog
          workspaceId={workspaceId}
          crew={editing === 'new' ? null : editing}
          people={people}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={C.archive}
        description={archiving ? C.archiveAsk(archiving.name) : ''}
        submit={C.archive}
        done={archiving ? C.archived(archiving.name) : ''}
        run={async () => archiving && setArchived(archiving, true)}
      />
    </Card>
  );
}

/** A crew's name, the people on the team in it, and its subcontractors. */
function CrewDialog({
  workspaceId,
  crew,
  people,
  onClose,
}: {
  workspaceId: string;
  crew: Crew | null;
  people: Overview['people'];
  onClose: () => void;
}) {
  const [name, setName] = useState(crew?.name ?? '');
  const [userIds, setUserIds] = useState<readonly string[]>(
    crew?.people.map((p) => p.userId) ?? [],
  );
  const [subs, setSubs] = useState<readonly { personId: string; name: string }[]>(
    crew?.subs.map((s) => ({ personId: s.personId, name: s.name })) ?? [],
  );
  const [pickerKey, setPickerKey] = useState(0);
  const { busy, errors, act } = useAct(onClose);
  // Someone in the crew who can't use the add-on any more still shows, so they can be taken out.
  const everyone = [
    ...people,
    ...(crew?.people.filter((p) => !people.some((x) => x.userId === p.userId)) ?? []),
  ];
  const size = userIds.length + subs.length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={crew ? crew.name : C.add} description={C.hint}>
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'save',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/contractor.crew.save', {
                    body: {
                      workspaceId,
                      ...(crew ? { crewId: crew.id } : {}),
                      name: name.trim(),
                      userIds: [...userIds],
                      subPersonIds: subs.map((s) => s.personId),
                    },
                  }),
                ),
              C.saved(name.trim()),
            );
          }}
          data-testid="crew-dialog"
        >
          <Field label={C.name} htmlFor="crew-name" error={errors.name}>
            <Input
              id="crew-name"
              value={name}
              autoFocus
              maxLength={LIMITS.crewName}
              placeholder={C.namePlaceholder}
              onChange={(e) => setName(e.target.value)}
              data-testid="crew-name"
            />
          </Field>
          <div>
            <div className="text-[13px] font-medium">{C.people}</div>
            {everyone.length === 0 ? (
              <p className="mt-1 text-[13px] text-text-3">{C.peopleNone}</p>
            ) : (
              <div className="mt-2 grid max-h-[180px] gap-2 overflow-y-auto sm:grid-cols-2">
                {everyone.map((p) => (
                  <Checkbox
                    key={p.userId}
                    label={p.name}
                    checked={userIds.includes(p.userId)}
                    onChange={(e) =>
                      setUserIds(
                        e.target.checked
                          ? [...userIds, p.userId]
                          : userIds.filter((id) => id !== p.userId),
                      )
                    }
                    data-testid="crew-person"
                  />
                ))}
              </div>
            )}
            {errors.userIds ? (
              <p className="mt-1 text-[13px] text-danger-text">{errors.userIds}</p>
            ) : null}
          </div>
          <div>
            <div className="text-[13px] font-medium">{C.subs}</div>
            <p className="mt-0.5 text-[12.5px] text-text-3">{C.subsHint}</p>
            {subs.length ? (
              <ul className="mt-2 space-y-1 text-[13.5px]">
                {subs.map((s) => (
                  <li key={s.personId} className="flex items-center justify-between gap-2">
                    <span>{s.name}</span>
                    <button
                      type="button"
                      className="rounded p-1 text-text-3 hover:bg-card-2 hover:text-text"
                      aria-label={`${C.removeSub}: ${s.name}`}
                      onClick={() => setSubs(subs.filter((x) => x.personId !== s.personId))}
                      data-testid="crew-sub-remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {size < LIMITS.crewMembers ? (
              <div className="mt-2" data-testid="crew-sub-pick">
                <CustomerPicker
                  key={pickerKey}
                  workspaceId={workspaceId}
                  value={null}
                  onChange={(picked) => {
                    if (!picked) return;
                    setPickerKey((k) => k + 1);
                    if (!subs.some((s) => s.personId === picked.id))
                      setSubs([...subs, { personId: picked.id, name: picked.fullName }]);
                  }}
                />
              </div>
            ) : null}
            {errors.subPersonIds ? (
              <p className="mt-1 text-[13px] text-danger-text">{errors.subPersonIds}</p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {CONTRACTOR_WORDS.job.cancel}
            </Button>
            <Button
              type="submit"
              disabled={!name.trim()}
              loading={busy === 'save'}
              data-testid="crew-save"
            >
              {C.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
