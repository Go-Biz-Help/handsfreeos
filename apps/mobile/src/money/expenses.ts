import type { paths } from '@hfos/api-client';
import { BALANCE_WORDS, type ExpenseCategory, type ExpensePaidWith } from '@hfos/core';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as React from 'react';

import { api, ApiError, errorMessage, unwrap } from '@/lib/api';
import { session } from '@/lib/auth';
import { config } from '@/lib/config';
import { appFetch, useNetwork } from '@/lib/network';

/**
 * Money → Expenses on the phone (20261027036800; the owner, 25 Nov 2026: "I snap a receipt, it gets filed, and each
 * month I see money in and money out"). What `money.in_and_out` and `expense.list` answer, and adding, changing and
 * removing an expense with its receipt photo.
 *
 * **None of this is in the phone's copy.** Expenses are only for whoever manages money, and a month's figures from
 * yesterday are figures somebody would act on, so the screen is live or it says it needs a signal, like the balance.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type InOut = Ok<'/v1/queries/money.in_and_out'>;
export type ExpenseList = Ok<'/v1/queries/expense.list'>;
export type Expense = ExpenseList['expenses'][number];

/** How many expenses come down at a time. */
const PAGE = 30;
/** The longest side a receipt photo is sent at: still sharp enough to read the small print. */
export const RECEIPT_EDGE = 2048;

export interface ExpensesView {
  readonly inOut: InOut | null;
  readonly list: ExpenseList | null;
  readonly expenses: readonly Expense[];
  /** The month shown, "2026-11". */
  readonly month: string | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  showMonth(month: string): void;
  reload(): void;
  more(): void;
}

/** `enabled` is false for someone who doesn't manage money: nothing is asked for. */
export function useExpenses(workspaceId: string, enabled = true): ExpensesView {
  const { online } = useNetwork();
  const [asked, setAsked] = React.useState<string | undefined>(undefined);
  const [state, setState] = React.useState<{
    inOut: InOut | null;
    list: ExpenseList | null;
    expenses: readonly Expense[];
    cursor: string | null;
  }>({ inOut: null, list: null, expenses: [], cursor: null });
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const inOut = unwrap(
        await api.POST('/v1/queries/money.in_and_out', {
          body: { workspaceId, months: 6, month: asked },
        }),
      );
      const list = unwrap(
        await api.POST('/v1/queries/expense.list', {
          body: { workspaceId, month: inOut.breakdown.month, limit: PAGE },
        }),
      );
      return { inOut, list };
    })()
      .then(({ inOut, list }) => {
        if (cancelled) return;
        setState({ inOut, list, expenses: list.expenses, cursor: list.nextCursor });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(online ? errorMessage(e) : BALANCE_WORDS.needsSignal);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `online` is in here so coming back into signal fetches it, as the balance does.
  }, [asked, enabled, online, round, workspaceId]);

  const month = state.inOut?.breakdown.month ?? null;
  const more = React.useCallback(() => {
    const cursor = state.cursor;
    if (!cursor || !month || loadingMore) return;
    setLoadingMore(true);
    api
      .POST('/v1/queries/expense.list', { body: { workspaceId, month, limit: PAGE, cursor } })
      .then(unwrap)
      .then((page) =>
        setState((was) =>
          was.cursor === cursor
            ? { ...was, expenses: [...was.expenses, ...page.expenses], cursor: page.nextCursor }
            : was,
        ),
      )
      .catch((e: unknown) => setError(online ? errorMessage(e) : BALANCE_WORDS.needsSignal))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, month, online, state.cursor, workspaceId]);

  return {
    inOut: state.inOut,
    list: state.list,
    expenses: state.expenses,
    month,
    hasMore: state.cursor !== null,
    loadingMore,
    loading: loading && state.inOut === null,
    error,
    showMonth: (m) => setAsked(m),
    reload: () => setRound((r) => r + 1),
    more,
  };
}

/** A receipt photo, shrunk to a JPEG and ready to upload. */
export interface ReceiptPhoto {
  readonly uri: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export type TakeReceipt =
  | { readonly kind: 'taken'; readonly photo: ReceiptPhoto }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'no-camera-permission' };

/** Takes a photo of a receipt, or picks one, as a JPEG no more than RECEIPT_EDGE on its longest side. */
export async function takeReceipt(source: 'camera' | 'library'): Promise<TakeReceipt> {
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    exif: false,
  };
  let picked: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { kind: 'no-camera-permission' };
    picked = await ImagePicker.launchCameraAsync(options);
  } else {
    picked = await ImagePicker.launchImageLibraryAsync(options);
  }
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return { kind: 'cancelled' };
  const context = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > RECEIPT_EDGE)
    context.resize(
      asset.width >= asset.height ? { width: RECEIPT_EDGE } : { height: RECEIPT_EDGE },
    );
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
  const file = new File(saved.uri);
  return { kind: 'taken', photo: { uri: saved.uri, bytes: new Uint8Array(file.bytesSync()) } };
}

export interface ExpenseInput {
  readonly spentOn: string;
  readonly amountCents: number;
  readonly taxCents: number | null;
  readonly vendor: string;
  readonly category: ExpenseCategory;
  readonly paidWith: ExpensePaidWith | null;
  readonly note: string | null;
}

export function expenseCalls(workspaceId: string) {
  /** Uploads a receipt photo where `expense.begin_receipt_upload` says, then confirms it. */
  const uploadReceipt = async (
    expenseId: string,
    vendor: string,
    day: string,
    photo: ReceiptPhoto,
  ) => {
    const name = `Receipt ${vendor} ${day}.jpg`.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 200);
    const begun = unwrap(
      await api.POST('/v1/commands/expense.begin_receipt_upload', {
        body: {
          workspaceId,
          expenseId,
          name,
          mimeType: 'image/jpeg',
          sizeBytes: photo.bytes.length,
        },
      }),
    );
    const token = await session.accessToken();
    if (!token) throw new ApiError('Sign in to continue.', 401, 'unauthenticated', null);
    let res: Response;
    try {
      res = await appFetch(
        `${config.supabaseUrl}/storage/v1/object/${begun.bucket}/${begun.objectPath}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            apikey: config.supabasePublishableKey,
            'content-type': 'image/jpeg',
            'x-upsert': 'false',
          },
          body: photo.bytes,
        },
      );
    } catch {
      throw new TypeError('Network request failed');
    }
    if (!res.ok)
      throw new Error(
        'The expense is saved, but its receipt didn’t upload. Check your connection, then open the expense and add the photo again.',
      );
    unwrap(
      await api.POST('/v1/commands/file.confirm', { body: { workspaceId, fileId: begun.fileId } }),
    );
  };

  return {
    /** Adds an expense, then its receipt when there's one. */
    add: async (input: ExpenseInput, photo: ReceiptPhoto | null): Promise<void> => {
      const made = unwrap(
        await api.POST('/v1/commands/expense.create', {
          body: {
            workspaceId,
            spentOn: input.spentOn,
            amountCents: input.amountCents,
            taxCents: input.taxCents ?? undefined,
            vendor: input.vendor,
            category: input.category,
            paidWith: input.paidWith ?? undefined,
            note: input.note ?? undefined,
          },
        }),
      );
      if (photo) await uploadReceipt(made.expenseId, input.vendor, input.spentOn, photo);
    },
    /** Changes an expense, and puts a new receipt in place of the old one when there's one. */
    change: async (id: string, input: ExpenseInput, photo: ReceiptPhoto | null): Promise<void> => {
      unwrap(
        await api.POST('/v1/commands/expense.update', {
          body: {
            workspaceId,
            expenseId: id,
            spentOn: input.spentOn,
            amountCents: input.amountCents,
            taxCents: input.taxCents,
            vendor: input.vendor,
            category: input.category,
            paidWith: input.paidWith,
            note: input.note,
          },
        }),
      );
      if (photo) await uploadReceipt(id, input.vendor, input.spentOn, photo);
    },
    /** Removes it for good, receipt and all. */
    remove: async (id: string): Promise<void> => {
      unwrap(
        await api.POST('/v1/commands/expense.delete', { body: { workspaceId, expenseId: id } }),
      );
    },
  };
}
