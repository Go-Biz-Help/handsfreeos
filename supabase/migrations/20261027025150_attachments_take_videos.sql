-- A business's files take videos (AI Social Media Content Creator, part 10): the person's own video for one of their
-- posts, recorded from its script, is kept as a file on the post like its pictures, and the extension puts it up on
-- Instagram from there. MP4 and QuickTime (what phones record) and WebM, within the bucket's 25 MB, as
-- `ATTACHMENT_TYPES` in packages/core/src/schemas/file.ts now lists them.
update storage.buckets
set allowed_mime_types = (
  select array_agg(distinct t order by t)
  from unnest(allowed_mime_types || array['video/mp4', 'video/quicktime', 'video/webm']) t
)
where id = 'attachments';
