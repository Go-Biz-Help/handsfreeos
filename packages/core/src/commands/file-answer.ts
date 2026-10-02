/**
 * Asking a customer for a file (20261018000400): a qualifying question they answer by sending something, like a photo
 * or PDF of their electric bill.
 *
 * It comes two ways, and ends the same:
 * - **Through a link.** The AI teammate asks with `file_link.create` (a video link that asks for a file), the
 *   customer's page sends photos or PDFs, and each lands in the conversation as their reply
 *   (`video_link.receive_upload`).
 * - **By text or email.** They text a photo or email the PDF, and the teammate saves it with
 *   `lead.save_file_answer`.
 *
 * Either way `fileArrived` puts each file on the lead (the customer, when the lead has gone since), answers the
 * question with the files' names, and sends `file.received`, from which the worker copies each file across from the
 * message (`file.finish_copy` marks it ready) and tells whoever the question names.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { files, leads, messages, people, videoLinks } from '@hfos/db/schema';
import type { QualifyingQuestion } from '../ai-team/config';
import { loadTeammate, teammateConfigOf } from '../ai-team/load';
import {
  assertAiReach,
  notHandledByAi,
  outsideItsConversation,
  refuseCustomersLeadInChat,
} from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { formatPhone } from '../crm/phone';
import { fullName, safeFileName } from '../crm/records';
import { HfosError } from '../errors';
import { aiEmployeeOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  FILE_ANSWER_MAX_FILES,
  FILE_ANSWER_TYPES,
  FILE_LINK_DAYS,
  FILE_LINK_MAX_BYTES,
  FILE_LINK_MAX_UPLOADS,
  FILE_LINK_WORDS,
  fileAnswerWords,
  isFileAnswerType,
} from '../messaging/file-link';
import { loadConversation } from '../messaging/store';
import { VIDEO_LINK_WORDS, videoLinkPath } from '../messaging/video-link';
import {
  FileFinishCopyInput,
  FileFinishCopyOutput,
  FileLinkCreateInput,
  FileLinkCreateOutput,
  LeadSaveFileAnswerInput,
  LeadSaveFileAnswerOutput,
} from '../schemas/video-link';
import { saveAnswers, storedQualification } from './lead.record_answers';
import { customerOptedOut } from './message';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const leadGone = 'That lead isn’t there anymore. It may have been deleted. Refresh and try again.';

/** One file as it sits on the customer's message. */
export interface ArrivedFile {
  readonly bucket: string;
  readonly objectPath: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly name: string;
}

/** The business's qualifying questions, from its AI teammate's settings (none without a teammate). */
async function qualifyingQuestions(ctx: CommandContext): Promise<readonly QualifyingQuestion[]> {
  const teammate = await loadTeammate(ctx.tx, ctx.scope.workspaceId!);
  return teammate ? teammateConfigOf(teammate).qualify.questions : [];
}

/** A file question of the teammate's settings, or the refusal that says why it isn't one. */
function fileQuestion(
  questions: readonly QualifyingQuestion[],
  questionId: string,
): QualifyingQuestion {
  const q = questions.find((x) => x.id === questionId);
  if (!q) throw HfosError.rule('question_not_found', 404, FILE_LINK_WORDS.questionGone);
  if (q.kind !== 'file')
    throw HfosError.rule('not_a_file_question', 400, FILE_LINK_WORDS.notAFileQuestion(q.question));
  return q;
}

/** The extension a file is stored with, from its type; else whatever its name ends in. */
function extensionOf(file: ArrivedFile): string {
  const known = FILE_ANSWER_TYPES[file.contentType.split(';')[0]!.trim().toLowerCase()];
  if (known) return known;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(file.name);
  return m ? m[1]!.toLowerCase() : 'bin';
}

/** A file's name with an extension, for one that came without a name worth keeping ("IMG", ""). */
function nameOf(file: ArrivedFile, index: number): string {
  const name = file.name.trim().slice(0, 200);
  if (name && /\.[A-Za-z0-9]{1,8}$/.test(name)) return name;
  return `${name || `file-${index + 1}`}.${extensionOf(file)}`.slice(0, 200);
}

export interface FileArrival {
  /** The lead whose question it answers; null when it has gone. */
  readonly leadId: string | null;
  /** The customer, who keeps the file when there is no lead. */
  readonly personId: string | null;
  readonly questionId: string;
  /** The question's words as they were asked, for when it has been removed since. */
  readonly ask: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly files: readonly ArrivedFile[];
  readonly via: 'file_link' | 'message';
}

export interface FileArrivalResult {
  readonly files: { fileId: string; name: string }[];
  /** On the lead's answers; false when the lead or the question has gone. */
  readonly answered: boolean;
  readonly status: 'qualified' | 'not_a_fit' | 'incomplete' | null;
  readonly missing: string[];
  readonly qualified: boolean;
}

/**
 * A customer's file for a file question: on the lead's Files (else the customer's), copied across from their message
 * by the worker, and the question answered with the files' names. Emits `file.received`, and `lead.answers_recorded`
 * and `lead.qualified` as answering does. Nothing to put it on (no lead, no customer) leaves it in the conversation.
 */
export async function fileArrived(
  ctx: CommandContext,
  arrival: FileArrival,
): Promise<FileArrivalResult> {
  const workspaceId = ctx.scope.workspaceId!;
  const questions = await qualifyingQuestions(ctx);
  const question = questions.find((q) => q.id === arrival.questionId && q.kind === 'file') ?? null;
  const [lead] = arrival.leadId
    ? await ctx.tx
        .select()
        .from(leads)
        .where(and(eq(leads.id, arrival.leadId), eq(leads.workspaceId, workspaceId)))
    : [];
  const personId = lead?.personId ?? arrival.personId;
  const record = lead
    ? { type: 'lead' as const, id: lead.id }
    : personId
      ? { type: 'person' as const, id: personId }
      : null;
  const none: FileArrivalResult = {
    files: [],
    answered: false,
    status: null,
    missing: [],
    qualified: false,
  };
  if (!record) return none;

  const kept = arrival.files.slice(0, FILE_ANSWER_MAX_FILES);
  const filed: { fileId: string; name: string }[] = [];
  const copies: {
    fileId: string;
    name: string;
    from: { bucket: string; objectPath: string };
    contentType: string;
    sizeBytes: number;
  }[] = [];
  for (const [i, f] of kept.entries()) {
    const fileId = randomUUID();
    const name = nameOf(f, i);
    await ctx.tx.insert(files).values({
      id: fileId,
      workspaceId,
      recordType: record.type,
      recordId: record.id,
      bucket: 'attachments',
      objectPath: `${workspaceId}/${record.type}/${record.id}/${fileId}/${safeFileName(name)}`,
      name,
      mimeType: f.contentType,
      sizeBytes: f.sizeBytes,
      // The customer sent it: nobody here uploaded it, unless a person is saving it (the database wants their name).
      createdBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
    });
    filed.push({ fileId, name });
    copies.push({
      fileId,
      name,
      from: { bucket: f.bucket, objectPath: f.objectPath },
      contentType: f.contentType,
      sizeBytes: f.sizeBytes,
    });
  }

  // The answer: what came before for this question (two photos sent one at a time are one answer), and these.
  let result = none;
  if (lead && question && !lead.archivedAt) {
    const before = storedQualification(lead).answers[question.id];
    const all = [
      ...(before?.files ?? []),
      ...filed.map((f) => ({ ...f, messageId: arrival.messageId })),
    ];
    const saved = await saveAnswers(ctx, lead, questions, [
      { questionId: question.id, answer: fileAnswerWords(all.map((f) => f.name)), files: all },
    ]);
    result = {
      files: filed,
      answered: true,
      status: saved.status,
      missing: saved.missing,
      qualified: saved.qualified,
    };
  } else result = { ...none, files: filed };

  await ctx.emit({
    type: 'file.received',
    entityType: record.type,
    entityId: record.id,
    payload: {
      leadId: lead?.id ?? null,
      personId,
      conversationId: arrival.conversationId,
      messageId: arrival.messageId,
      questionId: arrival.questionId,
      question: question?.question ?? arrival.ask,
      // Who hears, as the question said when it came: a question removed since tells nobody.
      notify: question?.notify ?? null,
      via: arrival.via,
      files: copies,
    },
    broadcast: false,
    after: {
      question: question?.question ?? arrival.ask,
      files: filed.map((f) => f.name),
      answered: result.answered,
    },
  });
  return result;
}

// ---------- the link ----------

const tokenHash = (token: string): Buffer => createHash('sha256').update(token).digest();

export const fileLinkCreate = defineCommand({
  name: 'file_link.create',
  description:
    'The AI teammate asks for a file that answers one of its file questions (a photo or PDF of a bill, say): a link to text the customer, made for this conversation and their lead. Whatever they send through it goes on the lead’s Files and answers the question. Shown once, to send; it lasts a week and takes five files.',
  risk: 1,
  input: FileLinkCreateInput,
  output: FileLinkCreateOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['video_link.created'],
  shownOnce: ['token', 'path'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const ai = aiEmployeeOf(ctx.actor)!;
    const conv = await loadConversation(ctx, input.conversationId);
    // Only in the conversation it's answering, and only while it has it.
    if (conv.id !== ai.conversationId) throw outsideItsConversation();
    if (conv.handledBy !== 'ai' || conv.aiTeammateId !== ai.teammateId) throw notHandledByAi();
    if (conv.channel !== 'sms')
      throw HfosError.rule(
        'channel_mismatch',
        400,
        VIDEO_LINK_WORDS.notByText(conv.channel === 'chat' ? 'a website chat' : 'an email thread'),
      );
    await assertAiReach(ctx, { leadId: input.leadId });
    const [lead] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, workspaceId)));
    if (!lead) throw HfosError.notFound(leadGone);
    const question = fileQuestion(await qualifyingQuestions(ctx), input.questionId);
    if (await customerOptedOut(ctx, conv)) {
      const [p] = conv.personId
        ? await ctx.tx
            .select({ firstName: people.firstName, lastName: people.lastName })
            .from(people)
            .where(eq(people.id, conv.personId))
        : [];
      const who = (p && fullName(p.firstName, p.lastName)) || formatPhone(conv.counterpart);
      throw HfosError.rule(
        'opted_out',
        409,
        `${who} texted STOP, so no texts can go to them. They have to text START before you can ask for a file.`,
      );
    }
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + FILE_LINK_DAYS * 24 * 60 * 60 * 1000);
    const [link] = await ctx.tx
      .insert(videoLinks)
      .values({
        workspaceId,
        conversationId: conv.id,
        tokenHash: tokenHash(token),
        createdBy: null,
        createdByTeammateId: ai.teammateId,
        expiresAt,
        maxUploads: FILE_LINK_MAX_UPLOADS,
        asksFor: 'file',
        leadId: lead.id,
        questionId: question.id,
        ask: question.question,
      })
      .returning({ id: videoLinks.id });
    await ctx.emit({
      type: 'video_link.created',
      entityType: 'conversation',
      entityId: conv.id,
      payload: {
        videoLinkId: link!.id,
        expiresAt: expiresAt.toISOString(),
        asksFor: 'file',
        leadId: lead.id,
        questionId: question.id,
      },
      after: { fileLink: 'made', question: question.question, expires: expiresAt.toISOString() },
    });
    return {
      videoLinkId: link!.id,
      token,
      path: videoLinkPath(token),
      expiresAt: expiresAt.toISOString(),
      maxUploads: FILE_LINK_MAX_UPLOADS,
    };
  },
});

// ---------- a photo or PDF they texted or emailed ----------

export const leadSaveFileAnswer = defineCommand({
  name: 'lead.save_file_answer',
  description:
    'Save the photos or PDF a customer texted or emailed as their answer to a file question (a photo of their electric bill, say): they go on the lead’s Files, the question is answered, and whoever the question names hears.',
  risk: 1,
  input: LeadSaveFileAnswerInput,
  output: LeadSaveFileAnswerOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['file.received', 'lead.answers_recorded', 'lead.qualified'],
  actors: ['human', 'ai_employee'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    await assertAiReach(ctx, { leadId: input.leadId });
    const [lead] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, workspaceId)));
    if (!lead) throw HfosError.notFound(leadGone);
    if (lead.archivedAt)
      throw HfosError.rule(
        'lead_archived',
        409,
        'This lead is archived. Restore it, then save the file.',
      );
    await refuseCustomersLeadInChat(ctx, lead);
    const question = fileQuestion(await qualifyingQuestions(ctx), input.questionId);
    const [message] = await ctx.tx
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        direction: messages.direction,
        media: messages.media,
        privateTo: messages.privateTo,
      })
      .from(messages)
      .where(and(eq(messages.id, input.messageId), eq(messages.workspaceId, workspaceId)));
    // Only the customer's own message, in the conversation the teammate is answering, and never someone's own mail.
    const ai = aiEmployeeOf(ctx.actor);
    if (!message || message.direction !== 'inbound')
      throw HfosError.rule('no_file', 404, FILE_LINK_WORDS.nothingToSave);
    if (ai && message.conversationId !== ai.conversationId) throw outsideItsConversation();
    if (message.privateTo) throw HfosError.rule('no_file', 404, FILE_LINK_WORDS.nothingToSave);
    const answer = storedQualification(lead).answers[question.id];
    const saved = (answer?.files ?? []).filter((f) => f.messageId === message.id);
    if (saved.length)
      return {
        leadId: lead.id,
        files: saved.map(({ fileId, name }) => ({ fileId, name })),
        status: storedQualification(lead).status,
        missing: [...storedQualification(lead).missing],
        qualified: false,
        duplicate: true,
      };
    const usable = (message.media ?? []).filter(
      (m) =>
        isFileAnswerType(m.contentType) &&
        m.sizeBytes > 0 &&
        m.sizeBytes <= FILE_LINK_MAX_BYTES &&
        m.objectPath.startsWith(`${workspaceId}/`),
    );
    if (!usable.length) throw HfosError.rule('no_file', 400, FILE_LINK_WORDS.nothingToSave);
    const r = await fileArrived(ctx, {
      leadId: lead.id,
      personId: lead.personId,
      questionId: question.id,
      ask: question.question,
      conversationId: message.conversationId,
      messageId: message.id,
      files: usable.map((m) => ({
        bucket: m.bucket,
        objectPath: m.objectPath,
        contentType: m.contentType,
        sizeBytes: m.sizeBytes,
        name: m.name,
      })),
      via: 'message',
    });
    return {
      leadId: lead.id,
      files: r.files,
      status: r.status ?? 'incomplete',
      missing: r.missing,
      qualified: r.qualified,
      duplicate: false,
    };
  },
});

// ---------- the copy, done ----------

export const fileFinishCopy = defineCommand({
  name: 'file.finish_copy',
  description:
    'Worker: a file a customer sent is copied from their message onto the record it was filed on. Marks it ready, as storage measured it, and puts it on the timeline.',
  risk: 1,
  input: FileFinishCopyInput,
  output: FileFinishCopyOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['file.attached'],
  actors: ['system'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, ctx.scope.workspaceId!)));
    if (!current || current.deletedAt) return { fileId: input.fileId, ready: false };
    if (current.status === 'ready') return { fileId: current.id, ready: true };
    const sizeBytes = input.sizeBytes;
    const mimeType = current.mimeType ?? 'application/octet-stream';
    await ctx.tx
      .update(files)
      .set({ status: 'ready', sizeBytes, mimeType })
      .where(eq(files.id, current.id));
    const eventId = await ctx.emit({
      type: 'file.attached',
      entityType: current.recordType,
      entityId: current.recordId,
      payload: { fileId: current.id, name: current.name, mimeType, sizeBytes },
      after: { name: current.name, mimeType, sizeBytes },
    });
    await logSystemActivity(ctx, {
      subtype: 'file_added',
      personId: current.recordType === 'person' ? current.recordId : null,
      leadId: current.recordType === 'lead' ? current.recordId : null,
      body: current.name,
      meta: { fileId: current.id, mimeType, sizeBytes, from: 'customer' },
      eventId,
    });
    return { fileId: current.id, ready: true };
  },
});
