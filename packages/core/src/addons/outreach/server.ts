/**
 * Social Outreach, server side: its commands and queries (docs/outreach.md). Each is an ordinary kernel operation
 * stamped with the add-on, so it's refused, for every kind of actor, while the add-on is off, and everything it does
 * is its own in history. The business logic lives here: never in its screens, never in the extension.
 */
import type { AddonServerModule } from '../server';
import { outreachAddon } from './manifest';
import { activityCommands, activityQueries } from './ops/activity';
import { askCommands, askQueries } from './ops/asks';
import { alertCommands } from './ops/alerts';
import { automationCommands, automationQueries } from './ops/automation';
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
import { likeYoursCommands, likeYoursQueries } from './ops/like-yours';
import { eventsCommands, eventsQueries } from './ops/events-near';
import { activeCommands, activeQueries } from './ops/active';
import { followersCommands, followersQueries } from './ops/followers';
import { ownerCommands } from './ops/owners';
import { occasionCommands } from './ops/occasions';
import { listCommands, listQueries } from './ops/lists';
import { liveCommands, liveQueries } from './ops/live';
import { tallyCommands, tallyQueries } from './ops/tallies';
import { openerCommands, openerQueries } from './ops/openers';
import { partnerCommands, partnerQueries } from './ops/partners';
import { personMenuCommands, personMenuQueries } from './ops/person-menu';
import { playbookCommands, playbookQueries } from './ops/playbooks';
import { saveCommands, saveQueries } from './ops/saves';
import { sendCommands, sendQueries } from './ops/sends';
import { conversationCommands, conversationQueries } from './ops/conversation';
import { readinessCommands, readinessQueries } from './ops/readiness';
import { setupCommands, setupQueries } from './ops/setup';
import { stageCommands, stageQueries } from './ops/stages';
import { tidyCommands, tidyQueries } from './ops/tidy';
import { townQueries } from './ops/towns';
import { postCommands, postQueries } from './ops/posts';
import { todayQueries } from './ops/today';
import { trackingCommands, trackingQueries } from './ops/tracking';
import { waitingCommands, waitingQueries } from './ops/waiting';

/** Why the Assistant never runs what the extension sends in. */
const EXTENSION = 'What the browser extension read, saw or did, as the person’s own browser.';

export const outreachAddonServer: AddonServerModule = {
  manifest: outreachAddon,
  commands: [
    ...playbookCommands,
    ...saveCommands,
    ...activityCommands,
    ...friendCommands,
    ...downloadCommands,
    ...chatCommands,
    ...groupCommands,
    ...tidyCommands,
    ...postCommands,
    ...alertCommands,
    ...openerCommands,
    ...demoCommands,
    ...automationCommands,
    ...sendCommands,
    ...liveCommands,
    ...tallyCommands,
    ...listCommands,
    ...waitingCommands,
    ...askCommands,
    ...setupCommands,
    ...readinessCommands,
    ...conversationCommands,
    ...checkCommands,
    ...stageCommands,
    ...groupCheckCommands,
    ...helpfulCommands,
    ...countryCommands,
    ...trackingCommands,
    ...partnerCommands,
    ...personMenuCommands,
    ...findCommands,
    ...leadCommands,
    ...ownerCommands,
    ...occasionCommands,
    ...likeYoursCommands,
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
    ...sendQueries,
    ...liveQueries,
    ...tallyQueries,
    ...listQueries,
    ...waitingQueries,
    ...askQueries,
    ...setupQueries,
    ...readinessQueries,
    ...conversationQueries,
    ...checkQueries,
    ...stageQueries,
    ...groupCheckQueries,
    ...helpfulQueries,
    ...countryQueries,
    ...trackingQueries,
    ...partnerQueries,
    ...personMenuQueries,
    ...findQueries,
    ...journeyQueries,
    ...likeYoursQueries,
    ...eventsQueries,
    ...followersQueries,
    ...activeQueries,
    ...townQueries,
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
    'outreach.posts.save': EXTENSION,
    'outreach.replies.note': EXTENSION,
    'outreach.warm_up.missed': EXTENSION,
    'outreach.send.queue': EXTENSION,
    'outreach.send.done': EXTENSION,
    'outreach.live.beat': EXTENSION,
    'outreach.lists.saved': EXTENSION,
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
    'outreach.live.watch':
      'The ticker saying it’s on screen, so the extension tells what it’s doing every few seconds.',
    'outreach.ticker':
      'The ticker’s own light read, asked every few seconds: the Assistant reads the same and more through outreach_live.',
    'outreach.opener.use':
      'The screens noting which opener a copied first message was drafted with.',
  },
};
