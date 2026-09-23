-- Promotions: an offer can drive an outreach campaign, and Home says when one is about to end.
--
-- `campaigns.offer_id` is the offer a campaign is about (Knowledge → Offers): the AI writes each text from its
-- name, details and end date as well as the owner's goal. Archiving or deleting the offer leaves the campaign be.
--
-- `offer_lapsing` (Automations' "Offer ending") is a card three days before an offer's last day, until it's
-- extended, archived or over.

alter table app.campaigns
  add column offer_id uuid references app.offers (id) on delete set null;
create index campaigns_offer_idx on app.campaigns (offer_id) where offer_id is not null;

-- A campaign's offer belongs to the same business.
create or replace function private.check_campaign_offer()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.offer_id is not null and not exists (
    select 1 from app.offers o where o.id = new.offer_id and o.workspace_id = new.workspace_id) then
    raise exception 'That belongs to another business'
      using errcode = '23514', detail = 'cross_workspace';
  end if;
  return new;
end $$;
create trigger campaigns_check_offer before insert or update of offer_id on app.campaigns
  for each row execute function private.check_campaign_offer();

-- ---------- the cards ----------
alter table app.attention_items
  drop constraint attention_items_kind_check,
  add constraint attention_items_kind_check check (kind in (
    'hot_lead',
    'unanswered_lead',
    'stale_opportunity',
    'missing_next_action',
    'unconfirmed_appointment',
    'ai_approval',
    'customer_waiting',
    'overdue_task',
    'estimate_waiting',
    'invoice_overdue',
    'wallet_low',
    'wallet_empty',
    'wallet_card_declined',
    'job_not_thanked',
    'referral_mentioned',
    'maintenance_due',
    'pipeline_mismatch',
    'quiet_after_price',
    'job_unconfirmed',
    'job_never_completed',
    'job_no_address',
    'client_quiet',
    'promise_due',
    'revenue_moved',
    'channel_quiet',
    'connection_error',
    'connection_silent',
    'ai_unreviewed',
    'ai_corrections',
    'website_changed',
    'faq_suggestions',
    'offer_lapsing'
  ));
