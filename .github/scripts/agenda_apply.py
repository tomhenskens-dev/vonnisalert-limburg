#!/usr/bin/env python3
"""Zet agenda/updates/*.json om naar SQL (enkel bestanden die nog niet toegepast zijn).

Formaat van een updatebestand:
{
  "events": [
    {"id": "<uuid>", "status": "bevestigd", "start_date": "2027-10-16", ...},   # bestaand evenement bijwerken
    {"title": "Nieuw evenement", "start_date": "2027-11-01", "status": "voorspelling", ...}  # nieuw
  ],
  "requests_done": [{"id": "<uuid>", "status": "verwerkt", "note": "12 evenementen toegevoegd"}]
}
"""
import json, os, re, sys, glob

applied = set(json.loads(sys.argv[1] or "[]"))
FIELDS = ["title", "place", "start_date", "end_date", "status", "basis", "source_url", "previous", "notes"]
STATUS = {"bevestigd", "te_bevestigen", "voorspelling", "eenmalig"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

def lit(v):
    if v is None or v == "":
        return "null"
    s = str(v)
    tag = "$q$"
    n = 0
    while tag in s:
        n += 1
        tag = f"$q{n}$"
    return f"{tag}{s}{tag}"

def clean(ev):
    out = {}
    for k in FIELDS:
        if k in ev:
            v = ev[k]
            if k in ("start_date", "end_date") and v not in (None, "") and not DATE.match(str(v)):
                raise ValueError(f"ongeldige datum {k}={v}")
            if k == "status" and v not in STATUS:
                raise ValueError(f"ongeldige status {v}")
            if k == "source_url" and v and not re.match(r"^https?://", str(v)):
                v = None
            out[k] = v
    return out

sql = []
for path in sorted(glob.glob("agenda/updates/*.json")):
    name = os.path.basename(path)
    if name in applied:
        continue
    data = json.load(open(path, encoding="utf-8"))
    for ev in data.get("events", []):
        f = clean(ev)
        if ev.get("id"):
            if not UUID.match(ev["id"]):
                raise ValueError("ongeldig id " + ev["id"])
            sets = ", ".join(f"{k} = {lit(v)}" + ("::date" if k.endswith("_date") and v else "") for k, v in f.items())
            sql.append(f"update public.agenda_events set {sets + ', ' if sets else ''}checked_at = now() where id = {lit(ev['id'])};")
        else:
            if not f.get("title"):
                raise ValueError("nieuw evenement zonder titel")
            f.setdefault("status", "voorspelling")
            cols = ", ".join(list(f.keys()) + ["checked_at"])
            vals = ", ".join([lit(v) + ("::date" if k.endswith("_date") and v else "") for k, v in f.items()] + ["now()"])
            sd = lit(f.get("start_date")) + ("::date" if f.get("start_date") else "")
            sql.append(
                f"insert into public.agenda_events ({cols}) select {vals} where not exists "
                f"(select 1 from public.agenda_events where lower(title) = lower({lit(f['title'])}) "
                f"and coalesce(start_date, date '1900-01-01') = coalesce({sd}, date '1900-01-01'));"
            )
    for rq in data.get("requests_done", []):
        if not UUID.match(rq.get("id", "")):
            raise ValueError("ongeldig aanvraag-id")
        st = rq.get("status", "verwerkt")
        if st not in ("verwerkt", "mislukt"):
            st = "verwerkt"
        sql.append(f"update public.agenda_requests set status = {lit(st)}, result_note = {lit(rq.get('note'))}, processed_at = now() where id = {lit(rq['id'])};")
    sql.append(f"insert into public.agenda_updates_applied(name) values ({lit(name)}) on conflict do nothing;")
    print(f"-- {name}", file=sys.stderr)

print("\n".join(sql))
