-- The CRM demos playbook says what the owner says now (docs/outreach.md, decision 164).
--
-- A playbook holds its own words for every message now (`details.script`,
-- "What it says"), and the AI writes each message from them. A part a
-- playbook never changed follows the starting words, so most playbooks need
-- nothing. One started from the CRM demos template before this is brought
-- up to the template as it is today:
--
--   * its first message is the template's, the owner's own (decision 152);
--   * the AI's old opener styles, which nothing reads any more, are emptied;
--   * its old CRM conversation ("Do you use a CRM?" and what followed) goes:
--     a reply answers from the main offer and its lists for content instead
--     (the owner's pick 3). Questions that don't start with the template's
--     first one are the business's own, and stay.
--
-- A playbook that has its own openers is left alone: they become its first
-- messages when it is read (`upgradePlaybookDetails`). So is one that already
-- has `script`, so running this twice changes nothing.
--
-- Data only: no table, column, policy or function changes. The running code
-- reads a playbook with `script` as it reads any other key it doesn't know.

update addon_outreach.playbooks p
set details = p.details
      || jsonb_build_object(
           'script',
           jsonb_build_object(
             'first',
             jsonb_build_array(
               'Hey [first name], if I could get you more deals while also saving you time for your [their kind of business] business using my easy to use CRM software, would you be interested?'
             )
           ),
           'openerStyles', '[]'::jsonb
         )
      || case
           when p.details #>> '{questions,0,text}' = 'Do you use a CRM?'
             then jsonb_build_object('questions', '[]'::jsonb)
           else '{}'::jsonb
         end,
    updated_at = now()
where p.template = 'crm_demos'
  and not (p.details ? 'script')
  and jsonb_array_length(coalesce(p.details -> 'ownOpeners', '[]'::jsonb)) = 0;
