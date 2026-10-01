#!/usr/bin/env bash
#
# Move the Ley Legal database to another Supabase project - written for the
# Tokyo -> Mumbai move, usable for any region.
#
# A Supabase project cannot change region: moving means a new project and a
# copy of the data. Everything this app stores is in the `public` schema - it
# uses no Supabase Auth, Storage or Data API - so the copy is one pg_dump of
# `public`, restored in a single transaction: it lands complete or not at all.
#
#   ./scripts/move-database.sh check      read-only: both databases, versions, sizes, latency
#   ./scripts/move-database.sh rehearse   full copy into the new project, verified, then rolled back
#   ./scripts/move-database.sh copy       the real copy - app stopped - verified row for row, kept
#   ./scripts/move-database.sh switch     point .env at the new project (old .env kept as a backup)
#   ./scripts/move-database.sh rollback   put the old .env back
#
# The current database comes from .env (DIRECT_URL, else DATABASE_URL on the
# session port). The new one goes in .env.newdb, which git ignores:
#
#   NEW_DATABASE_URL=<new project, Connect -> Transaction pooler, port 6543>
#   NEW_DIRECT_URL=<new project, Connect -> Session pooler, port 5432>
#
# The Postgres tools run from the official postgres:17 Docker image, matching
# the server's major version, so nothing is installed on this shared host.
# Connection strings reach the container through the environment, never on a
# command line, and the dump is deleted when the script exits.
#
# For a local rehearsal of this script itself: MOVE_DB_TEST=1 relaxes the
# Supabase host checks and the pm2 check; ENV_DIR, DOCKER_NETWORK and PG_IMAGE
# override where .env lives, the container network and the tools image.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows would otherwise rewrite /work paths

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="${ENV_DIR:-$APP_DIR}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
DOCKER_NETWORK="${DOCKER_NETWORK:-host}"
TEST_MODE="${MOVE_DB_TEST:-0}"
WEB_APP="leylegal-web"
WORKER_APP="leylegal-worker"

# Column types and indexes in the dump name these as public.vector,
# public.halfvec, public.gin_trgm_ops... so the new project needs them in
# `public`, exactly where the migrations put them on the old one.
PUBLIC_EXTENSIONS="vector pg_trgm unaccent"

say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
ok()   { printf '    \033[1;32mok\033[0m  %s\n' "$1"; }
warn() { printf '\n\033[1;33m!!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31mxx\033[0m %s\n\n' "$1" >&2; exit 1; }

# --- configuration ------------------------------------------------------------

# The value of KEY in FILE, without surrounding quotes or a Windows line ending.
env_value() {
  [ -f "$1" ] || return 0
  { grep -m1 -E "^$2=" "$1" || true; } | cut -d= -f2- | tr -d '\r' | sed -E "s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}
masked()  { printf '%s' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:****@#'; }
host_of() { printf '%s' "$1" | sed -E 's#^[^@]*@([^:/?]+).*#\1#'; }
port_of() { printf '%s' "$1" | sed -E 's#^[^@]*@[^:/?]+:([0-9]+).*#\1#'; }
user_of() { printf '%s' "$1" | sed -E 's#^[a-z]+://([^:@/]+).*#\1#'; }

load_old() {
  OLD_URL="$(env_value "$ENV_DIR/.env" DIRECT_URL)"
  if [ -z "$OLD_URL" ]; then
    # The transaction pooler (6543) cannot hold pg_dump's session settings;
    # the same pooler host serves session mode on 5432.
    OLD_URL="$(env_value "$ENV_DIR/.env" DATABASE_URL)"
    OLD_URL="${OLD_URL/:6543\//:5432/}"
  fi
  [ -n "$OLD_URL" ] || die "No DATABASE_URL in $ENV_DIR/.env"
  if [ "$TEST_MODE" != 1 ] && [ "$(port_of "$OLD_URL")" != 5432 ]; then
    die "The current database URL is not on the session port 5432: $(masked "$OLD_URL")"
  fi
  export SRC="$OLD_URL"
}

load_new() {
  local file="$ENV_DIR/.env.newdb"
  [ -f "$file" ] || die "No $file yet. Create it with NEW_DATABASE_URL and NEW_DIRECT_URL - see the top of this script."
  NEW_URL="$(env_value "$file" NEW_DIRECT_URL)"
  NEW_APP_URL="$(env_value "$file" NEW_DATABASE_URL)"
  [ -n "$NEW_URL" ] && [ -n "$NEW_APP_URL" ] || die "$file needs both NEW_DIRECT_URL and NEW_DATABASE_URL."
  case "$NEW_URL $NEW_APP_URL" in
    *'['*|*']'*) die "$file still contains a [PLACEHOLDER] - put the real database password in its place." ;;
  esac

  if [ "$TEST_MODE" != 1 ]; then
    case "$(host_of "$NEW_URL") $(host_of "$NEW_APP_URL")" in
      *pooler.supabase.com*pooler.supabase.com) ;;
      *) die "Use the pooler strings from the new project's Connect panel (Session pooler and Transaction pooler).
   The Direct connection is IPv6-only on the free plan and this server cannot reach it." ;;
    esac
    [ "$(port_of "$NEW_URL")" = 5432 ] || die "NEW_DIRECT_URL must be the Session pooler (port 5432)."
    [ "$(port_of "$NEW_APP_URL")" = 6543 ] || die "NEW_DATABASE_URL must be the Transaction pooler (port 6543)."
    [ "$(user_of "$NEW_URL")" = "$(user_of "$NEW_APP_URL")" ] || die "NEW_DIRECT_URL and NEW_DATABASE_URL are for different projects."
    [ "$(user_of "$NEW_URL")" != "$(user_of "${OLD_URL:-x}")" ] || die "The new connection strings point at the CURRENT project. They must be the new project's."
  fi
  [ "$(masked "$NEW_URL")" != "$(masked "${OLD_URL:-x}")" ] || die "The new database is the same as the current one."
  export DST="$NEW_URL"
}

# --- Postgres tools in a throwaway container ------------------------------------

WORK="$(mktemp -d "${TMPDIR:-/tmp}/leylegal-db-move.XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
MOUNT="$WORK"
command -v cygpath >/dev/null 2>&1 && MOUNT="$(cygpath -m "$WORK")"

pg() { docker run --rm -i --network "$DOCKER_NETWORK" -e SRC -e DST -v "$MOUNT:/work" "$PG_IMAGE" "$@"; }

# Run /work/<file> against SRC or DST; tuples only, stop at the first error.
sql_on() { pg sh -c "psql \"\$$1\" -X -q -At -v ON_ERROR_STOP=1 -f /work/$2"; }

ensure_image() {
  command -v docker >/dev/null || die "Docker is needed to run the Postgres tools."
  docker image inspect "$PG_IMAGE" >/dev/null 2>&1 && return 0
  say "Fetching the $PG_IMAGE image (one time)"
  docker pull -q "$PG_IMAGE" >/dev/null
}

# --- facts about one database -----------------------------------------------------

# Sets F_VERSION (major), F_SIZE, F_TABLES, F_EXT ("name in schema, ..."),
# F_AVAILABLE (which of PUBLIC_EXTENSIONS this server offers), F_BYPASS (whether
# the connecting role reads past row-level security) and F_RTT (median round
# trip of a trivial query, ms).
facts() {
  cat > "$WORK/facts.sql" <<'SQL'
select 'version|' || (current_setting('server_version_num')::int / 10000);
select 'size|' || pg_size_pretty(pg_database_size(current_database()));
select 'tables|' || count(*) from pg_tables where schemaname = 'public';
select 'ext|' || coalesce(string_agg(extname || ' in ' || extnamespace::regnamespace, ', ' order by extname), '') from pg_extension;
select 'available|' || coalesce(string_agg(name, ' ' order by name), '') from pg_available_extensions where name in ('vector', 'pg_trgm', 'unaccent');
select 'bypass|' || case when rolsuper or rolbypassrls then 't' else 'f' end from pg_roles where rolname = current_user;
\timing on
select 1; select 1; select 1; select 1; select 1; select 1; select 1; select 1; select 1; select 1; select 1; select 1;
SQL
  local out
  out="$(sql_on "$1" facts.sql)" || die "Could not connect to the $2 database ($(masked "$3"))."
  F_VERSION="$(printf '%s\n' "$out" | sed -n 's/^version|//p')"
  F_SIZE="$(printf '%s\n' "$out" | sed -n 's/^size|//p')"
  F_TABLES="$(printf '%s\n' "$out" | sed -n 's/^tables|//p')"
  F_EXT="$(printf '%s\n' "$out" | sed -n 's/^ext|//p')"
  F_AVAILABLE="$(printf '%s\n' "$out" | sed -n 's/^available|//p')"
  F_BYPASS="$(printf '%s\n' "$out" | sed -n 's/^bypass|//p')"
  # Twelve round trips on one connection; the first two warm up, the median of the rest.
  F_RTT="$(printf '%s\n' "$out" | sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' | tail -n +3 | sort -n | awk '{a[NR]=$1} END {if (NR) printf "%.1f", (NR % 2 ? a[(NR+1)/2] : (a[NR/2] + a[NR/2+1]) / 2)}')"
}

describe() { # label url
  printf '    %-8s %s\n' "$1" "$(masked "$2")"
  printf '             Postgres %s, %s, %s app tables, %s ms per round trip\n' "$F_VERSION" "$F_SIZE" "$F_TABLES" "${F_RTT:-?}"
  printf '             extensions: %s\n' "$F_EXT"
}

# Refuse anything that would make the restore fail half-understood.
assert_ready() {
  local image_major
  image_major="$(printf '%s' "$PG_IMAGE" | sed -nE 's/^postgres:([0-9]+).*/\1/p')"
  [ -n "$image_major" ] && [ "$image_major" -lt "$OLD_VERSION" ] &&
    die "The current database runs Postgres $OLD_VERSION; pg_dump from $PG_IMAGE cannot read it. Run with PG_IMAGE=postgres:$OLD_VERSION."
  [ "$NEW_VERSION" -ge "$OLD_VERSION" ] ||
    die "The new project runs Postgres $NEW_VERSION, older than the current $OLD_VERSION. Create it on $OLD_VERSION or later."
  # users, web_sessions, auth_tokens and others FORCE row-level security, so
  # only a role that bypasses it sees every row - on Supabase, `postgres`. Any
  # other role would have pg_dump stop at the first of them (or, told to
  # respect the policies, quietly dump nothing).
  [ "$OLD_BYPASS" = t ] ||
    die "The role in the current connection string cannot read past row-level security, so the dump would be incomplete.
   Use the postgres role (user postgres.<project-ref>), as the app does."
  [ "$NEW_BYPASS" = t ] ||
    die "The role in NEW_DIRECT_URL cannot read past row-level security, so the copy could not be verified.
   Use the new project's postgres role (user postgres.<project-ref>)."
  [ "$NEW_TABLES" = 0 ] ||
    die "The new project already has $NEW_TABLES tables in public. This script only copies into an empty project."
  local e placed
  for e in $PUBLIC_EXTENSIONS; do
    case " $NEW_AVAILABLE " in *" $e "*) ;; *) die "The new project does not offer the $e extension." ;; esac
    placed="$(printf '%s' "$NEW_EXT" | tr ',' '\n' | sed -nE "s/^ *$e in ([^ ]+) *$/\1/p")"
    if [ -n "$placed" ] && [ "$placed" != public ]; then
      die "On the new project $e is enabled in schema \"$placed\"; the data needs it in public.
   Disable it under Database -> Extensions and run this again - the script enables it in public itself."
    fi
  done
}

gather() {
  facts SRC current "$OLD_URL"
  OLD_VERSION="$F_VERSION"; OLD_TABLES="$F_TABLES"; OLD_BYPASS="$F_BYPASS"; describe current "$OLD_URL"
  facts DST new "$NEW_URL"
  NEW_VERSION="$F_VERSION"; NEW_TABLES="$F_TABLES"; NEW_EXT="$F_EXT"; NEW_AVAILABLE="$F_AVAILABLE"; NEW_BYPASS="$F_BYPASS"; describe new "$NEW_URL"
}

# --- dump, restore, verify -----------------------------------------------------------

dump() {
  say "Dumping the current database (schema public)"
  pg sh -c 'pg_dump "$SRC" --schema=public --no-owner --no-privileges --file=/work/dump.sql' ||
    die "pg_dump failed - nothing was changed anywhere."

  # A dump of one schema recreates the schema itself. Every Supabase project
  # already has `public`, and its stock comment needs the schema's owner, so
  # both lines become comments - the objects inside it are what is copied.
  sed -i -e 's/^\(CREATE SCHEMA public;\)$/-- \1/' -e 's/^\(COMMENT ON SCHEMA public IS .*\)$/-- \1/' "$WORK/dump.sql"

  # Rows per table, counted from the dump itself: COPY text format writes one
  # line per row (embedded newlines are escaped), ended by a line "\.".
  awk '/^COPY /{name=$2; n=0; inside=1; next} inside && /^\\\.$/{print name "|" n; inside=0; next} inside{n++}' \
    "$WORK/dump.sql" | sort > "$WORK/expected.txt"

  local tables copied
  tables="$(grep -c '^CREATE TABLE ' "$WORK/dump.sql" || true)"
  copied="$(wc -l < "$WORK/expected.txt" | tr -d ' ')"
  [ "$tables" = "$OLD_TABLES" ] && [ "$copied" = "$OLD_TABLES" ] ||
    die "The dump has $tables tables and $copied data sections; the database has $OLD_TABLES. Not restoring an incomplete dump."
  ok "$tables tables, $(awk -F'|' '{s += $2} END {print s}' "$WORK/expected.txt") rows, $(du -h "$WORK/dump.sql" | cut -f1)"
}

# One SELECT per table in the dump: "<table>|<rows>".
count_sql() { awk -F'|' '{printf "select %s || chr(124) || count(*) from %s;\n", "'\''" $1 "'\''", $1}' "$WORK/expected.txt"; }

# Inside the restore transaction: every table must hold exactly the dumped
# number of rows, or the error stops psql before COMMIT and it all rolls back.
guard_sql() {
  awk -F'|' '{printf "do $g$ begin if (select count(*) from %s) <> %s then raise exception %s; end if; end $g$;\n", $1, $2, "'\''row count differs for " $1 " - the dump had " $2 "'\''"}' "$WORK/expected.txt"
}

# One checksum per table over every row's text, in a fixed order and a fixed
# time zone, so two copies of the same data agree exactly.
checksum_sql() {
  echo "set statement_timeout = 0; set timezone = 'UTC'; set datestyle = 'ISO, YMD'; set extra_float_digits = 1;"
  awk -F'|' '{printf "select %s || chr(124) || coalesce(md5(string_agg(t::text, chr(10) order by t::text)), %s) from %s t;\n", "'\''" $1 "'\''", "'\''empty'\''", $1}' "$WORK/expected.txt"
}

sequence_sql() {
  echo "select 'seq:' || schemaname || '.' || sequencename || chr(124) || coalesce(last_value, 0) from pg_sequences where schemaname = 'public' order by 1;"
}

restore() { # COMMIT | ROLLBACK
  {
    echo '\set ON_ERROR_STOP on'
    echo 'BEGIN;'
    for e in $PUBLIC_EXTENSIONS; do echo "CREATE EXTENSION IF NOT EXISTS $e WITH SCHEMA public;"; done
    echo '\i /work/dump.sql'
    count_sql
    guard_sql
    echo "$1;"
  } > "$WORK/restore.sql"

  pg sh -c 'psql "$DST" -X -q -At -f /work/restore.sql' > "$WORK/restored.raw" 2> "$WORK/restore.err" || {
    sed -n '1,15p' "$WORK/restore.err" >&2
    die "The restore failed and was rolled back in full - the new project is unchanged and the site still runs on the old database."
  }
  { grep -E '^public\.[^|]+\|[0-9]+$' "$WORK/restored.raw" || true; } | sort > "$WORK/restored.txt"

  if ! diff -q "$WORK/expected.txt" "$WORK/restored.txt" >/dev/null; then
    join -t'|' -a1 -a2 -e '-' -o 0,1.2,2.2 "$WORK/expected.txt" "$WORK/restored.txt" | awk -F'|' '$2 != $3 {printf "    %-40s dump %s, restored %s\n", $1, $2, $3}' >&2
    die "Row counts after the restore do not match the dump."
  fi
  ok "every table restored with exactly the dumped number of rows"
}

# Lines of the form "key|value" from psql output; none is a valid answer.
rows_of() { { grep -E '\|' || true; } | sort; }

compare_sides() { # sqlfile what
  local old new
  old="$(sql_on SRC "$1")" || die "Could not read the $2 of the old database."
  new="$(sql_on DST "$1")" || die "Could not read the $2 of the new database."
  printf '%s\n' "$old" | rows_of > "$WORK/side-old.txt"
  printf '%s\n' "$new" | rows_of > "$WORK/side-new.txt"
  if ! diff -q "$WORK/side-old.txt" "$WORK/side-new.txt" >/dev/null; then
    join -t'|' -a1 -a2 -e '-' -o 0,1.2,2.2 "$WORK/side-old.txt" "$WORK/side-new.txt" | awk -F'|' '$2 != $3 {printf "    %-40s old %s, new %s\n", $1, $2, $3}' >&2
    die "$2 differ between the old and new database. The site still runs on the old one; nothing has been switched."
  fi
  ok "$2 identical on both ($(wc -l < "$WORK/side-old.txt" | tr -d ' ') compared)"
}

app_running() { # prints the names of our pm2 apps that are online
  [ "$TEST_MODE" = 1 ] && return 0
  command -v pm2 >/dev/null || return 0
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const list = JSON.parse(s.slice(s.indexOf("[")));
      const want = process.argv.slice(1);
      console.log(list.filter((p) => want.includes(p.name) && p.pm2_env.status === "online").map((p) => p.name).join(" "));
    });' "$WEB_APP" "$WORKER_APP"
}

# --- commands --------------------------------------------------------------------------

cmd_check() {
  ensure_image
  load_old
  if [ ! -f "$ENV_DIR/.env.newdb" ]; then
    say "Current database"
    facts SRC current "$OLD_URL"; describe current "$OLD_URL"
    warn "No .env.newdb yet, so only the current database was checked."
    return
  fi
  load_new
  say "Both databases"
  gather
  assert_ready
  say "Ready: the new project is empty and has everything the copy needs."
  echo "    Next: ./scripts/move-database.sh rehearse   (the site keeps running)"
}

cmd_rehearse() {
  ensure_image; load_old; load_new
  say "Both databases"; gather; assert_ready
  dump
  say "Restoring into the new project inside a transaction that is then rolled back"
  restore ROLLBACK
  facts DST new "$NEW_URL"
  [ "$F_TABLES" = 0 ] || die "After the rehearsal the new project has $F_TABLES tables; it should be empty."
  ok "rolled back - the new project is empty again"
  say "Rehearsal passed. The real copy will work the same way."
  echo "    Next, in a quiet hour:"
  echo "      pm2 stop $WEB_APP $WORKER_APP"
  echo "      ./scripts/move-database.sh copy"
}

cmd_copy() {
  ensure_image; load_old; load_new
  local running
  running="$(app_running)" || die "Could not read pm2's process list to confirm the app is stopped."
  [ -z "$running" ] || die "Still running: $running. Stop it first, so nothing is written during the copy:
      pm2 stop $WEB_APP $WORKER_APP"

  say "Both databases"; gather; assert_ready
  dump

  # The app is stopped, so the old database must still hold exactly what was dumped.
  count_sql > "$WORK/counts.sql"
  local now
  now="$(sql_on SRC counts.sql)" || die "Could not count the rows of the old database."
  printf '%s\n' "$now" | rows_of > "$WORK/old-now.txt"
  diff -q "$WORK/expected.txt" "$WORK/old-now.txt" >/dev/null ||
    die "The old database changed during the dump - is something still writing to it? Nothing was copied."

  say "Restoring into the new project"
  restore COMMIT

  say "Verifying the copy against the old database"
  checksum_sql > "$WORK/checksums.sql"
  compare_sides checksums.sql "table contents"
  sequence_sql > "$WORK/sequences.sql"
  compare_sides sequences.sql "sequence positions"

  awk -F'|' '{printf "analyze %s;\n", $1}' "$WORK/expected.txt" > "$WORK/analyze.sql"
  sql_on DST analyze.sql >/dev/null || die "The copy is complete and verified, but ANALYZE failed. Run the copy's next steps anyway; Postgres builds statistics on its own."
  ok "planner statistics built"

  say "Copy complete and identical. The site is still pointed at the old database."
  echo "    Next:"
  echo "      ./scripts/move-database.sh switch"
  echo "      ./scripts/deploy.sh"
}

cmd_switch() {
  # Checked first: once switched, .env and .env.newdb name the same database,
  # which load_new would rightly refuse as a copy onto itself.
  local current
  current="$(env_value "$ENV_DIR/.env" DATABASE_URL)"
  if [ -n "$current" ] && [ "$current" = "$(env_value "$ENV_DIR/.env.newdb" NEW_DATABASE_URL)" ]; then
    say "Already switched: .env points at the new project."
    return
  fi
  load_old; load_new

  ensure_image
  facts DST new "$NEW_URL"
  [ "$F_TABLES" -gt 0 ] || die "The new project is empty. Run the copy first."

  local backup
  backup="$ENV_DIR/.env.before-db-move-$(date +%Y%m%d-%H%M%S)"
  cp -p "$ENV_DIR/.env" "$backup"
  chmod 600 "$backup"
  NEW_DATABASE_URL="$NEW_APP_URL" NEW_DIRECT_URL="$NEW_URL" awk '
    /^DATABASE_URL=/ { print "DATABASE_URL=" ENVIRON["NEW_DATABASE_URL"]; d = 1; next }
    /^DIRECT_URL=/   { print "DIRECT_URL="   ENVIRON["NEW_DIRECT_URL"];   r = 1; next }
    { print }
    END {
      if (!d) print "DATABASE_URL=" ENVIRON["NEW_DATABASE_URL"]
      if (!r) print "DIRECT_URL="   ENVIRON["NEW_DIRECT_URL"]
    }' "$backup" > "$ENV_DIR/.env.tmp"
  mv "$ENV_DIR/.env.tmp" "$ENV_DIR/.env"
  chmod 600 "$ENV_DIR/.env"

  say ".env now points at the new project"
  echo "    DATABASE_URL=$(masked "$NEW_APP_URL")"
  echo "    DIRECT_URL=$(masked "$NEW_URL")"
  echo "    The old .env is kept as $(basename "$backup")"
  echo "    Next: ./scripts/deploy.sh   (it migrates nothing - the copy already has every migration)"
}

cmd_rollback() {
  local latest
  latest="$(ls -1t "$ENV_DIR"/.env.before-db-move-* 2>/dev/null | head -1 || true)"
  [ -n "$latest" ] || die "No .env.before-db-move-* backup found - there is nothing to roll back to."
  cp -p "$latest" "$ENV_DIR/.env"
  say ".env restored from $(basename "$latest") - it points at the old database again"
  echo "    DATABASE_URL=$(masked "$(env_value "$ENV_DIR/.env" DATABASE_URL)")"
  echo "    Next: ./scripts/deploy.sh"
  echo "    Anything written to the new database since the switch is not in the old one."
}

case "${1:-}" in
  check)    cmd_check ;;
  rehearse) cmd_rehearse ;;
  copy)     cmd_copy ;;
  switch)   cmd_switch ;;
  rollback) cmd_rollback ;;
  *) sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
