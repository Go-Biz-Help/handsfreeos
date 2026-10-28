import {
  DEFAULT_REMIND_AFTER_DAYS,
  DEFAULT_REMIND_EVERY_DAYS,
  DOCUMENT_FIELD_LABELS,
  DOCUMENT_SCREEN_WORDS as W,
  DocumentDefinition,
  fieldName,
  SENDER_ROLE,
  sendFillable,
  valueProblem,
  type DocumentField,
  type DocumentSettings,
  type DocumentValueInput,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { useCustomers, type CustomerChoice } from '@/calendar/use-calendar';
import { Plus, Send, X } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useLiveAnswer } from '@/lib/live-answer';
import { matchesSearch } from '@/sync/compute';

import {
  documentCalls,
  type DocumentAboutInput,
  type DocumentPrefillOut,
  type DocumentSendBody,
  type DocumentTemplateRow,
  type TeamMember,
} from './calls';

/**
 * Sending a document from the phone (docs/documents.md, part 3), as the web's Send screen does it: a template, who
 * it's about, who signs as each role (someone with you now signs on this phone with Sign now), who gets a copy, what's
 * filled in before it goes, the note and the settings. `document.prefill` starts it from HandsFreeOS; `document.send`
 * checks it all again and sends each signer their link. Changing the words for one customer (answer 27a) is the web's
 * until the phone has the pages.
 */

export type SendAboutKind = 'person' | 'company' | 'lead';

export interface SendAbout {
  readonly kind: SendAboutKind;
  readonly id: string;
  readonly name: string;
}

type Who = { personId: string | null; userId: string | null; name: string; detail: string };

const aboutInput = (a: SendAbout): DocumentAboutInput =>
  a.kind === 'person'
    ? { personId: a.id }
    : a.kind === 'company'
      ? { companyId: a.id }
      : { leadId: a.id };

/** The name of who a document is about, asked of HandsFreeOS: the Send screen needs signal anyway. */
async function aboutName(workspaceId: string, kind: SendAboutKind, id: string): Promise<string> {
  if (kind === 'person')
    return unwrap(await api.POST('/v1/queries/person.get', { body: { workspaceId, personId: id } }))
      .person.fullName;
  if (kind === 'company')
    return unwrap(
      await api.POST('/v1/queries/company.get', { body: { workspaceId, companyId: id } }),
    ).company.name;
  return unwrap(await api.POST('/v1/queries/lead.get', { body: { workspaceId, leadId: id } })).lead
    .title;
}

export function SendDocumentScreen({
  templateId: initialTemplate,
  about: initialAbout,
  fromDocumentId,
}: {
  templateId: string | null;
  about: { readonly kind: SendAboutKind; readonly id: string } | null;
  fromDocumentId: string | null;
}) {
  const { business } = useBusiness();
  const calls = React.useMemo(() => documentCalls(business.id), [business.id]);
  const load = React.useCallback(async () => {
    const [templates, members, about] = await Promise.all([
      calls.templates(),
      calls.members(),
      initialAbout
        ? aboutName(business.id, initialAbout.kind, initialAbout.id).then((name): SendAbout => ({
            ...initialAbout,
            name,
          }))
        : Promise.resolve(null),
    ]);
    return { templates, members, about };
  }, [calls, business.id, initialAbout]);
  const answer = useLiveAnswer(
    load,
    `${business.id}:${initialAbout?.id ?? ''}`,
    W.phone.needsSignal,
  );
  return (
    <Screen title={W.send} leading="back" testID="send-document" contentClassName="gap-3">
      {answer.data ? (
        <SendBody
          workspaceId={business.id}
          templates={answer.data.templates}
          members={answer.data.members}
          initialTemplate={initialTemplate}
          initialAbout={answer.data.about}
          fromDocumentId={fromDocumentId}
        />
      ) : answer.loading ? null : (
        <Text className="py-10 text-center text-[13px] text-text-3" testID="send-missing">
          {answer.error}
        </Text>
      )}
    </Screen>
  );
}

export function SendBody({
  workspaceId,
  templates,
  members,
  initialTemplate,
  initialAbout,
  fromDocumentId,
}: {
  workspaceId: string;
  templates: readonly DocumentTemplateRow[];
  members: readonly TeamMember[];
  initialTemplate: string | null;
  initialAbout: SendAbout | null;
  fromDocumentId: string | null;
}) {
  const calls = React.useMemo(() => documentCalls(workspaceId), [workspaceId]);
  const [templateId, setTemplateId] = React.useState(
    initialTemplate && templates.some((t) => t.id === initialTemplate)
      ? initialTemplate
      : templates.length === 1
        ? templates[0]!.id
        : '',
  );
  const [about, setAbout] = React.useState<SendAbout | null>(initialAbout);
  const [picking, setPicking] = React.useState(false);
  const [prefill, setPrefill] = React.useState<DocumentPrefillOut | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPrefill(null);
    setFailed(null);
    if (!templateId || !about) return;
    let live = true;
    calls
      .prefill(templateId, aboutInput(about), fromDocumentId)
      .then((p) => live && setPrefill(p))
      .catch((e: unknown) => live && setFailed(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [calls, templateId, about, fromDocumentId]);

  const template = templates.find((t) => t.id === templateId);
  return (
    <>
      <Card className="gap-3 p-4">
        <View className="gap-1.5">
          <Label>{W.template}</Label>
          {templates.length ? (
            <ListRow
              label={template?.name ?? W.phone.pickTemplate}
              onPress={() => setPicking(true)}
              testID="send-template"
            />
          ) : (
            <Text className="text-[13px] text-text-2">{W.noTemplateReady}</Text>
          )}
        </View>
        <View className="gap-1.5">
          <Label>{W.whoFor}</Label>
          {about ? (
            <Chosen
              name={about.name}
              onChange={fromDocumentId ? undefined : () => setAbout(null)}
              testID="send-about"
            />
          ) : (
            <CustomerSearch
              onPick={(c) => setAbout({ kind: 'person', id: c.id, name: c.name })}
              testID="send-about-search"
            />
          )}
        </View>
      </Card>
      {failed ? (
        <Text role="alert" className="text-[13px] text-danger-text" testID="send-failed">
          {failed}
        </Text>
      ) : null}
      {templateId && about && !prefill && !failed ? (
        <Text className="text-[13px] text-text-3">{W.fillingIn}</Text>
      ) : null}
      {prefill && about ? (
        <SendForm
          key={`${prefill.templateId}:${about.id}`}
          workspaceId={workspaceId}
          prefill={prefill}
          about={about}
          fromDocumentId={fromDocumentId}
          members={members}
        />
      ) : null}
      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        title={W.phone.pickTemplate}
        scroll
        testID="send-template-sheet"
      >
        <List>
          {templates.map((t) => (
            <ListRow
              key={t.id}
              label={t.name}
              detail={[W.pages(t.pageCount), t.roles.map((r) => r.label).join(', ')]
                .filter(Boolean)
                .join(' · ')}
              chevron={false}
              onPress={() => {
                setTemplateId(t.id);
                setPicking(false);
              }}
              testID="send-template-option"
            />
          ))}
        </List>
      </Sheet>
    </>
  );
}

/** Who was picked, with Change beside them (none when it can't change: a corrected one keeps its customer). */
function Chosen({
  name,
  detail,
  onChange,
  testID,
}: {
  name: string;
  detail?: string;
  onChange?: () => void;
  testID?: string;
}) {
  return (
    <View
      className="min-h-12 flex-row items-center gap-2 rounded-menu border border-border bg-card-2 px-3.5 py-2"
      testID={testID}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-medium" numberOfLines={1}>
          {name}
        </Text>
        {detail ? (
          <Text className="text-[12px] text-text-3" numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {onChange ? (
        <Button variant="ghost" size="sm" onPress={onChange} testID={testID && `${testID}-change`}>
          {W.change}
        </Button>
      ) : null}
    </View>
  );
}

/** A customer from the phone's copy: what's typed, matched the way the database matches it, six at a time. */
function CustomerSearch({
  onPick,
  testID,
}: {
  onPick: (c: CustomerChoice) => void;
  testID?: string;
}) {
  const customers = useCustomers();
  const [typed, setTyped] = React.useState('');
  const wanted = typed.trim().toLowerCase();
  const found = (
    wanted ? customers.filter((c) => matchesSearch(c.searchText, wanted)) : customers
  ).slice(0, 6);
  return (
    <View className="gap-1.5">
      <Input
        value={typed}
        onChangeText={setTyped}
        placeholder={W.phone.searchCustomers}
        autoCorrect={false}
        testID={testID}
      />
      {found.length ? (
        <List>
          {found.map((c) => (
            <ListRow
              key={c.id}
              label={c.name}
              detail={c.address ?? undefined}
              chevron={false}
              onPress={() => onPick(c)}
              testID={testID && `${testID}-option`}
            />
          ))}
        </List>
      ) : wanted ? (
        <Text className="text-[13px] text-text-2">{W.phone.nobody(typed.trim())}</Text>
      ) : null}
    </View>
  );
}

function SendForm({
  workspaceId,
  prefill,
  about,
  fromDocumentId,
  members,
}: {
  workspaceId: string;
  prefill: DocumentPrefillOut;
  about: SendAbout;
  fromDocumentId: string | null;
  members: readonly TeamMember[];
}) {
  const calls = React.useMemo(() => documentCalls(workspaceId), [workspaceId]);
  const d = React.useMemo(() => DocumentDefinition.parse(prefill.definition), [prefill.definition]);
  const [name, setName] = React.useState(prefill.name);
  const [message, setMessage] = React.useState(prefill.message);
  const [settings, setSettings] = React.useState<DocumentSettings>(d.settings);
  const [values, setValues] = React.useState<Record<string, DocumentValueInput>>(
    prefill.presets as Record<string, DocumentValueInput>,
  );
  const [signers, setSigners] = React.useState<Record<string, Who | null>>(() =>
    Object.fromEntries(
      prefill.signers.map((s) => [
        s.roleKey,
        s.personId || s.userId
          ? {
              personId: s.personId,
              userId: s.userId,
              name: s.name,
              detail: s.email ?? s.phone ?? '',
            }
          : null,
      ]),
    ),
  );
  // Signing in person, with the team now (answer 13a): no link at their turn; Sign now on the document hands it over.
  const [inPerson, setInPerson] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(prefill.signers.map((s) => [s.roleKey, s.inPerson])),
  );
  const [copies, setCopies] = React.useState<Who[]>(
    prefill.copies.map((c) => ({
      personId: c.personId,
      userId: c.userId,
      name: c.name,
      detail: '',
    })),
  );
  /** Picking a teammate: for a role (its key) or for a copy. */
  const [pickingTeam, setPickingTeam] = React.useState<{ role: string } | 'copy' | null>(null);
  const [addingCustomerCopy, setAddingCustomerCopy] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fillable = React.useMemo(
    () => sendFillable(d, prefill.presets),
    // Which fields are listed is fixed by the template; what's in them changes as they're typed.
    [d, prefill.presets],
  );
  const roleName = (role: string) => d.roles.find((r) => r.key === role)?.label ?? '';

  function setValue(id: string, v: DocumentValueInput | null) {
    setValues((was) => {
      const next = { ...was };
      if (v) next[id] = v;
      else delete next[id];
      return next;
    });
  }

  function pickTeam(m: TeamMember) {
    const who = { personId: null, userId: m.id, name: m.fullName, detail: '' };
    if (pickingTeam === 'copy') setCopies((was) => [...was, who]);
    else if (pickingTeam) setSigners((s) => ({ ...s, [pickingTeam.role]: who }));
    setPickingTeam(null);
  }

  async function send() {
    if (busy) return;
    setError(null);
    const missing = d.roles.find((r) => !signers[r.key]);
    if (missing) {
      setError(W.pickSigner(missing.label));
      return;
    }
    for (const f of fillable.filter((x) => x.role === SENDER_ROLE)) {
      const p = valueProblem(f, values[f.id] as never);
      if (p) {
        setError(p);
        return;
      }
    }
    setBusy(true);
    try {
      const out = await calls.send({
        templateId: prefill.templateId,
        about: aboutInput(about),
        name: name.trim() || prefill.name,
        signers: d.roles.map((r) => {
          const who = signers[r.key]!;
          return who.userId
            ? { roleKey: r.key, userId: who.userId }
            : { roleKey: r.key, personId: who.personId!, inPerson: !!inPerson[r.key] };
        }),
        copies: copies.map((c) => (c.userId ? { userId: c.userId } : { personId: c.personId! })),
        values: values as DocumentSendBody['values'],
        edits: d.edits as DocumentSendBody['edits'],
        message: message.trim(),
        settings: {
          order: settings.order,
          askCode: settings.askCode,
          remindAfterDays: settings.remindAfterDays,
          remindEveryDays: settings.remindEveryDays,
          expireDays: settings.expireDays,
        },
        ...(fromDocumentId ? { replacesDocumentId: fromDocumentId } : {}),
      });
      toast.show(
        out.signers.filter((s) => s.kind === 'signer').length > 1 ? W.sentMany : W.sentOne,
      );
      router.replace(businessHref(workspaceId, `documents/${out.documentId}`) as Href);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      {prefill.issues.length ? (
        <Card className="gap-1.5 p-4" testID="send-issues">
          {prefill.issues.map((i, n) => (
            <Text
              key={n}
              className="rounded-control bg-warning-soft px-2.5 py-2 text-[13px] text-warning-text"
            >
              {i.message}
            </Text>
          ))}
        </Card>
      ) : null}

      <Card className="gap-1.5 p-4">
        <Label>{W.name}</Label>
        <Input value={name} onChangeText={setName} maxLength={160} testID="send-name" />
        <Text className="text-[12.5px] text-text-3">{W.nameHint}</Text>
      </Card>

      <ListLabel>{W.whoSigns}</ListLabel>
      <Card className="gap-3 p-4" testID="send-signers">
        {d.roles.map((r, i) => {
          const who = signers[r.key];
          return (
            <View key={r.key} className="gap-1.5">
              <Label>
                {`${settings.order === 'order' && d.roles.length > 1 ? `${i + 1}. ` : ''}${r.label}`}
              </Label>
              {who ? (
                <Chosen
                  name={who.name}
                  detail={who.detail}
                  onChange={() => setSigners((s) => ({ ...s, [r.key]: null }))}
                  testID={`signer-${r.key}`}
                />
              ) : r.kind === 'team' ? (
                <Button
                  variant="secondary"
                  size="md"
                  onPress={() => setPickingTeam({ role: r.key })}
                  testID={`signer-${r.key}-pick`}
                >
                  {W.pickTeam}
                </Button>
              ) : (
                <CustomerSearch
                  onPick={(c) =>
                    setSigners((s) => ({
                      ...s,
                      [r.key]: { personId: c.id, userId: null, name: c.name, detail: '' },
                    }))
                  }
                  testID={`signer-${r.key}-search`}
                />
              )}
              {who && r.kind === 'customer' ? (
                <View className="flex-row items-start gap-3 pt-1">
                  <View className="min-w-0 flex-1">
                    <Text className="text-[13.5px] font-medium">{W.inPerson}</Text>
                    <Text className="text-[12.5px] text-text-3">{W.inPersonBody}</Text>
                  </View>
                  <Switch
                    checked={!!inPerson[r.key]}
                    onCheckedChange={(on) => setInPerson((m) => ({ ...m, [r.key]: on }))}
                    label={W.inPerson}
                    testID={`signer-in-person-${r.key}`}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
        <View className="gap-1.5 border-t border-border pt-3">
          <Label>{W.copies}</Label>
          {copies.map((c, i) => (
            <View key={`${c.personId ?? c.userId}`} className="flex-row items-center gap-2">
              <Text className="min-w-0 flex-1 text-[14px]" numberOfLines={1}>
                {c.name}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                icon={X}
                accessibilityLabel={W.takeOffCopies(c.name)}
                onPress={() => setCopies((was) => was.filter((_, n) => n !== i))}
              />
            </View>
          ))}
          {addingCustomerCopy ? (
            <CustomerSearch
              onPick={(c) => {
                setCopies((was) => [
                  ...was,
                  { personId: c.id, userId: null, name: c.name, detail: '' },
                ]);
                setAddingCustomerCopy(false);
              }}
              testID="copy-person-search"
            />
          ) : (
            <View className="flex-row flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                icon={Plus}
                onPress={() => setAddingCustomerCopy(true)}
                testID="copy-add-customer"
              >
                {W.copyCustomer}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={Plus}
                onPress={() => setPickingTeam('copy')}
                testID="copy-add-team"
              >
                {W.copyTeam}
              </Button>
            </View>
          )}
        </View>
      </Card>

      {fillable.length ? (
        <>
          <ListLabel>{W.filledIn}</ListLabel>
          <Card className="gap-3 p-4" testID="send-values">
            <Text className="text-[12.5px] text-text-3">{W.filledInBody}</Text>
            {fillable.map((f) => (
              <ValueInput
                key={f.id}
                field={f}
                who={roleName(f.role)}
                value={values[f.id] ?? null}
                onChange={(v) => setValue(f.id, v)}
              />
            ))}
          </Card>
        </>
      ) : null}

      <ListLabel>{W.noteAndSettings}</ListLabel>
      <Card className="gap-3 p-4">
        <View className="gap-1.5">
          <Label>{W.note}</Label>
          <Input
            value={message}
            onChangeText={setMessage}
            placeholder={W.noteExample}
            maxLength={2000}
            multiline
            className="h-24 py-3"
            testID="send-message"
          />
        </View>
        <SettingsFields
          settings={settings}
          signers={d.roles.length}
          onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        />
      </Card>

      {error ? (
        <Text role="alert" className="text-[13px] text-danger-text" testID="send-error">
          {error}
        </Text>
      ) : null}
      <Button
        icon={Send}
        loading={busy}
        disabled={prefill.issues.length > 0}
        onPress={() => void send()}
        testID="send-submit"
      >
        {W.sendIt}
      </Button>

      <Sheet
        open={pickingTeam !== null}
        onClose={() => setPickingTeam(null)}
        title={W.pickTeam}
        scroll
        testID="send-team-sheet"
      >
        <List>
          {members.map((m) => (
            <ListRow
              key={m.id}
              label={m.fullName}
              chevron={false}
              onPress={() => pickTeam(m)}
              testID="send-team-option"
            />
          ))}
        </List>
      </Sheet>
    </>
  );
}

/** One field filled in before it goes, the way its kind is typed on a phone. */
function ValueInput({
  field,
  who,
  value,
  onChange,
}: {
  field: DocumentField;
  who: string;
  value: DocumentValueInput | null;
  onChange: (v: DocumentValueInput | null) => void;
}) {
  const ours = field.role === SENDER_ROLE;
  const label = `${field.label || DOCUMENT_FIELD_LABELS[field.type]}${ours ? '' : ` (${who})`}`;
  const text = value?.kind === 'text' ? value.text : value?.kind === 'date' ? value.date : '';
  const problem = ours && value ? valueProblem(field, value as never) : null;
  if (field.type === 'checkbox')
    return (
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-[14px]">{label}</Text>
        <Switch
          checked={value?.kind === 'check' && value.checked}
          onCheckedChange={(on) => onChange(on ? { kind: 'check', checked: true } : null)}
          label={fieldName(field)}
          testID="send-value-check"
        />
      </View>
    );
  const set = (t: string) =>
    onChange(
      t.trim()
        ? field.type === 'date'
          ? { kind: 'date', date: t.trim() }
          : { kind: 'text', text: t }
        : null,
    );
  return (
    <View className="gap-1.5">
      <Label>{`${label}${field.required && ours ? ' *' : ''}`}</Label>
      {field.type === 'choice' ? (
        <View className="flex-row flex-wrap gap-1.5">
          {field.options.map((o) => (
            <FilterChip
              key={o}
              label={o}
              on={text === o}
              onPress={() => set(text === o ? '' : o)}
              testID="send-value-choice"
            />
          ))}
        </View>
      ) : (
        <Input
          value={text}
          onChangeText={set}
          invalid={!!problem}
          multiline={field.type === 'long_text'}
          className={field.type === 'long_text' ? 'h-24 py-3' : undefined}
          maxLength={field.type === 'long_text' ? 5000 : 500}
          placeholder={field.type === 'date' ? W.phone.datePlaceholder : undefined}
          keyboardType={
            field.type === 'number'
              ? 'decimal-pad'
              : field.type === 'phone'
                ? 'phone-pad'
                : field.type === 'email'
                  ? 'email-address'
                  : field.type === 'date'
                    ? 'numbers-and-punctuation'
                    : 'default'
          }
          autoCapitalize={field.type === 'email' ? 'none' : 'sentences'}
          testID={`send-value-${field.id}`}
        />
      )}
      {problem ? <FieldError>{problem}</FieldError> : null}
    </View>
  );
}

/** A whole number of days in its range, or null while what's typed isn't one. */
const days = (typed: string, lo: number, hi: number) => {
  const n = Math.round(Number(typed));
  return typed.trim() && Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/** The settings a document going out can change, as the web's Send screen has them. */
function SettingsFields({
  settings,
  signers,
  onChange,
}: {
  settings: DocumentSettings;
  /** How many sign it: the order only matters for two or more. */
  signers: number;
  onChange: (patch: Partial<DocumentSettings>) => void;
}) {
  const reminding = settings.remindAfterDays !== null;
  return (
    <View className="gap-3">
      {signers > 1 ? (
        <View className="gap-1.5">
          <Label>{W.whoSignsWhen}</Label>
          <Segmented
            value={settings.order}
            onChange={(order) => onChange({ order })}
            label={W.whoSignsWhen}
            options={[
              { value: 'order', label: W.inOrder },
              { value: 'together', label: W.together },
            ]}
            testID="settings-order"
          />
        </View>
      ) : null}
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-[14px]">{W.askCode}</Text>
          <Text className="text-[12.5px] text-text-3">{W.askCodeBody}</Text>
        </View>
        <Switch
          checked={settings.askCode}
          onCheckedChange={(askCode) => onChange({ askCode })}
          label={W.askCode}
          testID="settings-code"
        />
      </View>
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-[14px]">{W.reminders}</Text>
        <Switch
          checked={reminding}
          onCheckedChange={(on) =>
            onChange(
              on
                ? {
                    remindAfterDays: DEFAULT_REMIND_AFTER_DAYS,
                    remindEveryDays: DEFAULT_REMIND_EVERY_DAYS,
                  }
                : { remindAfterDays: null, remindEveryDays: null },
            )
          }
          label={W.reminders}
          testID="settings-reminders"
        />
      </View>
      {reminding ? (
        <View className="flex-row gap-2">
          <DaysInput
            label={W.firstAfter}
            value={settings.remindAfterDays ?? DEFAULT_REMIND_AFTER_DAYS}
            max={30}
            onChange={(remindAfterDays) => onChange({ remindAfterDays })}
          />
          <DaysInput
            label={W.thenEvery}
            value={settings.remindEveryDays ?? DEFAULT_REMIND_EVERY_DAYS}
            max={30}
            onChange={(remindEveryDays) => onChange({ remindEveryDays })}
          />
        </View>
      ) : null}
      <DaysInput
        label={W.expireDays}
        value={settings.expireDays}
        max={365}
        onChange={(expireDays) => onChange({ expireDays })}
      />
    </View>
  );
}

/** A number of days, kept as typed until it's one the setting takes. */
function DaysInput({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (days: number) => void;
}) {
  const [typed, setTyped] = React.useState(String(value));
  return (
    <View className="min-w-0 flex-1 gap-1.5">
      <Label>{label}</Label>
      <Input
        value={typed}
        keyboardType="number-pad"
        maxLength={3}
        invalid={days(typed, 1, max) === null}
        onChangeText={(t) => {
          setTyped(t);
          const n = days(t, 1, max);
          if (n) onChange(n);
        }}
      />
    </View>
  );
}
