/**
 * What stops a template going out, and whether what someone filled in will do. Browser-safe: the editor shows the
 * same problems the server refuses with, and the signing page checks a field the way `document.sign` will.
 */
import { z } from 'zod';
import { normalizePhone } from '../crm/phone';
import {
  DOCUMENT_FIELD_LABELS,
  SENDER_ROLE,
  type DocumentDefinition,
  type DocumentField,
  type DocumentValue,
  valueKindOf,
} from './definition';

export interface DocumentIssue {
  /** What a client branches on. */
  readonly rule: 'document_no_pdf' | 'document_role_empty';
  readonly message: string;
  /** The role it's about, when it's about one. */
  readonly role?: string;
}

/** Why a template can't be sent yet; empty when it can. */
export function documentTemplateIssues(
  definition: DocumentDefinition,
  hasSource: boolean,
): DocumentIssue[] {
  const issues: DocumentIssue[] = [];
  if (!hasSource || !definition.pages.length)
    issues.push({
      rule: 'document_no_pdf',
      message: 'Add the PDF this template is made from.',
    });
  for (const role of definition.roles)
    if (!definition.fields.some((f) => f.role === role.key))
      issues.push({
        rule: 'document_role_empty',
        role: role.key,
        message: `${role.label} has nothing to sign or fill in. Drag a Signature onto the page for them, or take them off Who signs.`,
      });
  return issues;
}

/** A field's name in a refusal: its label, else its kind. */
export const fieldName = (f: DocumentField): string => f.label || DOCUMENT_FIELD_LABELS[f.type];

/** An email as a person's own is checked when it's saved on them, so what a signer gives can fill theirs in. */
const EMAIL = z.email().max(254);

/** Whether a value says nothing: no words, an unticked box. */
export function valueIsEmpty(v: DocumentValue | null | undefined): boolean {
  if (!v) return true;
  switch (v.kind) {
    case 'text':
      return !v.text.trim();
    case 'check':
      return !v.checked;
    case 'date':
      return !v.date;
    case 'signature':
      return false;
  }
}

/**
 * What's wrong with one value for one field, or null when it will do. An empty value on a field that isn't required
 * is fine.
 */
export function valueProblem(
  field: DocumentField,
  value: DocumentValue | null | undefined,
): string | null {
  const name = fieldName(field);
  if (valueIsEmpty(value)) return field.required ? `Fill in ${name}.` : null;
  const v = value!;
  if (v.kind !== valueKindOf(field.type)) return `${name} takes something else. Fill it in again.`;
  if (v.kind !== 'text') return null;
  const text = v.text.trim();
  switch (field.type) {
    case 'email':
      return EMAIL.safeParse(text).success
        ? null
        : `${name} needs a whole email address, like pat@example.com.`;
    case 'phone':
      return normalizePhone(text)
        ? null
        : `${name} needs a whole phone number, with the area code.`;
    case 'number':
      return Number.isFinite(Number(text.replace(/[,$\s]/g, '')))
        ? null
        : `${name} needs a number.`;
    case 'choice':
      return field.options.includes(text) ? null : `Pick one of the choices for ${name}.`;
    case 'long_text':
      return text.length > 5000 ? `Keep ${name} under 5,000 characters.` : null;
    default:
      return text.length > 500 ? `Keep ${name} under 500 characters.` : null;
  }
}

/**
 * What one signer still has to fill in, or got wrong, before they can sign: each problem with its field. `date_signed`
 * fills itself and is never theirs to give.
 */
export function signerProblems(
  definition: DocumentDefinition,
  role: string,
  values: Readonly<Record<string, DocumentValue>>,
): { fieldId: string; message: string }[] {
  const out: { fieldId: string; message: string }[] = [];
  for (const f of definition.fields) {
    if (f.role !== role || f.type === 'date_signed') continue;
    const problem = valueProblem(f, values[f.id]);
    if (problem) out.push({ fieldId: f.id, message: problem });
  }
  return out;
}

/** The fields the business fills in before it sends. */
export const senderFields = (definition: DocumentDefinition): DocumentField[] =>
  definition.fields.filter((f) => f.role === SENDER_ROLE);
