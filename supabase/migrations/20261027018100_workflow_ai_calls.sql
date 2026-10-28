-- AI calls, part 2: a workflow's "AI teammate calls them" step (workflows' `call_with_ai` action). Its call is an
-- `app.ai_calls` row with purpose `workflow`, keeping the step's call playbook beside it: what to find out, what it
-- may offer, and when to book. Only to someone who agreed to calls in writing (`people.call_consent`), checked when
-- the step runs and again just before the call.

alter table app.ai_calls drop constraint if exists ai_calls_purpose_check;
alter table app.ai_calls add constraint ai_calls_purpose_check
  check (purpose in ('confirm_visit', 'missed_call', 'quote', 'campaign', 'workflow'));

-- {"findOut": "…", "offer": "…", "book": "when_ready" | "always" | "never"}; null for the other reasons.
alter table app.ai_calls add column if not exists playbook jsonb
  check (playbook is null or (jsonb_typeof(playbook) = 'object' and length(playbook::text) <= 4000));
