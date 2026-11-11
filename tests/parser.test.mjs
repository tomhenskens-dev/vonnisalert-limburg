import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeArticle, parseWhen, detectCourt, detectDefendant, splitSentences, autoStatus,
  brusselsParts, brusselsDate, greetingFor, addDays, articleIdFromUrl, detectAnnouncements,
} from "../supabase/functions/_shared/parser.js";

// Publicatie op woensdag 11 november 2026, 10u Brusselse tijd
const PUB = "2026-11-11T09:00:00Z";
const an = (text, publishedAt = PUB, title = "") => analyzeArticle({ title, text, publishedAt });

test("de zes voorbeeldformuleringen uit de opdracht worden herkend", () => {
  const cases = [
    ["Het vonnis volgt op maandag.", "2026-11-16"],
    ["De uitspraak is gepland op 12 november.", "2026-11-12"],
    ["Op maandag spreekt de rechter zich uit.", "2026-11-16"],
    ["De beklaagde kent maandag zijn straf.", "2026-11-16"],
    ["Maandag kent ze het verdict.", "2026-11-16"],
  ];
  for (const [text, date] of cases) {
    const r = an(text);
    assert.equal(r.hasAnnouncement, true, text);
    assert.equal(r.verdictDate, date, text);
    assert.equal(r.status, "aangekondigd", text);
  }
  const vw = an("De rechtbank doet volgende week uitspraak.");
  assert.equal(vw.hasAnnouncement, true);
  assert.equal(vw.verdictDate, null);
  assert.equal(vw.status, "check", "zonder exacte datum: nog te controleren");
  assert.match(vw.reasons.join(" "), /volgende week/);
});

test("verslagen in de verleden tijd zijn géén aankondiging", () => {
  for (const text of [
    "De rechtbank sprak zich maandag uit.",
    "De rechter deed maandag uitspraak in de zaak.",
    "Maandag kende ze het verdict: drie jaar cel.",
    "Het vonnis viel op 9 november.",
    "De uitspraak volgde vorige week.",
    "De beklaagde werd veroordeeld tot 37 maanden cel met uitstel.",
    "De man kreeg maandag zijn straf: twee jaar.",
  ]) {
    assert.equal(an(text).hasAnnouncement, false, text);
  }
});

test("het verschil uit de opdracht: sprak zich uit vs spreekt zich uit", () => {
  assert.equal(an("De rechtbank sprak zich maandag uit.").hasAnnouncement, false);
  const r = an("De rechtbank spreekt zich volgende maandag uit.");
  assert.equal(r.hasAnnouncement, true);
  assert.equal(r.verdictDate, "2026-11-16");
});

test("toekomstig passief en 'in beraad' worden herkend", () => {
  assert.equal(an("Het vonnis wordt op 3 december uitgesproken.").verdictDate, "2026-12-03");
  assert.equal(an("De rechter nam de zaak in beraad tot 2 december.").verdictDate, "2026-12-02");
  assert.equal(an("De zaak werd in beraad genomen tot 2 december.").verdictDate, "2026-12-02");
  assert.equal(an("Uitspraak op 25 november.").verdictDate, "2026-11-25");
});

test("gemengde zin: verleden deel en aankondiging gescheiden", () => {
  const r = an("Het parket vorderde vier jaar cel; het vonnis volgt op 2 december.");
  assert.equal(r.verdictDate, "2026-12-02");
});

test("voorwaardelijke formulering geeft status nog te controleren", () => {
  const r = an("Als alles goed gaat, zou de rechter zich op 2 december uitspreken.");
  assert.equal(r.status, "check");
});

test("datums: weekdagen, volgende week, jaarwissel, numeriek", () => {
  const pub = "2026-11-11"; // woensdag
  assert.equal(parseWhen("maandag", pub).date, "2026-11-16");
  assert.equal(parseWhen("vrijdag", pub).date, "2026-11-13");
  assert.equal(parseWhen("woensdag", pub).certainty, "onzeker"); // zelfde weekdag
  assert.equal(parseWhen("maandag volgende week", pub).date, "2026-11-16");
  assert.equal(parseWhen("volgende week vrijdag", pub).date, "2026-11-20");
  assert.equal(parseWhen("morgen", pub).date, "2026-11-12");
  assert.equal(parseWhen("overmorgen", pub).date, "2026-11-13");
  assert.equal(parseWhen("maandagnamiddag", pub).date, "2026-11-16");
  assert.equal(parseWhen("op 12/01", pub).date, "2027-01-12");
  assert.equal(parseWhen("op 8 januari", "2026-12-20").date, "2027-01-08");
  assert.equal(parseWhen("12 november 2026", pub).certainty, "exact");
  assert.equal(parseWhen("over twee weken", pub).date, null);
  assert.equal(parseWhen("eind december", pub).certainty, "onzeker");
});

test("prototype-dossier: artikel van zondag 8 november, 'Maandag kent ze het verdict'", () => {
  const text = `Een 37-jarige reisagente uit Sint-Truiden verkocht 64 spookreizen. E.S. (37) stond terecht voor de Hasseltse rechtbank.
Het parket vorderde 37 maanden cel met uitstel. Maandag kent ze het verdict.`;
  const r = analyzeArticle({ title: "Truiense reisagente verkocht 64 spookreizen", text, publishedAt: "2026-11-08T05:00:00Z", author: "Geert Houben" });
  assert.equal(r.verdictDate, "2026-11-09");
  assert.equal(r.court, "Hasselt");
  assert.equal(r.defendant, "E.S. (37)");
  assert.equal(r.authorIsGeert, true);
  assert.equal(r.status, "aangekondigd");
});

test("rechtbanklocatie wordt nooit gegokt", () => {
  assert.equal(detectCourt("Een man uit Hasselt stond terecht voor de rechtbank.").court, "Te controleren");
  assert.equal(detectCourt("De zaak kwam voor de correctionele rechtbank in Tongeren.").court, "Tongeren");
  assert.equal(detectCourt("De Tongerse rechtbank oordeelde hard.").court, "Tongeren");
  assert.equal(detectCourt("Voor de rechtbank van Hasselt verscheen gisteren een man.").court, "Hasselt");
  assert.equal(detectCourt("De Hasseltse rechter verwees de zaak naar de rechtbank in Tongeren.").court, "Te controleren");
  assert.equal(detectCourt("Genk, Hasselt en Tongeren krijgen nieuwe fietspaden.").court, "Te controleren");
});

test("beklaagde: initialen en leeftijd", () => {
  assert.equal(detectDefendant("Kevin V. (34) uit Genk"), "Kevin V. (34)");
  assert.equal(detectDefendant("De 41-jarige M.D. ontkent"), "M.D. (41)");
  assert.equal(detectDefendant("Geen naam vermeld."), null);
});

test("uitstel wordt herkend, met nieuwe datum", () => {
  const r = an("De uitspraak in de zaak werd uitgesteld naar 9 december.");
  assert.equal(r.status, "uitgesteld");
  assert.equal(r.verdictDate, "2026-12-09");
});

test("zinnen worden niet gesplitst na initialen of afkortingen", () => {
  assert.equal(splitSentences("E. S. (37) staat terecht. Het vonnis volgt op 12 nov. in Hasselt.").length, 2);
});

test("automatische statussen; nooit automatisch bevestigd", () => {
  const base = { status: "aangekondigd", verdict_date: "2026-11-12", date_certainty: "afgeleid" };
  assert.equal(autoStatus(base, "2026-11-10"), "aangekondigd");
  assert.equal(autoStatus(base, "2026-11-11"), "morgen");
  assert.equal(autoStatus(base, "2026-11-12"), "vandaag");
  assert.equal(autoStatus(base, "2026-11-13"), "check");
  assert.equal(autoStatus({ ...base, status: "bevestigd" }, "2026-11-13"), "bevestigd");
  assert.equal(autoStatus({ ...base, status: "uitgesteld", status_manual: true }, "2026-11-12"), "uitgesteld");
});

test("Brusselse tijd: zomer- en wintertijd", () => {
  assert.deepEqual(brusselsParts("2026-11-11T06:00:00Z"), { date: "2026-11-11", hour: 7, minute: 0 }); // winter UTC+1
  assert.deepEqual(brusselsParts("2026-07-01T05:00:00Z"), { date: "2026-07-01", hour: 7, minute: 0 }); // zomer UTC+2
  assert.equal(brusselsDate("2026-11-10T23:59:00Z"), "2026-11-11"); // papieren krant 23:59 UTC
});

test("Tom-knipoog: af en toe, nooit twee dagen na elkaar", () => {
  let count = 0, prev = false;
  for (let i = 0; i < 365; i++) {
    const g = greetingFor(addDays("2026-01-01", i));
    const on = g.isTomDay;
    assert.ok(!(on && prev), "twee dagen na elkaar");
    if (on) count++;
    prev = on;
  }
  assert.ok(count > 60 && count < 140, `aantal keer: ${count}`);
});

test("artikel-id uit HBVL-url", () => {
  assert.equal(articleIdFromUrl("https://www.hbvl.be/regio/hasselt/foo/164400339.html"), "164400339");
});

test("citaat in de mond van iemand anders: laag vertrouwen", () => {
  const r = detectAnnouncements("“Het vonnis volgt maandag, maar we gaan in beroep”, zegt de advocaat.", "2026-11-11");
  assert.equal(r[0].confidence, "laag");
});

test("extra formuleringen en valse positieven", () => {
  assert.equal(an("De rechter velt op 9 december zijn vonnis.").verdictDate, "2026-12-09");
  assert.equal(an("Het parket vraagt vijf jaar cel. Uitspraak op 9 december.").verdictDate, "2026-12-09");
  const b = an("Begin december valt het verdict.");
  assert.equal(b.hasAnnouncement, true);
  assert.equal(b.status, "check");
  for (const t of [
    "Volgende maand moet hij voor de rechter verschijnen.",
    "De zaak wordt op 4 december verder behandeld.",
    "Het proces start op 4 december.",
    "De Rode Duivels kennen maandag hun tegenstander.",
  ]) assert.equal(an(t).hasAnnouncement, false, t);
});

test("Geerts vaste formulering: 'Vonnis op …'", () => {
  for (const [t, d] of [
    ["Vonnis op 2 december.", "2026-12-02"],
    ["Het parket vroeg vier jaar cel. Vonnis op 2 december.", "2026-12-02"],
    ["De verdediging vroeg de vrijspraak, vonnis op 2 december.", "2026-12-02"],
    ["Vonnis op maandag.", "2026-11-16"],
    ["Vonnis op 2/12.", "2026-12-02"],
    ["vonnis op 2 december", "2026-12-02"],
    ["Vonnis op dinsdag 2 december.", "2026-12-02"],
    ["Vonnis op 02/12/2026.", "2026-12-02"],
    ["Vonnis op 2-12.", "2026-12-02"],
    ["Vonnis op 2.12.", "2026-12-02"],
    ["Vonnis op 2 dec.", "2026-12-02"],
    ["Vonnis: 2 december.", "2026-12-02"],
    ["Vonnis op 2december", "2026-12-02"],
    ["Vonnis op 2 december om 9 uur in Hasselt.", "2026-12-02"],
  ]) {
    const r = an(t);
    assert.equal(r.verdictDate, d, t);
    assert.equal(r.status, "aangekondigd", t);
  }
  assert.equal(an("Het vonnis op 2 december was streng.").hasAnnouncement, false);
});
