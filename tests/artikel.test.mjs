import test from "node:test";
import assert from "node:assert/strict";
import { countChars, splitArticle, buildArticlePrompt, buildShortenPrompt, buildProjectInstructions, DEFAULT_STYLE } from "../artikel.js";

test("teller: kop, opmaak en controlelijst", () => {
  const r = countChars("**Kop van tien**\n\nHasselt\nEen zin.\n\n---\nOm na te kijken:\n- iets");
  assert.equal(r.title, "Kop van tien");
  assert.equal(r.withoutTitle, "Hasselt".length + "Een zin.".length);
  assert.equal(r.withTitle, r.withoutTitle + 12);
});
test("teller: zonder streep maar met kop 'Om na te kijken'", () => {
  assert.equal(splitArticle("Kop\nTekst\nOm na te kijken: x").rest.length, 1);
});
test("prompt bevat limiet, stijlgids en privacyregels", () => {
  const p = buildArticlePrompt({ limit: 2100, titleCounts: false, caseRow: { title: "Zaak X", defendant: "E. S.", court: "Hasselt", verdict_date: "2026-11-09" }, attachments: ["Het vonnis (PDF, bijgevoegd)"] });
  assert.match(p, /Maximaal 2\.100 tekens inclusief spaties \(de kop telt niet mee\)/);
  assert.match(p, /<stijlgids>/);
  assert.match(p, /enkel met initialen/);
  assert.match(p, /afdeling Hasselt/);
  assert.ok(!/Te controleren/.test(buildArticlePrompt({ caseRow: { title: "Y", court: "Te controleren" } })));
});
test("projectmodus laat de stijlgids weg; projectinstructies bevatten hem", () => {
  assert.ok(!buildArticlePrompt({ useProject: true }).includes("<stijlgids>"));
  assert.ok(buildProjectInstructions().includes(DEFAULT_STYLE.slice(0, 40)));
});
test("inkort-opdracht", () => {
  assert.match(buildShortenPrompt({ limit: 3300, current: 3663 }), /3\.663 tekens.*3\.300/s);
});
