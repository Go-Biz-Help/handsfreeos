/**
 * Which files the Assistant takes with a question, worked out the same way on the web and the phone: by the type the
 * browser or the phone says, or by the name's ending when it says nothing useful (a .md file often comes as "").
 * Browser-safe.
 */
import {
  ASSISTANT_DOCX_TYPE,
  ASSISTANT_FILE_TYPES,
  ASSISTANT_XLSX_TYPE,
  type AssistantFileType,
} from '../schemas/assistant';

const BY_ENDING: Readonly<Record<string, AssistantFileType>> = {
  pdf: 'application/pdf',
  docx: ASSISTANT_DOCX_TYPE,
  xlsx: ASSISTANT_XLSX_TYPE,
  csv: 'text/csv',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
};

/** Other names some systems give the same kinds. */
const ALSO: Readonly<Record<string, AssistantFileType>> = {
  'application/csv': 'text/csv',
  'text/x-csv': 'text/csv',
  'application/vnd.ms-excel.sheet.macroenabled.12': ASSISTANT_XLSX_TYPE,
  'text/x-markdown': 'text/markdown',
};

/** Kinds the Assistant can't read, with what to do instead. */
const SAVE_AS: Readonly<Record<string, string>> = {
  doc: 'Word',
  xls: 'Excel',
  pages: 'Pages',
  numbers: 'Numbers',
  odt: 'that',
  ods: 'that',
  rtf: 'that',
  pptx: 'that',
  ppt: 'that',
  key: 'that',
};

const ending = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot < 0
    ? ''
    : name
        .slice(dot + 1)
        .trim()
        .toLowerCase();
};

/** The kind of file the Assistant takes this as, or null when it can't read it. */
export function assistantFileType(name: string, type: string): AssistantFileType | null {
  const t = type.trim().toLowerCase();
  if ((ASSISTANT_FILE_TYPES as readonly string[]).includes(t)) return t as AssistantFileType;
  if (ALSO[t]) return ALSO[t];
  return BY_ENDING[ending(name)] ?? null;
}

/** What a file picker offers: the kinds above, by type and by ending. Pictures are offered beside them. */
export const ASSISTANT_FILE_ACCEPT = [
  ...ASSISTANT_FILE_TYPES,
  ...Object.keys(BY_ENDING).map((e) => `.${e}`),
].join(',');

/** Why a file can't go with a question, in words for the person, when it's a kind the Assistant can't read. */
export function assistantFileRefusal(name: string): string {
  const kind = SAVE_AS[ending(name)];
  if (kind === 'Word' || kind === 'Pages')
    return `${name} can’t be read as it is. Save it as a PDF or a Word .docx file, then add it again.`;
  if (kind === 'Excel' || kind === 'Numbers')
    return `${name} can’t be read as it is. Save it as an Excel .xlsx or a .csv file, then add it again.`;
  if (kind) return `${name} can’t be read as it is. Save it as a PDF, then add it again.`;
  return `${name} isn’t a kind of file the Assistant reads. Send a PDF, a Word or Excel file, a .csv or a .txt, or a picture.`;
}
