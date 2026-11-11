// Vonnisalert Limburg – artikelhulp
// Bouwt de prompt die Geert in zijn eigen Claude-account plakt, en telt tekens.
// Er gaat hier niets naar een AI-dienst: de tool maakt alleen tekst om te kopiëren.

export const LIMITS = [2100, 3300];

export const KINDS = {
  vonnis: "Vonnisartikel (de uitspraak is gevallen)",
  zitting: "Zittingsverslag (proces gevoerd, vonnis volgt)",
  combi: "Zittingsverslag + vonnis samen in één artikel",
};

// Standaardstijlgids. Beschrijft Geerts stijl in eigen woorden, zonder overgenomen artikeltekst.
// Geert kan dit in de tool zelf aanpassen; zijn versie wordt dan bewaard en gebruikt.
export const DEFAULT_STYLE = `STIJLGIDS – gerechtsartikels Geert Houben (Het Belang van Limburg)

Toon
- Nuchter, zakelijk en menselijk. Geen sensatie, geen eigen oordeel, geen moraliserende slotzin.
- Korte, heldere zinnen. Eén idee per zin. Afwisselen met af en toe een heel korte zin voor ritme.
- Vlaams-Nederlands zoals in de krant, met af en toe een gangbare uitdrukking (bv. "met centen over de brug komen"), nooit plat dialect.
- Concreet: bedragen, aantallen, data en straffen altijd precies vermelden zoals in de bron.

Opbouw
1. Kop: kort en feitelijk, met het belangrijkste nieuws (straf, aantal slachtoffers, bedrag). Mag openen met een sterk kort citaat gevolgd door een dubbelpunt.
2. Plaatsnaam op een aparte regel (de woonplaats of plaats van de feiten, bv. Sint-Truiden).
3. Lead van 2 à 4 zinnen: wie (beroep/afkomst + initialen + leeftijd tussen haakjes), wat er gebeurde, en de straf of wat er op het spel staat. Bij een zittingsverslag: wat het parket vordert en wanneer het vonnis valt.
4. Achtergrond: hoe het zo ver kwam, chronologisch en concreet.
5. Twee tot vier tussentitels van 1 à 4 woorden (bv. "Geen cel", "Rad voor de ogen", "Redelijke termijn"). Een tussentitel is een haakje, geen samenvatting.
6. Afsluiten met een sterk citaat (van beklaagde, slachtoffer of advocaat) of met wat er nu volgt. Geen conclusie van de journalist.

Vaste formuleringen
- Beklaagde aanduiden met afkomst en beroep: "de Truiense reisagente", "de Looise thuisverpleegster", later ook "de dertiger", "de vrouw".
- Rechtbank: "de Hasseltse strafrechter" / "de Tongerse strafrechter" / "de rechtbank".
- Parket: "het parket vorderde", "het openbaar ministerie vroeg".
- Verdediging: "haar advocaat X pleitte", "vroeg de vrijspraak", "vroeg de opschorting".
- Citaten inleiden of afsluiten met: klinkt het, zei ze, erkende hij, stak ze van wal, pleitte hij, aldus het vonnis.
- Vooruitblik bij een zittingsverslag: "Vonnis op <datum>." of "De rechter doet uitspraak op <datum>."

Citaten
- Veel directe citaten, maar kort en krachtig (meestal 1 à 2 zinnen). Liever drie korte dan één lange.
- Citaten uit het vonnis spaarzaam (hoogstens twee) en enkel als de juridische formulering ertoe doet.
- Citaten letterlijk overnemen uit de aangeleverde bronnen. Nooit een citaat verzinnen of "opschonen" tot iets wat niet gezegd is.

Privacy en juistheid (altijd)
- Beklaagden enkel met initialen (bv. E. S.) en leeftijd, ook als de bron de volledige naam geeft.
- Slachtoffers en getuigen alleen bij naam als ze in de aangeleverde tekst al met naam en citaat voorkomen; anders "een slachtoffer", "een gedupeerde".
- Advocaten, magistraten en woordvoerders mogen bij naam.
- Geen gezondheidsgegevens, adressen of details over minderjarigen die niet nodig zijn voor het verhaal.
- Niets toevoegen wat niet in de bronnen staat. Ontbreekt iets (een bedrag, een reactie, wie er aanwezig was), zet dan [CHECK: …] in de tekst in plaats van te gokken.
- Een vonnis nooit als definitief voorstellen als het nog niet uitgesproken is.`;

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

// Haalt het artikel uit de tekst die Claude teruggeeft: alles vóór "---" of "Om na te kijken".
export function splitArticle(raw = "") {
  const lines = String(raw).replace(/\r/g, "").split("\n");
  const cut = lines.findIndex((l) => /^\s*(-{3,}|_{3,}|\*{3,}|#*\s*\**\s*om na te kijken)/i.test(l));
  const body = (cut >= 0 ? lines.slice(0, cut) : lines)
    .map((l) => l.replace(/^\s*#{1,6}\s*/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
  return { title: body[0] || "", rest: body.slice(1), checks: (String(raw).match(/\[CHECK[^\]]*\]/gi) || []).length };
}

// Telt tekens inclusief spaties. Regeleinden tellen niet mee (die kopieer je niet als tekens in het CMS).
export function countChars(raw = "") {
  const { title, rest, checks } = splitArticle(raw);
  const restLen = rest.reduce((n, l) => n + l.length, 0);
  return { withTitle: title.length + restLen, withoutTitle: restLen, title, checks };
}

function caseBlock(c) {
  if (!c) return "";
  const rows = [
    ["Zaak", c.title],
    ["Beklaagde (initialen)", c.defendant],
    ["Rechtbank", c.court && c.court !== "Te controleren" ? `Rechtbank Limburg, afdeling ${c.court}` : null],
    ["Zittingsdatum", c.hearing_date],
    ["Uitspraak (verwacht)", c.verdict_date],
    ["Eerder artikel", c.article_url],
  ].filter(([, v]) => v);
  return rows.length ? `\nGEGEVENS UIT VONNISALERT\n${rows.map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n` : "";
}

export function buildArticlePrompt({ kind = "combi", limit = 3300, titleCounts = true, useProject = false, style = DEFAULT_STYLE, caseRow = null, attachments = [], notes = "", pasted = "" } = {}) {
  const target = Math.round(limit * 0.93);
  const what = {
    vonnis: "een vonnisartikel over de uitspraak",
    zitting: "een zittingsverslag (het vonnis is nog niet gevallen)",
    combi: "één artikel over de uitspraak, waarin je de belangrijkste elementen van de zitting verwerkt",
  }[kind] || "een gerechtsartikel";
  const src = attachments.length ? attachments.map((a) => `- ${a}`).join("\n") : "- (zie de bijgevoegde bestanden en tekst)";
  return `Je bent mijn schrijfhulp. Ik ben Geert Houben, gerechtsjournalist bij Het Belang van Limburg. Schrijf ${what} in mijn stijl.

${useProject ? "Volg de stijlgids uit de projectinstructies." : `Volg deze stijlgids strikt:\n\n<stijlgids>\n${style.trim()}\n</stijlgids>`}

BRONNEN DIE IK MEEGEEF
${src}
${caseBlock(caseRow)}${notes.trim() ? `\nMIJN EIGEN NOTITIES (wat ik zelf zag of hoorde, mag je gebruiken)\n${notes.trim()}\n` : ""}${pasted.trim() ? `\n<bron>\n${pasted.trim()}\n</bron>\n` : ""}
LENGTE
- Maximaal ${fmt(limit)} tekens inclusief spaties${titleCounts ? ", de kop meegerekend" : " (de kop telt niet mee)"}. Mik op ongeveer ${fmt(target)} tekens.
- Tel na het schrijven. Kun je code uitvoeren, tel dan exact. Zit je erboven, kort dan zelf in vóór je antwoordt: schrap eerst herhalingen en lange vonniscitaten, nooit de straf, de vordering of de kernfeiten.

WERKWIJZE
- Gebruik alleen feiten en citaten uit de bronnen en mijn notities. Verzin niets.
- Bij een lang vonnis: de beslissing (straf, vrijspraak, verbeurdverklaring, burgerlijke partijen) staat meestal achteraan. Lees die eerst.
- Twijfel of ontbrekende info: zet [CHECK: …] in de tekst.

ANTWOORD IN DEZE VORM (gewone tekst, geen opmaaktekens zoals # of **)
Regel 1: de kop
Regel 2: de plaatsnaam
Daarna de lead en de rest van het artikel, met tussentitels op een eigen regel.
Dan een regel met ---
Daaronder "Om na te kijken:" met een korte lijst van wat ik moet controleren (cijfers, namen, citaten, wat niet in de bronnen stond) en het aantal tekens dat je telde.`;
}

export function buildProjectInstructions(style = DEFAULT_STYLE) {
  return `Je bent de schrijfhulp van Geert Houben, gerechtsjournalist bij Het Belang van Limburg (Rechtbank Limburg, afdelingen Hasselt en Tongeren). Je schrijft gerechtsartikels in zijn stijl op basis van de bronnen die hij meegeeft (zittingsverslagen, vonnissen, notities). Houd je altijd aan deze stijlgids. De lengte en het soort artikel staan telkens in zijn vraag.

${style.trim()}`;
}

export function buildShortenPrompt({ limit, current, titleCounts = true }) {
  const target = Math.round(limit * 0.93);
  return `Het artikel telt nu ${fmt(current)} tekens inclusief spaties${titleCounts ? " (met kop)" : " (zonder kop)"}. De limiet is ${fmt(limit)}. Kort het in tot ongeveer ${fmt(target)} tekens.
- Behoud mijn stijl, de kop, de lead, de straf of vordering en de kernfeiten.
- Schrap eerst herhalingen, bijzinnen en lange citaten uit het vonnis; houd liever korte citaten van mensen.
- Verander geen cijfers en geen citaten (inkorten mag alleen door een citaat weg te laten).
- Zelfde vorm als daarnet: kop, plaatsnaam, tekst, dan --- en "Om na te kijken:" met het aantal tekens.`;
}

export { fmt };
