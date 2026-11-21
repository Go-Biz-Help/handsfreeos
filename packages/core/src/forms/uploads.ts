/**
 * Files on a public form (product sellers, pick 5a): a customer adds their design, a photo of what they want, or a
 * document, while they fill the form in, and the files land on them when it's sent. Browser-safe: the public page
 * picks with these rules, and `form_response.upload_begin` / `upload_confirm` / `submit` hold to the same ones.
 *
 * A file goes where a business's files already go (the `attachments` bucket), so it takes what that bucket takes:
 * photos, PDFs, Word and Excel files, text, and short videos and voice notes, up to 25 MB. While the form is being
 * filled in it sits on the form (`record_type` form) under the answer sheet's own folder, so only that sheet can use
 * it; on sending it moves onto the customer, where their Files and timeline show it.
 */
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES } from '../schemas/file';
import type { Question } from './definition';
import type { AnswerFile } from './questions';

const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
] as const;

const DOCUMENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
] as const;

/** What a file question takes, by its "Accept" setting. "Any" is everything the business's files take. */
export const FORM_UPLOAD_TYPES: Readonly<Record<'image' | 'document' | 'any', readonly string[]>> =
  {
    image: IMAGE_TYPES,
    document: [...DOCUMENT_TYPES, ...IMAGE_TYPES],
    any: ATTACHMENT_TYPES,
  };

/** Most files one answer sheet may start, whatever happens to them: a cap on a page that's being abused. */
export const FORM_UPLOADS_PER_SHEET = 40;

/**
 * A browser often says nothing about a file's type (an iPhone's HEIC, a CSV on Windows), so the name decides then.
 * Only the types the bucket takes are named here; anything else stays as the browser said.
 */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
};

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/** The type to send a file as: what the browser said, or what its name says when the browser said nothing useful. */
export function uploadTypeOf(name: string, browserType: string): string {
  const said = browserType.trim().toLowerCase();
  if (said && said !== 'application/octet-stream') return said;
  return BY_EXTENSION[extensionOf(name)] ?? (said || 'application/octet-stream');
}

/** The file question's settings, with the defaults its schema gives. */
function fileConfig(question: Question) {
  const config = question.config as { maxFiles?: number; maxMb?: number; accept?: string };
  const accept = (
    config.accept === 'image' || config.accept === 'document' ? config.accept : 'any'
  ) as keyof typeof FORM_UPLOAD_TYPES;
  return {
    maxFiles: Number(config.maxFiles ?? 3),
    maxMb: Number(config.maxMb ?? 10),
    accept,
  };
}

/** How big one file may be on this question: its own limit, never past what the bucket takes. */
export function uploadLimitBytes(question: Question): number {
  return Math.min(fileConfig(question).maxMb * 1024 * 1024, ATTACHMENT_MAX_BYTES);
}

/** How many files this question takes. */
export const uploadMaxFiles = (question: Question): number => fileConfig(question).maxFiles;

/** The file picker's `accept`, so the phone's picker offers the right things first. */
export function uploadAcceptAttr(question: Question): string {
  const { accept } = fileConfig(question);
  const extensions = Object.entries(BY_EXTENSION)
    .filter(([, type]) => FORM_UPLOAD_TYPES[accept].includes(type))
    .map(([ext]) => `.${ext}`);
  return [...FORM_UPLOAD_TYPES[accept], ...extensions].join(',');
}

const MB = 1024 * 1024;
const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / MB))} MB`;

/** What the question takes, in words, for the line under the box and for a refusal. */
export function uploadTakesWords(question: Question): string {
  const { accept } = fileConfig(question);
  return accept === 'image'
    ? 'photos (JPG, PNG, HEIC)'
    : accept === 'document'
      ? 'PDFs, Word or Excel files, and photos'
      : 'photos, PDFs, Word or Excel files, and short videos';
}

/** Why a file can't go on this question, or null when it can. Clients branch on `rule`. */
export function uploadRefusal(
  question: Question,
  file: { readonly name: string; readonly mimeType: string; readonly sizeBytes: number },
): { readonly rule: string; readonly message: string } | null {
  const { accept } = fileConfig(question);
  if (!FORM_UPLOAD_TYPES[accept].includes(file.mimeType.toLowerCase())) {
    const design = ['ai', 'eps', 'psd', 'svg', 'cdr'].includes(extensionOf(file.name));
    return {
      rule: 'form_file_type',
      message: design
        ? `${file.name} is a design file this form can’t take. Save it as a PDF or a PNG and add that.`
        : `${file.name} can’t be added here. This question takes ${uploadTakesWords(question)}.`,
    };
  }
  const limit = uploadLimitBytes(question);
  if (file.sizeBytes > limit)
    return {
      rule: 'form_file_too_big',
      message: `${file.name} is ${megabytes(file.sizeBytes)}. Each file can be up to ${megabytes(limit)}. Save a smaller copy and add that.`,
    };
  if (file.sizeBytes <= 0)
    return {
      rule: 'form_file_empty',
      message: `${file.name} is empty. Pick the file again.`,
    };
  return null;
}

/** Whether an answer is a list of files as the page sends them. */
export function isAnswerFiles(value: unknown): value is readonly AnswerFile[] {
  return (
    Array.isArray(value) &&
    value.every(
      (f) =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as AnswerFile).fileId === 'string' &&
        typeof (f as AnswerFile).name === 'string',
    )
  );
}

/** A file answer in words: the names, which is what the phone, the Assistant and search read. */
export function filesAnswerWords(files: readonly AnswerFile[]): string | null {
  if (!files.length) return null;
  const names = files.map((f) => f.name).join(', ');
  return files.length === 1 ? names : `${files.length} files: ${names}`;
}

/** The folder an answer sheet's files wait in until it's sent. Nothing outside it can be put on that sheet. */
export const formUploadFolder = (workspaceId: string, formId: string, responseId: string): string =>
  `${workspaceId}/form/${formId}/responses/${responseId}/`;
