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

CASE_FIELDS = ["title", "defendant", "author", "author_is_geert", "article_url", "published_at", "hearing_date",
               "verdict_date", "verdict_date_text", "date_certainty", "court", "status", "status_manual",
               "needs_review", "notes", "source"]
CASE_STATUS = {"aangekondigd", "morgen", "vandaag", "bevestigd", "uitgesteld", "check"}

def case_val(k, v):
    if v is None or v == "":
        return "null"
    if k in ("author_is_geert", "status_manual", "needs_review"):
        return "true" if v else "false"
    if k in ("hearing_date", "verdict_date"):
        if not DATE.match(str(v)): raise ValueError(f"ongeldige datum {k}")
        return lit(v) + "::date"
    if k == "published_at":
        return lit(v) + "::timestamptz"
    if k == "court" and v not in ("Hasselt", "Tongeren", "Te controleren"): raise ValueError("ongeldige rechtbank")
    if k == "status" and v not in CASE_STATUS: raise ValueError("ongeldige status")
    return lit(v)

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
    # Dossiers (bv. toegevoegd door Claude uit aangeleverde artikels); niet dubbel op titel
    for c in data.get("cases", []):
        f = {k: c[k] for k in CASE_FIELDS if k in c}
        if not f.get("title"): raise ValueError("dossier zonder titel")
        f.setdefault("source", "geplakt")
        cols = ", ".join(f.keys())
        vals = ", ".join(case_val(k, v) for k, v in f.items())
        msg = c.get("event", "Toegevoegd door Claude uit aangeleverde artikels.")
        sql.append(
            f"with ins as (insert into public.cases ({cols}) select {vals} where not exists "
            f"(select 1 from public.cases where lower(title) = lower({lit(f['title'])})) returning id) "
            f"insert into public.case_events (case_id, kind, message) select id, 'aangemaakt', {lit(msg)} from ins;"
        )
    # Gerechtsartikels (enkel titel, link, auteur en datum – geen artikeltekst in de publieke repo)
    for a in data.get("articles", []):
        if not a.get("article_id") or not a.get("url") or not a.get("title"):
            raise ValueError("artikel zonder id, link of titel")
        if not re.match(r"^https?://", a["url"]): raise ValueError("ongeldige link")
        src = a.get("source", "hln")
        sql.append(
            "insert into public.articles (article_id, source, url, title, author, published_at, premium, court_related, announcement) "
            f"values ({lit(a['article_id'])}, {lit(src)}, {lit(a['url'])}, {lit(a['title'])}, {lit(a.get('author'))}, "
            f"{lit(a.get('published_at'))}{'::timestamptz' if a.get('published_at') else ''}, {'true' if a.get('premium') else 'false'}, true, false) "
            "on conflict (article_id) do nothing;"
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
