import { column, Table } from '@powersync/common';

/**
 * The phone's own tables for the changes a person makes, beside the synced ones in the same encrypted database.
 *
 * - `commands` is insert-only: nothing is kept on the phone, and each row is one entry in PowerSync's upload queue,
 *   the only thing the uploader sends. Its id is the change's id. A change is sent again by inserting it again, which
 *   puts it at the back of the queue.
 * - `outbox` is local-only and never uploaded: the truth for every change's state, from made to sent. A change's
 *   optimistic rows leave the synced tables at the next checkpoint once it's been handled; screens show the outbox over
 *   the synced data until the server's own rows arrive.
 * - `photo_uploads` is local-only: the photo track's progress for each photo (its outbox row has the same id).
 *
 * One change is one local transaction: its optimistic rows, its `commands` row and its `outbox` row.
 */

export const commandsTable = new Table({ name: column.text }, { insertOnly: true });

export const outboxTable = new Table(
  {
    /** The id the API sees (`x-hfos-command-id`): the change's own id, unless a fixed version needed a new one. */
    command_id: column.text,
    name: column.text,
    workspace_id: column.text,
    /** JSON, exactly as sent. */
    input: column.text,
    /** When the person did it, by the phone's clock (ISO 8601). */
    made_at: column.text,
    /** JSON array: the ids of the changes and photos it waits for. */
    depends_on: column.text,
    /** `queue` (PowerSync's upload queue) or `photo` (the photo track). */
    track: column.text,
    /** waiting, sending, held, ask, refused, retry or sent. */
    state: column.text,
    /** Why it's held, asked about, refused or set aside, in words. */
    reason: column.text,
    /** The API's `final`, `retry` or `ask`, when it answered with a refusal. */
    disposition: column.text,
    /** The refusal's rule (`stale_action`, `quiet_hours`, `validation`…), from the API or the phone's own check. */
    rule: column.text,
    /** JSON: the command's output once sent, or the refusal's body. */
    answer: column.text,
    attempts: column.integer,
    /** How many times the person changed what it sends (fixed or edited). */
    revision: column.integer,
    /** When the person answered "Still send?" yes (or fixed it), by the phone's clock. */
    confirmed_at: column.text,
    /** The order the person made changes in. */
    seq: column.integer,
    /** When it last went into the upload queue. */
    queued_at: column.text,
    /** When it reached the state it's in. */
    settled_at: column.text,
    /** When it went through. */
    sent_at: column.text,
  },
  { localOnly: true, indexes: { state: ['state'], seq: ['seq'] } },
);

export const photoUploadsTable = new Table(
  {
    workspace_id: column.text,
    /** The file's id, made by the phone (`file.begin_upload`'s `id`). */
    file_id: column.text,
    record_type: column.text,
    record_id: column.text,
    file_name: column.text,
    mime_type: column.text,
    size_bytes: column.integer,
    /** The shrunk photo's file name in this person's photos folder. */
    local_name: column.text,
    taken_at: column.text,
    /** begin, upload or confirm. */
    step: column.text,
    begin_command_id: column.text,
    confirm_command_id: column.text,
    bucket: column.text,
    object_path: column.text,
    bytes_sent: column.integer,
    /** Where a resumable upload (over 6 MB) continues. */
    resume_url: column.text,
    /** Failures in a row, for how long it waits before the next try. */
    tries: column.integer,
    next_try_at: column.text,
    /** Times the API said the file hadn't arrived and it was uploaded again. */
    upload_rounds: column.integer,
  },
  { localOnly: true },
);

/** The names of the phone's own tables; the schema generator refuses a synced table with any of them. */
export const LOCAL_TABLES = {
  commands: commandsTable,
  outbox: outboxTable,
  photo_uploads: photoUploadsTable,
} as const;
