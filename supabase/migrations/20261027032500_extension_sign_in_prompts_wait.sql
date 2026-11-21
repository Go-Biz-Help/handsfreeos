-- =============================================================================
-- Extension sign-in prompts wait after a refusal, and come only so often
-- (security audit, 21 November 2026).
--
--        Anyone who knows an email can send that person a sign-in prompt
--        (Send me a prompt, in the extension). The person now types the
--        number the extension shows rather than picking it from three, and
--        before every new prompt the worker asks how long that email must
--        wait:
--
--        - after a prompt for it was refused (a wrong number, or That wasn't
--          me), half an hour;
--        - after five prompts in an hour, until the oldest of them is an hour
--          old.
--
--        Zero means a prompt may go now. The answer is the same whether or not
--        the email has an account: requests for an email with none are kept
--        too (20261027002910). Read only; the worker refuses the start.
-- =============================================================================

create or replace function private.extension_sign_in_wait(p_email text)
returns integer
language sql stable security definer set search_path = '' as $$
  select greatest(
    0,
    coalesce((
      select ceil(extract(epoch from max(s.answered_at) + interval '30 minutes' - now()))::integer
      from app.extension_sign_ins s
      where s.email = lower(p_email)::extensions.citext
        and s.status = 'refused'
        and s.answered_at > now() - interval '30 minutes'
    ), 0),
    coalesce((
      select ceil(extract(epoch from min(r.created_at) + interval '1 hour' - now()))::integer
      from (
        select s.created_at from app.extension_sign_ins s
        where s.email = lower(p_email)::extensions.citext
          and s.created_at > now() - interval '1 hour'
        order by s.created_at desc
        limit 5
      ) r
      having count(*) >= 5
    ), 0)
  )
$$;

revoke all on function private.extension_sign_in_wait(text) from public;
grant execute on function private.extension_sign_in_wait(text) to service_actor;
