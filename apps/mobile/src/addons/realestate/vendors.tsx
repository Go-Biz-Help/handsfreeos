import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { RE_VENDORS_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import {
  VENDOR_SERVICE_KEYS,
  VENDOR_SERVICES,
  type VendorService,
} from '@hfos/core/addons/realestate/vendors';
import { vendorListOfCopy, type VendorRow } from '@hfos/core/addons/realestate/views/vendors';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Phone, Plus, Wrench } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

import { useRealestateCopy } from './copy';
import { addVendor, approveVendor, type NewVendor } from './deal-actions';
import { Chip, Footnote, GroupLabel, KeptStrip, useReChanges, type ReChange } from './deal-bits';
import { RE_MANAGE, SignalButton, useReContext } from './kit';

/**
 * Vendors (board 89's third panel): the brokerage's vendors with any disclosure, to call or pick on a duty. Adding one
 * works with no signal (a company in Contacts, waiting for an owner or admin to approve it); approving needs an owner
 * or admin with signal.
 */

export function VendorsScreen() {
  const ctx = useReContext();
  const { business } = useBusiness();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'lists' });
  const list = React.useMemo(() => vendorListOfCopy(copy, {}, ctx), [copy, ctx]);
  const changes = useReChanges(ctx.workspaceId);
  return (
    <VendorsView
      businessName={business.name}
      workspaceId={ctx.workspaceId}
      vendors={list.vendors}
      pending={changes.filter((c) => c.name === 'realestate.vendor.save')}
      manages={ctx.holds(RE_MANAGE)}
    />
  );
}

export function VendorsView({
  businessName,
  workspaceId,
  vendors,
  pending,
  manages,
}: {
  businessName: string;
  workspaceId: string;
  vendors: readonly VendorRow[];
  /** Vendors added on this phone that haven't reached HandsFreeOS. */
  pending: readonly ReChange[];
  manages: boolean;
}) {
  const [adding, setAdding] = React.useState(false);
  const approved = vendors.filter((v) => v.approved);
  const waiting = vendors.filter((v) => !v.approved);
  return (
    <Screen
      title={RE_VENDORS_WORDS.title}
      subtitle={businessName}
      leading="back"
      testID="re-vendors"
      header={<KeptStrip inset />}
    >
      {vendors.length === 0 && pending.length === 0 ? (
        <Text className="px-2 py-6 text-center text-[14px] text-text-2" testID="re-vendors-empty">
          {RE_VENDORS_WORDS.empty}
        </Text>
      ) : null}
      {approved.length ? (
        <>
          <GroupLabel label={RE_VENDORS_WORDS.approved} count={approved.length} />
          <VendorList vendors={approved} workspaceId={workspaceId} manages={manages} />
        </>
      ) : null}
      {waiting.length || pending.length ? (
        <>
          <GroupLabel label={RE_VENDORS_WORDS.waiting} count={waiting.length + pending.length} />
          <VendorList
            vendors={waiting}
            pending={pending}
            workspaceId={workspaceId}
            manages={manages}
          />
        </>
      ) : null}
      <Button
        variant="secondary"
        icon={Plus}
        onPress={() => setAdding(true)}
        testID="re-vendors-add"
      >
        {RE_VENDORS_WORDS.add}
      </Button>
      <Footnote>{RE_VENDORS_WORDS.footer}</Footnote>
      <AddVendorSheet
        open={adding}
        onClose={() => setAdding(false)}
        manages={manages}
        onSave={async (vendor) => {
          try {
            await addVendor(workspaceId, vendor);
            setAdding(false);
            toast.show(RE_VENDORS_WORDS.added(vendor.name.trim()));
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      />
    </Screen>
  );
}

function VendorList({
  vendors,
  pending = [],
  workspaceId,
  manages,
}: {
  vendors: readonly VendorRow[];
  pending?: readonly ReChange[];
  workspaceId: string;
  manages: boolean;
}) {
  return (
    <View className="overflow-hidden rounded-card border border-border bg-card">
      {vendors.map((v, i) => (
        <View
          key={v.id}
          className={cn(
            'flex-row items-center gap-3 px-3.5 py-2.5',
            i > 0 && 'border-t border-border',
          )}
          testID={`re-vendor-${v.id}`}
        >
          <Icon as={Wrench} className="size-[18px] text-text-2" />
          <View className="min-w-0 flex-1 gap-px">
            <Text className="text-[15px]">{v.name}</Text>
            <Text className={cn('text-[13px]', v.disclosure ? 'text-warning-text' : 'text-text-3')}>
              {[
                v.servicesWords,
                v.areas.length ? v.areas.join(', ') : null,
                v.disclosure ? v.disclosureWords.replace(/^D/, 'd') : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {!v.approved && manages ? (
              <View className="pt-1.5">
                <SignalButton
                  label={RE_VENDORS_WORDS.approve}
                  variant="secondary"
                  onPress={() =>
                    void approveVendor(workspaceId, v.id)
                      .then(() => toast.show(RE_VENDORS_WORDS.approvedDone(v.name)))
                      .catch((e: unknown) => toast.error(errorMessage(e)))
                  }
                  testID={`re-vendor-approve-${v.id}`}
                />
              </View>
            ) : null}
          </View>
          {v.phone ? (
            <Pressable
              role="button"
              accessibilityLabel={RE_VENDORS_WORDS.call(v.name)}
              onPress={() => void Linking.openURL(`tel:${v.phone!.replace(/[^\d+]/g, '')}`)}
              hitSlop={6}
              className="size-10 items-center justify-center"
            >
              <Icon as={Phone} className="size-[18px] text-accent-text" />
            </Pressable>
          ) : null}
        </View>
      ))}
      {pending.map((c, i) => (
        <View
          key={c.id}
          className={cn(
            'flex-row items-center gap-3 px-3.5 py-2.5',
            (vendors.length > 0 || i > 0) && 'border-t border-border',
          )}
          testID={`re-vendor-pending-${c.id}`}
        >
          <Icon as={Wrench} className="size-[18px] text-text-3" />
          <View className="min-w-0 flex-1 gap-px">
            <Text className="text-[15px]">{String(c.input.name ?? '')}</Text>
            <Text className="text-[13px] text-text-3">
              {Array.isArray(c.input.services)
                ? (c.input.services as VendorService[]).map((s) => VENDOR_SERVICES[s]).join(', ')
                : ''}
            </Text>
          </View>
          <Badge variant="pending">
            <Text>{RE_PHONE_WORDS.waitingToSend}</Text>
          </Badge>
        </View>
      ))}
    </View>
  );
}

function AddVendorSheet({
  open,
  onClose,
  manages,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  manages: boolean;
  onSave: (vendor: NewVendor) => void;
}) {
  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [areas, setAreas] = React.useState('');
  const [disclosure, setDisclosure] = React.useState('');
  const [services, setServices] = React.useState<VendorService[]>([]);
  const ready = name.trim() !== '' && services.length > 0;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RE_VENDORS_WORDS.addTitle}
      description={manages ? RE_VENDORS_WORDS.addAboutManager : RE_VENDORS_WORDS.addAbout}
      scroll
      testID="re-vendor-sheet"
    >
      <View className="gap-2.5 pt-3">
        <Input
          value={name}
          onChangeText={setName}
          placeholder={RE_VENDORS_WORDS.name}
          accessibilityLabel={RE_VENDORS_WORDS.name}
          testID="re-vendor-name"
        />
        <Input
          value={phone}
          onChangeText={setPhone}
          placeholder={RE_VENDORS_WORDS.phone}
          accessibilityLabel={RE_VENDORS_WORDS.phone}
          keyboardType="phone-pad"
          testID="re-vendor-phone"
        />
        <Input
          value={email}
          onChangeText={setEmail}
          placeholder={RE_VENDORS_WORDS.email}
          accessibilityLabel={RE_VENDORS_WORDS.email}
          keyboardType="email-address"
          autoCapitalize="none"
          testID="re-vendor-email"
        />
        <Text className="pt-1 text-[13px] font-medium text-text-2">
          {RE_VENDORS_WORDS.services}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          {VENDOR_SERVICE_KEYS.map((k) => (
            <Chip
              key={k}
              label={VENDOR_SERVICES[k]}
              on={services.includes(k)}
              onPress={() =>
                setServices(
                  services.includes(k) ? services.filter((s) => s !== k) : [...services, k],
                )
              }
              testID={`re-vendor-service-${k}`}
            />
          ))}
        </View>
        <Text className="pt-1 text-[13px] font-medium text-text-2">{RE_VENDORS_WORDS.areas}</Text>
        <Input
          value={areas}
          onChangeText={setAreas}
          placeholder={RE_VENDORS_WORDS.anywhere}
          accessibilityLabel={RE_VENDORS_WORDS.areas}
          testID="re-vendor-areas"
        />
        <Text className="text-[12.5px] text-text-3">{RE_VENDORS_WORDS.areasHint}</Text>
        <Text className="pt-1 text-[13px] font-medium text-text-2">
          {RE_VENDORS_WORDS.disclosure}
        </Text>
        <Input
          value={disclosure}
          onChangeText={setDisclosure}
          accessibilityLabel={RE_VENDORS_WORDS.disclosure}
          testID="re-vendor-disclosure"
        />
        <Text className="text-[12.5px] text-text-3">{RE_VENDORS_WORDS.disclosureHint}</Text>
        <Button
          disabled={!ready}
          onPress={() => {
            onSave({
              name,
              phone,
              email,
              services,
              areas: areas
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean),
              disclosure,
            });
            setName('');
            setPhone('');
            setEmail('');
            setAreas('');
            setDisclosure('');
            setServices([]);
          }}
          testID="re-vendor-save"
        >
          {RE_VENDORS_WORDS.save}
        </Button>
      </View>
    </Sheet>
  );
}
