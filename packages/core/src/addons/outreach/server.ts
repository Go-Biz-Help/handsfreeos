/**
 * Social Outreach, server side: its commands and queries (docs/outreach.md). Each is an ordinary kernel operation
 * stamped with the add-on, so it's refused, for every kind of actor, while the add-on is off, and everything it does
 * is its own in history. The business logic lives here: never in its screens, never in the extension.
 */
import type { AddonServerModule } from '../server';
import { OUTREACH_LOOK_ALIKES, OUTREACH_PLACES } from './ai-places';
import { OutreachSettingsSchema } from './chat-read';
import { outreachAddon } from './manifest';
import { activityCommands, activityQueries } from './ops/activity';
import { askCommands, askQueries } from './ops/asks';
import { alertCommands } from './ops/alerts';
import { automationCommands, automationQueries } from './ops/automation';
import { autopilotCommands, autopilotQueries } from './ops/autopilot';
import { chatCommands, chatQueries } from './ops/chats';
import { checkCommands, checkQueries } from './ops/checks';
import { countryCommands, countryQueries } from './ops/countries';
import { demoCommands } from './ops/demos';
import { findCommands, findQueries } from './ops/finds';
import { downloadCommands } from './ops/download';
import { friendCommands, friendQueries } from './ops/friends';
import { groupCheckCommands, groupCheckQueries } from './ops/group-checks';
import { helpfulCommands, helpfulQueries } from './ops/helpful';
import { groupCommands, groupQueries } from './ops/groups';
import { journeyQueries } from './ops/journey';
import { leadCommands } from './ops/leads';
import { commentResearchCommands, commentResearchQueries } from './ops/comment-research';
import { likeYoursCommands, likeYoursQueries } from './ops/like-yours';
import { eventsCommands, eventsQueries } from './ops/events-near';
import { activeCommands, activeQueries } from './ops/active';
import { followersCommands, followersQueries } from './ops/followers';
import { ownerCommands } from './ops/owners';
import { occasionCommands } from './ops/occasions';
import { listCommands, listQueries } from './ops/lists';
import { planCommands, planQueries } from './ops/plan';
import { liveCommands, liveQueries } from './ops/live';
import { meetingTimeCommands } from './ops/meeting-times';
import { tallyCommands, tallyQueries } from './ops/tallies';
import { openerCommands, openerQueries } from './ops/openers';
import { partnerCommands, partnerQueries } from './ops/partners';
import { personMenuCommands, personMenuQueries } from './ops/person-menu';
import { playbookCommands, playbookQueries } from './ops/playbooks';
import { saveCommands, saveQueries } from './ops/saves';
import { sendCommands, sendQueries } from './ops/sends';
import { conversationCommands, conversationQueries } from './ops/conversation';
import { readinessCommands, readinessQueries } from './ops/readiness';
import { requestPauseCommands } from './ops/request-pause';
import { setupCommands, setupQueries } from './ops/setup';
import { stageCommands, stageQueries } from './ops/stages';
import { tidyCommands, tidyQueries } from './ops/tidy';
import { townQueries } from './ops/towns';
import { localCommands, localQueries } from './ops/local';
import { postCommands, postQueries } from './ops/posts';
import { referralCommands, referralQueries } from './ops/referrals';
import { callCommands } from './ops/calls';
import { handsCommands, handsQueries } from './ops/in-hands';
import { commentReplyCommands } from './ops/comment-replies';
import { todayQueries } from './ops/today';
import { trackingCommands, trackingQueries } from './ops/tracking';
import { waitingCommands, waitingQueries } from './ops/waiting';

/** Why the Assistant never runs the comment research (decision 166). */
const RESEARCH =
  'HandsFreeOS’s own study of how people comment, run by its staff from Social Outreach → Settings: no business’s to run.';
/** Why the Assistant never runs what the extension sends in. */
const EXTENSION = 'What the browser extension read, saw or did, as the person’s own browser.';

export const outreachAddonServer: AddonServerModule = {
  manifest: outreachAddon,
  settings: { workspace: OutreachSettingsSchema },
  // Its pages, said only where it runs (decision 127's side menu), so the Assistant names them and the one open.
  ai: { places: OUTREACH_PLACES, lookAlikes: OUTREACH_LOOK_ALIKES },
  commands: [
    ...playbookCommands,
    ...saveCommands,
    ...activityCommands,
    ...friendCommands,
    ...downloadCommands,
    ...chatCommands,
    ...groupCommands,
    ...tidyCommands,
    ...requestPauseCommands,
    ...postCommands,
    ...commentReplyCommands,
    ...alertCommands,
    ...openerCommands,
    ...demoCommands,
    ...automationCommands,
    ...autopilotCommands,
    ...sendCommands,
    ...meetingTimeCommands,
    ...liveCommands,
    ...tallyCommands,
    ...listCommands,
    ...planCommands,
    ...waitingCommands,
    ...askCommands,
    ...setupCommands,
    ...readinessCommands,
    ...conversationCommands,
    ...checkCommands,
    ...stageCommands,
    ...groupCheckCommands,
    ...helpfulCommands,
    ...referralCommands,
    ...callCommands,
    ...handsCommands,
    ...countryCommands,
    ...localCommands,
    ...trackingCommands,
    ...partnerCommands,
    ...personMenuCommands,
    ...findCommands,
    ...leadCommands,
    ...ownerCommands,
    ...occasionCommands,
    ...likeYoursCommands,
    ...commentResearchCommands,
    ...eventsCommands,
    ...followersCommands,
    ...activeCommands,
  ],
  queries: [
    ...playbookQueries,
    ...saveQueries,
    ...activityQueries,
    ...friendQueries,
    ...chatQueries,
    ...groupQueries,
    ...todayQueries,
    ...tidyQueries,
    ...postQueries,
    ...openerQueries,
    ...automationQueries,
    ...autopilotQueries,
    ...sendQueries,
    ...liveQueries,
    ...tallyQueries,
    ...listQueries,
    ...planQueries,
    ...waitingQueries,
    ...askQueries,
    ...setupQueries,
    ...readinessQueries,
    ...conversationQueries,
    ...checkQueries,
    ...stageQueries,
    ...groupCheckQueries,
    ...helpfulQueries,
    ...referralQueries,
    ...handsQueries,
    ...countryQueries,
    ...trackingQueries,
    ...partnerQueries,
    ...personMenuQueries,
    ...findQueries,
    ...journeyQueries,
    ...likeYoursQueries,
    ...commentResearchQueries,
    ...eventsQueries,
    ...followersQueries,
    ...activeQueries,
    ...townQueries,
    ...localQueries,
  ],
  // What the extension sends in: only the person's own browser can see Facebook, Instagram, LinkedIn and Alignable.
  notForTheAssistant: {
    'outreach.lookup': EXTENSION,
    'outreach.follow_backs.next': EXTENSION,
    'outreach.helpful.next': EXTENSION,
    'outreach.touch.save': EXTENSION,
    'outreach.friend.note': EXTENSION,
    'outreach.friends.save': EXTENSION,
    'outreach.download.save': EXTENSION,
    'outreach.chats.collect': EXTENSION,
    'outreach.groups.save': EXTENSION,
    'outreach.group.save': EXTENSION,
    'outreach.friend.end': EXTENSION,
    'outreach.warning.note': EXTENSION,
    'outreach.requests.pause': EXTENSION,
    'outreach.posts.save': EXTENSION,
    'outreach.comment_replies.save': EXTENSION,
    'outreach.replies.note': EXTENSION,
    'outreach.warm_up.missed': EXTENSION,
    'outreach.request.closed': EXTENSION,
    'outreach.send.queue': EXTENSION,
    'outreach.send.done': EXTENSION,
    'outreach.live.beat': EXTENSION,
    'outreach.lists.saved': EXTENSION,
    'outreach.plan.note': EXTENSION,
    'outreach.plan.next': EXTENSION,
    'outreach.need.note': EXTENSION,
    'outreach.ask.take': EXTENSION,
    'outreach.ask.progress': EXTENSION,
    'outreach.ask.end': EXTENSION,
    'outreach.profile.usernames_save': EXTENSION,
    'outreach.check.look': EXTENSION,
    'outreach.group.look': EXTENSION,
    'outreach.join.note': EXTENSION,
    'outreach.helpful.engaged': EXTENSION,
    'outreach.engaged.save': EXTENSION,
    'outreach.partner.leads': EXTENSION,
    'outreach.partner.look': EXTENSION,
    'outreach.posts.people_next': EXTENSION,
    'outreach.finds.save': EXTENSION,
    'outreach.finds.next': EXTENSION,
    'outreach.finds.searches': EXTENSION,
    'outreach.occasions.save': EXTENSION,
    'outreach.like_yours.next': EXTENSION,
    'outreach.like_yours.found': EXTENSION,
    'outreach.like_yours.read': EXTENSION,
    'outreach.events.next': EXTENSION,
    'outreach.events.read': EXTENSION,
    'outreach.followers.next': EXTENSION,
    'outreach.followers.save': EXTENSION,
    'outreach.active.next': EXTENSION,
    'outreach.active.reply': EXTENSION,
    'outreach.finds.towns': EXTENSION,
    'outreach.referrals.due': EXTENSION,
    'outreach.referral.posted': EXTENSION,
    'outreach.refer_ask.sent': EXTENSION,
    'outreach.comment_research.next': EXTENSION,
    'outreach.comment_research.save': EXTENSION,
    'outreach.comment_research.get': RESEARCH,
    'outreach.comment_research.start': RESEARCH,
    'outreach.comment_research.stop': RESEARCH,
    'outreach.comment_research.use': RESEARCH,
    'outreach.live.watch':
      'The ticker saying it’s on screen, so the extension tells what it’s doing every few seconds.',
    'outreach.ticker':
      'The ticker’s own light read, asked every few seconds: the Assistant reads the same and more through outreach_live.',
    'outreach.opener.use':
      'The screens noting which opener a copied first message was drafted with.',
  },
};
