import { IDEA_AREAS_WORDS, ideaAreaIdFrom, nextIdeaAreaSort } from '@hfos/core';
import * as React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { IDEAS_DESK_WORDS } from '@/admin/ideas-words';
import { desk, useLive, type In, type Ok } from '@/admin/live';
import { DeskWaiting, Empty } from '@/components/admin/bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { Plus } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { forgetIdeaAreas } from '@/ideas/use-ideas';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

type Areas = Ok<'/v1/queries/idea.areas'>;
type AreaSave = In<'/v1/commands/idea_area.save'>;

/**
 * The parts of HandsFreeOS an idea can be about (the web's /admin/ideas/areas), for support leads and admins. A new
 * part of the product is a row here, not a deploy; an archived one takes no new ideas, and the ideas already in it
 * keep it. "Something else" is always there, at the foot.
 */
export default function DeskIdeaAreas() {
  const canManage = useDeskCan('platform.ideas.manage');
  return (
    <Screen
      title={IDEA_AREAS_WORDS.title}
      subtitle={canManage ? IDEA_AREAS_WORDS.intro : undefined}
      leading="back"
      back={deskHref('ideas')}
      scroll={false}
      testID="desk-idea-areas"
    >
      {canManage ? (
        <AreasList />
      ) : (
        <View className="p-3">
          <Empty title={IDEA_AREAS_WORDS.title} body={IDEAS_DESK_WORDS.areasManageOnly} />
        </View>
      )}
    </Screen>
  );
}

function AreasList() {
  const colors = useColors();
  const live = useLive(() => desk('/v1/queries/idea.areas', {}), 'idea-areas');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  /** Saves one area, new or changed; the list, and the phone's kept copy for sharing an idea, are asked again. */
  const save = async (area: AreaSave) => {
    setBusy(area.id);
    try {
      await desk('/v1/commands/idea_area.save', area);
      toast.show(IDEA_AREAS_WORDS.saved);
      forgetIdeaAreas();
      live.reload();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!live.data) return <DeskWaiting live={live} testID="idea-areas" />;
  const areas = live.data.areas;

  return (
    <>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 p-3 pb-8"
        refreshControl={
          <RefreshControl
            refreshing={live.refreshing}
            onRefresh={live.reload}
            tintColor={colors.accent}
          />
        }
      >
        <Button
          variant="secondary"
          icon={Plus}
          onPress={() => setAdding(true)}
          testID="idea-area-add"
        >
          {IDEA_AREAS_WORDS.add}
        </Button>
        <Card testID="idea-areas-list">
          {areas.map((a, i) => (
            <View
              key={a.id}
              className={cn(
                'flex-row items-center gap-3 px-4 py-3',
                i > 0 && 'border-t border-border',
              )}
              testID={`idea-area-${a.id}`}
            >
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-[15px] font-medium">
                  {a.name}
                  {a.archived ? (
                    <Text className="text-xs text-text-3">{`  ${IDEA_AREAS_WORDS.archived}`}</Text>
                  ) : null}
                </Text>
                <Text className="text-[12.5px] text-text-3" numberOfLines={2}>
                  {IDEA_AREAS_WORDS.line(a.description, a.openCount)}
                </Text>
              </View>
              {a.id === 'other' ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === a.id}
                  onPress={() =>
                    void save({
                      id: a.id,
                      name: a.name,
                      description: a.description,
                      sort: a.sort,
                      archived: !a.archived,
                    })
                  }
                  testID={`idea-area-archive-${a.id}`}
                >
                  {a.archived ? IDEA_AREAS_WORDS.bringBack : IDEA_AREAS_WORDS.archive}
                </Button>
              )}
            </View>
          ))}
        </Card>
      </ScrollView>
      <AddSheet
        open={adding}
        areas={areas}
        busy={busy !== null}
        onClose={() => setAdding(false)}
        onSave={async (area) => {
          if (await save(area)) setAdding(false);
        }}
      />
    </>
  );
}

/** Add an area: its name makes its id ("Service plans" is service_plans), and it goes after the last one. */
function AddSheet({
  open,
  areas,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  areas: Areas['areas'];
  busy: boolean;
  onClose: () => void;
  onSave: (area: AreaSave) => Promise<void>;
}) {
  const keyboard = useKeyboardHeight();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  React.useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
  }, [open]);

  const add = () => {
    const id = ideaAreaIdFrom(name);
    if (id.length < 2) {
      toast.error(IDEA_AREAS_WORDS.needsName);
      return;
    }
    void onSave({
      id,
      name: name.trim(),
      description: description.trim(),
      sort: nextIdeaAreaSort(areas),
      archived: false,
    });
  };

  return (
    <Sheet open={open} onClose={onClose} title={IDEA_AREAS_WORDS.add} testID="idea-area-sheet">
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="mt-3 gap-3">
        <View className="gap-1.5">
          <Label>{IDEA_AREAS_WORDS.nameLabel}</Label>
          <Input
            value={name}
            onChangeText={setName}
            placeholder={IDEA_AREAS_WORDS.namePlaceholder}
            accessibilityLabel={IDEA_AREAS_WORDS.nameLabel}
            maxLength={60}
            testID="idea-area-name"
          />
        </View>
        <View className="gap-1.5">
          <Label>{IDEA_AREAS_WORDS.descriptionLabel}</Label>
          <Input
            value={description}
            onChangeText={setDescription}
            placeholder={IDEA_AREAS_WORDS.descriptionPlaceholder}
            accessibilityLabel={IDEA_AREAS_WORDS.descriptionLabel}
            maxLength={300}
            testID="idea-area-description"
          />
        </View>
        <Button onPress={add} loading={busy} disabled={!name.trim()} testID="idea-area-save">
          {IDEA_AREAS_WORDS.addButton}
        </Button>
      </View>
    </Sheet>
  );
}
