-- Design tools, part 5 (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md): a campaign email written in blocks (words, a
-- picture, a button, a line, a space), each lined up on the left, in the centre or on the right. The email's plain
-- words stay in email_body, worked out from the blocks, for mail apps that show text only and everything that reads
-- the body already. Null: an email written as plain words, as before.
alter table app.campaigns
  add column email_blocks jsonb
    check (
      email_blocks is null
      or (jsonb_typeof(email_blocks) = 'array' and jsonb_array_length(email_blocks) between 1 and 40)
    );

grant update (email_blocks) on app.campaigns to authenticated;
