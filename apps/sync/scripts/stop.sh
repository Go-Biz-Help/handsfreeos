#!/usr/bin/env bash
# `pnpm sync:stop`: removes the local PowerSync Service and its storage, and drops its replication slot, so a stopped
# service never holds the local database's write-ahead log. The next `pnpm sync:start` copies everything afresh.
set -euo pipefail

if [[ -z "${DOCKER_HOST:-}" && -S "$HOME/.colima/default/docker.sock" ]]; then
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
fi

DATABASE="supabase_db_HandsFreeOS"

docker rm -f hfos-sync hfos-sync-storage >/dev/null 2>&1 || true

if docker inspect -f '{{.State.Running}}' "$DATABASE" 2>/dev/null | grep -q true; then
  # A slot stays active for a moment after its connection goes.
  for _ in $(seq 1 20); do
    dropped=$(docker exec -i -e PGPASSWORD=postgres "$DATABASE" psql -h 127.0.0.1 -U postgres -d postgres -qAtX -c \
      "select count(pg_drop_replication_slot(slot_name)) from pg_replication_slots
       where slot_name like 'hfos\_sync\_%' and not active" || echo 0)
    left=$(docker exec -i -e PGPASSWORD=postgres "$DATABASE" psql -h 127.0.0.1 -U postgres -d postgres -qAtX -c \
      "select count(*) from pg_replication_slots where slot_name like 'hfos\_sync\_%'" || echo 0)
    [[ "$left" == "0" ]] && break
    sleep 0.5
  done
  if [[ "$left" != "0" ]]; then
    echo "A replication slot is still in use: select * from pg_replication_slots" >&2
    exit 1
  fi
fi
echo "PowerSync stopped; its storage and replication slot are gone."
