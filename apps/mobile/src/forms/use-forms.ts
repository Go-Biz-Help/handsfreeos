import {
  FormDefinition,
  withSafeResultLinks,
  type FormDefinition as FormDefinitionValue,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';

/**
 * The forms this phone can fill in (M17).
 *
 * Only the live ones, and only the version each is actually serving — that is what the sync rules send
 * (0085's `is_active`), so there is nothing to filter here beyond joining a form to its version. A form with
 * no version row yet has been published since this phone last synced, and is left out rather than shown as
 * something that opens to nothing.
 */
export interface PhoneForm {
  readonly id: string;
  readonly name: string;
  readonly mode: 'form' | 'survey' | 'quiz';
  /** Its part of the public link (`/f/<site>/<slug>`), which the share sheet builds from. */
  readonly slug: string;
  readonly definition: FormDefinitionValue;
}

interface FormRow {
  id: string;
  name: string;
  mode: string;
  slug: string | null;
  definition: string | null;
}

const SQL = `
  SELECT f.id AS id, f.name AS name, f.mode AS mode, f.slug AS slug, v.definition AS definition
  FROM forms f
  LEFT JOIN form_versions v ON v.form_id = f.id
  WHERE f.workspace_id = ?
  ORDER BY lower(f.name)
`;

export function usePhoneForms(): {
  readonly loading: boolean;
  readonly forms: readonly PhoneForm[];
} {
  const { business } = useBusiness();
  const { data, isLoading } = useQuery<FormRow>(SQL, [business.id]);
  const forms = React.useMemo(
    () =>
      (data ?? []).flatMap((row) => {
        if (!row.definition) return [];
        // The same schema the web and the server parse with (`load.ts` is server-side, so this phone uses
        // the zod type directly). A definition this phone cannot read is one it should not pretend to render.
        let parsed;
        try {
          parsed = FormDefinition.safeParse(
            withSafeResultLinks(JSON.parse(row.definition) as unknown),
          );
        } catch {
          return [];
        }
        if (!parsed.success) return [];
        return [
          {
            id: row.id,
            name: row.name,
            mode: (row.mode as PhoneForm['mode']) ?? 'form',
            slug: row.slug ?? '',
            definition: parsed.data,
          },
        ];
      }),
    [data],
  );
  return { loading: isLoading, forms };
}

/** One form, or null while the phone is still opening its copy. */
export function usePhoneForm(formId: string): PhoneForm | null {
  const { forms } = usePhoneForms();
  return forms.find((f) => f.id === formId) ?? null;
}

/**
 * What this phone cannot ask for, and so what sends somebody to the web.
 *
 * Not a shortcut: a signature wants a canvas, a file wants the camera roll, a payment wants a card sheet and a
 * video wants the player that tells how much was watched, and a form that rendered four of its five questions
 * and quietly dropped the fifth would be worse than one that says plainly where to open it. `formState` still decides what is *showing*, so a question behind a
 * rule nobody met does not block a form it is not part of.
 */
export const NOT_ON_THE_PHONE = ['file', 'signature', 'payment', 'video'] as const;

export function blockedQuestions(definition: FormDefinitionValue): readonly string[] {
  const kinds = new Set<string>(NOT_ON_THE_PHONE);
  return definition.pages
    .flatMap((page) => page.questions)
    .filter((q) => kinds.has(q.type))
    .map((q) => q.title);
}
