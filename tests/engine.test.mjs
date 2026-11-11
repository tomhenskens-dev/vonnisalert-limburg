import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseRss, processItems, statusUpdates, buildDigest, buildReminder } from "../supabase/functions/_shared/engine.js";

// De echte feeds staan niet in de publieke repository (auteursrecht HBVL); lokaal aanwezig → test draait.
const has = (f) => fs.existsSync(new URL(`./fixtures/${f}`, import.meta.url));
const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

test("echte HBVL-feed (11/11/2026) wordt correct ingelezen", { skip: !has("hbvl-rss-2026-11-11.xml") }, () => {
  const items = parseRss(fixture("hbvl-rss-2026-11-11.xml"), "hbvl");
  assert.equal(items.length, 50);
  const it = items[0];
  assert.ok(it.url.startsWith("https://www.hbvl.be/"));
  assert.ok(it.id && /^\d+$/.test(it.id));
  assert.ok(it.publishedAt && it.updatedAt);
  assert.ok(items.some((i) => i.author));
  // Geen enkel artikel in deze feed kondigt een uitspraak aan → geen valse dossiers
  const r = processItems(items, {});
  assert.equal(r.inserts.length, 0);
});

test("Google News-feed: de aankondiging over de Truiense reisagente wordt een dossier", { skip: !has("googlenews-hbvl-2026-11-11.xml") }, () => {
  const items = parseRss(fixture("googlenews-hbvl-2026-11-11.xml"), "google");
  const r = processItems(items, { now: new Date("2026-11-08T07:00:00Z") });
  const c = r.inserts.find((x) => /reisagente/i.test(x.title));
  assert.ok(c, "dossier aangemaakt");
  assert.equal(c.court, "Te controleren", "locatie staat niet in de titel → niet gokken");
  assert.equal(c.author, null, "auteur onbekend via Google News");
  assert.equal(c.needs_review, true);
  // Het latere artikel "Truiense reisagente veroordeeld..." wordt gekoppeld als mogelijke uitspraak, niet als nieuw dossier
  assert.equal(r.inserts.filter((x) => /reisagente/i.test(x.title)).length, 1);
});

const base = (over = {}) => ({
  id: "c1", title: "Truiense reisagente verkocht 64 spookreizen", defendant: "E.S. (37)", court: "Hasselt",
  verdict_date: "2026-11-09", date_certainty: "afgeleid", status: "aangekondigd", article_id: "111111111",
  article_url: "https://www.hbvl.be/regio/x/111111111.html", created_at: "2026-11-08T06:00:00Z", extra_links: [], ...over,
});
const item = (over = {}) => ({ source: "hbvl", id: "222222222", url: "https://www.hbvl.be/regio/x/222222222.html", title: "", lead: "", author: "Geert Houben", publishedAt: "2026-11-09T15:00:00Z", updatedAt: "2026-11-09T15:00:00Z", ...over });

test("vervolgartikel met uitspraak: geen dubbel dossier en NIET automatisch bevestigd", () => {
  const r = processItems([item({ title: "Truiense reisagente veroordeeld tot werkstraf", lead: "E.S. (37) werd veroordeeld tot een werkstraf van 200 uur." })], { cases: [base()] });
  assert.equal(r.inserts.length, 0);
  assert.equal(r.updates.length, 1);
  assert.notEqual(r.updates[0].patch.status, "bevestigd");
  assert.equal(r.updates[0].patch.needs_review, true);
  assert.equal(r.events[0].kind, "mogelijke_uitspraak");
});

test("uitstel in een nieuw artikel past het bestaande dossier aan", () => {
  const r = processItems([item({ title: "Uitspraak over Truiense reisagente uitgesteld", lead: "Het vonnis tegen E.S. (37) werd uitgesteld naar 7 december." })], { cases: [base()] });
  assert.equal(r.inserts.length, 0);
  assert.equal(r.updates[0].patch.status, "uitgesteld");
  assert.equal(r.updates[0].patch.verdict_date, "2026-12-07");
});

test("aangepast artikel met nieuwe datum werkt hetzelfde dossier bij", () => {
  const r = processItems([item({ id: "111111111", url: base().article_url, title: base().title, lead: "E.S. (37) kent op 16 november haar straf.", updatedAt: "2026-11-08T12:00:00Z" })],
    { cases: [base()], knownArticles: { "111111111": { updated_at_src: "2026-11-08T06:00:00Z" } } });
  assert.equal(r.inserts.length, 0);
  assert.equal(r.updates[0].patch.verdict_date, "2026-11-16");
  assert.equal(r.events[0].kind, "datum_gewijzigd");
});

test("ongewijzigd artikel wordt niet opnieuw verwerkt", () => {
  const r = processItems([item({ id: "111111111", updatedAt: "2026-11-08T06:00:00Z", title: "x", lead: "Het vonnis volgt maandag." })],
    { cases: [base()], knownArticles: { "111111111": { updated_at_src: "2026-11-08T06:00:00Z" } } });
  assert.equal(r.articles.length + r.updates.length + r.inserts.length, 0);
});

test("nieuw aankondigingsartikel van Geert → dossier met alle velden", () => {
  const r = processItems([item({ title: "Genkenaar riskeert drie jaar voor drugshandel", lead: "Kevin V. (34) stond gisteren terecht voor de Tongerse rechtbank. Het vonnis volgt op 2 december." })], { now: new Date("2026-11-09T16:00:00Z") });
  const c = r.inserts[0];
  assert.equal(c.court, "Tongeren");
  assert.equal(c.defendant, "Kevin V. (34)");
  assert.equal(c.verdict_date, "2026-12-02");
  assert.equal(c.author_is_geert, true);
  assert.equal(c.hearing_date, "2026-11-08");
  assert.equal(c.status, "aangekondigd");
});

test("dagelijkse statusovergangen en ochtendmail", () => {
  const cases = [
    base({ id: "a", verdict_date: "2026-11-11", status: "morgen" }),
    base({ id: "b", title: "Zaak B", defendant: null, verdict_date: "2026-11-12", status: "aangekondigd" }),
    base({ id: "c", title: "Zaak C", defendant: null, verdict_date: "2026-11-09", status: "vandaag" }),
  ];
  const { updates } = statusUpdates(cases, "2026-11-11");
  const m = Object.fromEntries(updates.map((u) => [u.id, u.patch.status]));
  assert.deepEqual(m, { a: "vandaag", b: "morgen", c: "check" });
  const after = cases.map((c) => ({ ...c, ...(updates.find((u) => u.id === c.id)?.patch || {}) }));
  const d = buildDigest({ cases: after, today: "2026-11-11", since: "2026-11-10T06:00:00Z", appUrl: "https://vonnisalert-limburg.vercel.app" });
  assert.equal(d.sections.vandaag.length, 1);
  assert.equal(d.sections.morgen.length, 1);
  assert.equal(d.sections.onbevestigd.length, 1);
  assert.match(d.subject, /1 vandaag, 1 morgen/);
  assert.match(d.html, /Uitspraken vandaag \(1\)/);
  const rem = buildReminder({ cases: after, today: "2026-11-11" });
  assert.equal(rem.count, 1);
});
