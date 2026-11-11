#!/usr/bin/env bash
# Past agenda/updates/*.json toe op de databank en exporteert de agenda + wachtende aanvragen
# naar de branch "agenda-export" (gelezen door de geplande Claude-taak).
set -euo pipefail
q() { jq -n --arg q "$1" '{query:$q}' | curl -sS --fail-with-body -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" --data @- ; }

applied=$(q "select coalesce(json_agg(name), '[]'::json) as n from public.agenda_updates_applied" | jq -c '.[0].n | if type=="string" then fromjson else . end')
SQL=$(python3 .github/scripts/agenda_apply.py "$applied")
if [ -n "$SQL" ]; then q "$SQL" > /dev/null; echo "Agenda-updates toegepast."; else echo "Geen nieuwe agenda-updates."; fi

q "select json_build_object(
     'exported_at', now(),
     'events', (select coalesce(json_agg(e order by e.start_date nulls last), '[]'::json) from public.agenda_events e),
     'requests', (select coalesce(json_agg(r order by r.created_at), '[]'::json) from public.agenda_requests r where r.status = 'wachtend')
   ) as export" | jq '.[0].export | if type=="string" then fromjson else . end' > /tmp/agenda-export.json
jq '{events: (.events|length), wachtend: (.requests|length)}' /tmp/agenda-export.json

mkdir -p /tmp/export && cp /tmp/agenda-export.json /tmp/export/agenda.json
cd /tmp/export && git init -q && git config user.name bot && git config user.email bot@users.noreply.github.com
git checkout -q -b agenda-export && git add . && git commit -qm "agenda export" && \
git push -fq "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}" agenda-export
