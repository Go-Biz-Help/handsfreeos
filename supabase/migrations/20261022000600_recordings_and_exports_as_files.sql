-- =============================================================================
-- Recordings and exports as files (Real Estate round six, steps 8 and 10;
-- core).
--
--        A field note can be spoken: the phone records it and uploads it as
--        one of the deal's files, so the attachments bucket takes audio
--        (AAC in an MP4 box from phones, MP3, and the web's WebM). A
--        transaction export is a zip the worker keeps on the deal
--        (`file.store`); people can't upload zips (core's ATTACHMENT_TYPES
--        leaves them out), only the worker stores one.
-- =============================================================================

update storage.buckets
set allowed_mime_types = (
  select array_agg(distinct t order by t)
  from unnest(allowed_mime_types || array['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/webm', 'application/zip']) t
)
where id = 'attachments';
