import type { CommandDef } from '../kernel/types';
import { activityDelete, activityLog, activityUpdate } from './activity';
import { companyArchive } from './company.archive';
import {
  conversationAssign,
  conversationClose,
  conversationLinkPerson,
  conversationMarkRead,
  conversationMarkUnread,
  conversationOpen,
  conversationReopen,
  conversationSnooze,
} from './conversation';
import {
  messageAttachMedia,
  messageReceive,
  messageRetry,
  messageSend,
  messageUpdateStatus,
  personSetSmsConsent,
} from './message';
import {
  phoneNumberActivate,
  phoneNumberBuy,
  phoneNumberFail,
  phoneNumberMarkReleased,
  phoneNumberRelease,
  phoneNumberSetRouting,
  phoneUpdateSettings,
} from './phone';
import { registrationSubmit, registrationUpdateStatus } from './registration';
import { companyCreate } from './company.create';
import { companyRestore } from './company.restore';
import { companyUpdate } from './company.update';
import { fileBeginUpload, fileConfirm, fileDelete } from './file';
import { importCancel, importCreate, importStart } from './import';
import { invitationAccept } from './invitation.accept';
import { invitationResend } from './invitation.resend';
import { invitationRevoke } from './invitation.revoke';
import { leadArchive, leadRestore } from './lead.archive';
import { leadCreate } from './lead.create';
import { leadMoveStage } from './lead.move_stage';
import { leadSetNextAction } from './lead.set_next_action';
import { leadUpdate } from './lead.update';
import { membershipChangeRole } from './membership.change_role';
import { membershipInvite } from './membership.invite';
import { membershipRemove } from './membership.remove';
import { organizationCreate } from './organization.create';
import { personArchive } from './person.archive';
import { personCreate } from './person.create';
import { personRestore } from './person.restore';
import { personUpdate } from './person.update';
import { pipelineArchive } from './pipeline.archive';
import { pipelineCreate } from './pipeline.create';
import { pipelineUpdate } from './pipeline.update';
import { recordSetTags } from './record.set_tags';
import { stageCreate } from './stage.create';
import { stageDelete } from './stage.delete';
import { stageReorder } from './stage.reorder';
import { stageUpdate } from './stage.update';
import { tagCreate } from './tag.create';
import { tagDelete } from './tag.delete';
import { tagUpdate } from './tag.update';
import { taskComplete, taskCreate, taskDelete, taskReopen, taskUpdate } from './task';
import { userUpdateProfile } from './user.update_profile';
import { workspaceCreate } from './workspace.create';
import { workspaceUpdate } from './workspace.update';

export {
  conversationAssign,
  conversationClose,
  conversationLinkPerson,
  conversationMarkRead,
  conversationMarkUnread,
  conversationOpen,
  conversationReopen,
  conversationSnooze,
  messageAttachMedia,
  messageReceive,
  messageRetry,
  messageSend,
  messageUpdateStatus,
  personSetSmsConsent,
  phoneNumberActivate,
  phoneNumberBuy,
  phoneNumberFail,
  phoneNumberMarkReleased,
  phoneNumberRelease,
  phoneNumberSetRouting,
  phoneUpdateSettings,
  registrationSubmit,
  registrationUpdateStatus,
  activityDelete,
  activityLog,
  activityUpdate,
  companyArchive,
  companyCreate,
  companyRestore,
  companyUpdate,
  fileBeginUpload,
  fileConfirm,
  fileDelete,
  importCancel,
  importCreate,
  importStart,
  invitationAccept,
  invitationResend,
  invitationRevoke,
  leadArchive,
  leadCreate,
  leadMoveStage,
  leadRestore,
  leadSetNextAction,
  leadUpdate,
  membershipChangeRole,
  membershipInvite,
  membershipRemove,
  organizationCreate,
  personArchive,
  personCreate,
  personRestore,
  personUpdate,
  pipelineArchive,
  pipelineCreate,
  pipelineUpdate,
  recordSetTags,
  stageCreate,
  stageDelete,
  stageReorder,
  stageUpdate,
  tagCreate,
  tagDelete,
  tagUpdate,
  taskComplete,
  taskCreate,
  taskDelete,
  taskReopen,
  taskUpdate,
  userUpdateProfile,
  workspaceCreate,
  workspaceUpdate,
};
export { hashInvitationToken } from './invitation.accept';
export { INVITATION_TTL_MS } from './membership.invite';
export { DEFAULT_STAGES } from './pipeline.create';

/** Explicit list on purpose: greppable, bundler-safe, and the order the docs list them in. */
export const commands: readonly CommandDef[] = [
  organizationCreate,
  workspaceCreate,
  workspaceUpdate,
  membershipInvite,
  invitationResend,
  invitationRevoke,
  invitationAccept,
  membershipChangeRole,
  membershipRemove,
  userUpdateProfile,
  pipelineCreate,
  pipelineUpdate,
  pipelineArchive,
  stageCreate,
  stageUpdate,
  stageReorder,
  stageDelete,
  companyCreate,
  companyUpdate,
  companyArchive,
  companyRestore,
  personCreate,
  personUpdate,
  personArchive,
  personRestore,
  tagCreate,
  tagUpdate,
  tagDelete,
  recordSetTags,
  leadCreate,
  leadUpdate,
  leadMoveStage,
  leadSetNextAction,
  leadArchive,
  leadRestore,
  taskCreate,
  taskUpdate,
  taskComplete,
  taskReopen,
  taskDelete,
  activityLog,
  activityUpdate,
  activityDelete,
  fileBeginUpload,
  fileConfirm,
  fileDelete,
  importCreate,
  importStart,
  importCancel,
  phoneNumberBuy,
  phoneNumberRelease,
  phoneNumberSetRouting,
  phoneUpdateSettings,
  phoneNumberActivate,
  phoneNumberFail,
  phoneNumberMarkReleased,
  registrationSubmit,
  registrationUpdateStatus,
  conversationOpen,
  conversationMarkRead,
  conversationMarkUnread,
  conversationAssign,
  conversationSnooze,
  conversationClose,
  conversationReopen,
  conversationLinkPerson,
  messageSend,
  messageRetry,
  messageReceive,
  messageUpdateStatus,
  messageAttachMedia,
  personSetSmsConsent,
] as unknown as readonly CommandDef[];
