#!/usr/bin/env bash
# `pnpm sync:start`: the PowerSync Service beside the local Supabase stack (start that first with `pnpm supabase:start`).
#
#   - Its working data lives in a small Postgres of its own (hfos-sync-storage), as it will on Fly. It holds nothing
#     that can't be rebuilt, so it has no volume — but a running one is reused, state and all, so a start alone is
#     NOT a fresh copy. `pnpm sync:stop` is what removes it, and is the cure for a service that outlived a
#     `pnpm db:reset` and is holding a password the rebuilt database no longer has.
#   - It reads the local database as hfos_sync (migration 0057), which gets a local-only password here.
#   - Phones and tests reach it at http://127.0.0.1:54430 (HFOS_SYNC_PORT to change it).
#   - It waits until the first copy is done and says so, or prints why not.
#
# `pnpm sync:stop` removes both containers and the replication slot.
set -euo pipefail

if [[ -z "${DOCKER_HOST:-}" && -S "$HOME/.colima/default/docker.sock" ]]; then
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
fi

SYNC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_IMAGE="journeyapps/powersync-service:1.26.1@sha256:413a0c813e96935ebe7203b5759f8a594a7b7cd8aa42134713e63af637e0f079"
STORAGE_IMAGE="postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929"
NETWORK="supabase_network_HandsFreeOS"
DATABASE="supabase_db_HandsFreeOS"
AUTH_GATEWAY="supabase_kong_HandsFreeOS"
SERVICE="hfos-sync"
STORAGE="hfos-sync-storage"
PORT="${HFOS_SYNC_PORT:-54430}"
# Local-only values: nothing here is used outside this machine's Docker network.
SYNC_PASSWORD="hfos_sync_local_password"
STORAGE_PASSWORD="hfos_sync_local_storage"
ADMIN_TOKEN="${HFOS_SYNC_ADMIN_TOKEN:-hfos-sync-local-admin-token}"

if ! docker inspect -f '{{.State.Running}}' "$DATABASE" 2>/dev/null | grep -q true; then
  echo "The local Supabase database isn't running. Start it with: pnpm supabase:start" >&2
  exit 1
fi

psql_local() {
  docker exec -i -e PGPASSWORD=postgres "$DATABASE" psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -qAtX "$@"
}

if [[ "$(psql_local -c "select count(*) from pg_publication where pubname = 'powersync'")" != "1" ]]; then
  echo "The powersync publication is missing: apply the migrations first (pnpm supabase migration up)." >&2
  exit 1
fi
psql_local -c "alter role hfos_sync password '$SYNC_PASSWORD'"

if ! docker inspect -f '{{.State.Running}}' "$STORAGE" 2>/dev/null | grep -q true; then
  docker rm -f "$STORAGE" >/dev/null 2>&1 || true
  docker run -d --name "$STORAGE" --network "$NETWORK" \
    -e POSTGRES_USER=powersync -e POSTGRES_PASSWORD="$STORAGE_PASSWORD" -e POSTGRES_DB=powersync \
    "$STORAGE_IMAGE" >/dev/null
fi
for _ in $(seq 1 120); do
  docker exec "$STORAGE" pg_isready -U powersync -d powersync >/dev/null 2>&1 && break
  sleep 0.5
done

docker rm -f "$SERVICE" >/dev/null 2>&1 || true
docker create --name "$SERVICE" --network "$NETWORK" -p "127.0.0.1:$PORT:8080" \
  --cpus 1 --memory 1g \
  -e POWERSYNC_CONFIG_PATH=/config/service.yaml \
  -e PS_DATA_SOURCE_URI="postgresql://hfos_sync:$SYNC_PASSWORD@$DATABASE:5432/postgres" \
  -e PS_DATA_SOURCE_SSLMODE=disable \
  -e PS_STORAGE_URI="postgresql://powersync:$STORAGE_PASSWORD@$STORAGE:5432/powersync" \
  -e PS_STORAGE_SSLMODE=disable \
  -e PS_JWKS_URI="http://$AUTH_GATEWAY:8000/auth/v1/.well-known/jwks.json" \
  -e PS_ADMIN_TOKEN="$ADMIN_TOKEN" \
  -e NODE_OPTIONS=--max-old-space-size=800 \
  "$SERVICE_IMAGE" start -r unified >/dev/null
# The service runs as an unprivileged user, so the copied folder must be readable by everyone (mktemp makes it 700).
config_dir=$(mktemp -d)
trap 'rm -rf "$config_dir"' EXIT
cp "$SYNC_DIR/service.yaml" "$SYNC_DIR/sync-config.yaml" "$SYNC_DIR/scripts/status.mjs" "$config_dir/"
chmod 755 "$config_dir" && chmod 644 "$config_dir"/*
docker cp "$config_dir/." "$SERVICE:/config"
docker start "$SERVICE" >/dev/null

echo "Starting PowerSync on http://127.0.0.1:$PORT …"
started=$(date +%s)
while true; do
  diagnostics=$(curl -s -m 5 -X POST "http://127.0.0.1:$PORT/api/admin/v1/diagnostics" \
    -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{}' || true)
  if [[ -n "$diagnostics" ]]; then
    state=$(node -e '
      const d = JSON.parse(process.argv[1] || "{}").data ?? {};
      // Problems with the streams themselves, on the config and on each table it reads.
      const of = (rules) => rules ? [...(rules.errors ?? []),
        ...(rules.connections ?? []).flatMap((c) => (c.tables ?? []).flatMap((t) => t.errors ?? []))] : [];
      const problems = [...of(d.active_sync_rules), ...of(d.deploying_sync_rules)];
      const fatal = problems.filter((e) => e.level === "fatal").map((e) => e.message);
      if (fatal.length) { console.log("error " + JSON.stringify(fatal)); process.exit(0); }
      const c = d.active_sync_rules?.connections?.[0];
      if (!c?.initial_replication_done || d.deploying_sync_rules) { console.log("waiting"); process.exit(0); }
      const warnings = problems.map((e) => e.message);
      console.log("ready " + c.slot_name + (warnings.length ? " — warnings: " + JSON.stringify(warnings) : ""));
    ' "$diagnostics" 2>/dev/null || echo waiting)
    case "$state" in
      ready*) echo "PowerSync is ready (slot ${state#ready }), after $(($(date +%s) - started)) s."; exit 0 ;;
      error*) echo "PowerSync can't use the sync config: ${state#error }" >&2; exit 1 ;;
    esac
  fi
  if ! docker inspect -f '{{.State.Running}}' "$SERVICE" 2>/dev/null | grep -q true; then
    echo "PowerSync stopped while starting. The end of its log:" >&2
    docker logs --tail 20 "$SERVICE" >&2 || true
    exit 1
  fi
  if (($(date +%s) - started > 240)); then
    echo "PowerSync didn't finish its first copy in 4 minutes. Its log: docker logs $SERVICE" >&2
    exit 1
  fi
  sleep 1
done
