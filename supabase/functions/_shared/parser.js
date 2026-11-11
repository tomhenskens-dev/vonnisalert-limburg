// Vonnisalert Limburg – herkenningsmotor
// Pure JavaScript zonder afhankelijkheden: draait in de browser (artikel plakken),
// in de Supabase Edge Function (Deno) en in Node (tests).
//
// Uitgangspunten:
// - Alleen een aankondiging in de toekomende of tegenwoordige tijd telt
//   ("het vonnis volgt maandag"), niet een verslag achteraf ("sprak zich maandag uit").
// - De rechtbanklocatie wordt nooit gegokt: alleen Hasselt of Tongeren als dat
//   uitdrukkelijk in een gerechtelijke context staat, anders "Te controleren".
// - Bij twijfel: status "check" (Nog te controleren).

export const TZ = "Europe/Brussels";

export const STATUS = {
  aangekondigd: "Aangekondigd",
  morgen: "Uitspraak morgen",
  vandaag: "Uitspraak vandaag",
  bevestigd: "Uitspraak bevestigd",
  uitgesteld: "Uitgesteld",
  check: "Nog te controleren",
};

const WEEKDAYS = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
const MONTHS = {
  januari: 1, jan: 1, februari: 2, feb: 2, maart: 3, mrt: 3, april: 4, apr: 4, mei: 5,
  juni: 6, jun: 6, juli: 7, jul: 7, augustus: 8, aug: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_RE = "(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|jan|feb|mrt|apr|jun|jul|aug|sept|sep|okt|nov|dec)\\.?";
const WD_RE = "(maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)(?:ochtend|morgen|voormiddag|middag|namiddag|avond)?";
const NUM_WORDS = { een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8 };

// ---------- datumhulpjes (alles als 'YYYY-MM-DD' in Brusselse tijd) ----------

export function brusselsDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
}

export function brusselsParts(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
      .formatToParts(new Date(d)).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekday(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function diffDays(a, b) {
  const pa = a.split("-").map(Number), pb = b.split("-").map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

function isoOf(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null; // bv. 31 februari
  return t.toISOString().slice(0, 10);
}

export function formatDateNL(iso, withWeekday = true) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const month = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"][m - 1];
  const wd = withWeekday ? WEEKDAYS[weekday(iso)] + " " : "";
  return `${wd}${d} ${month} ${y}`;
}

// ---------- tekst opdelen ----------

const ABBREV = /\b(bv|bijv|o\.a|nl|ca|dr|mr|mevr|dhr|nr|blz|vs|jan|feb|mrt|apr|jun|jul|aug|sep|sept|okt|nov|dec)\.$/i;

export function splitSentences(text) {
  const clean = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ /g, " ");
  const out = [];
  for (const para of clean.split(/\n+/)) {
    let buf = "";
    const parts = para.split(/(?<=[.!?…])\s+/);
    for (const part of parts) {
      buf = buf ? `${buf} ${part}` : part;
      const trimmed = buf.trim();
      // Niet splitsen na initialen ("E. S.") of afkortingen ("12 nov.")
      if (/(?:^|[\s(.])[A-Z]\.$/.test(trimmed) || ABBREV.test(trimmed)) continue;
      out.push(trimmed);
      buf = "";
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out.filter(Boolean);
}

function clauses(sentence) {
  // Niet splitsen na "Vonnis:" – dat is Geerts korte notatie ("Vonnis: 2 december").
  return sentence.split(/\s*;\s*|(?<!\b(?:vonnis|uitspraak|verdict))\s*:\s*|,\s*(?=maar\b|terwijl\b|nadat\b|want\b)/i).filter(Boolean);
}

// ---------- tijdsuitdrukkingen ----------

/**
 * Zoekt een tijdsaanduiding in een tekstfragment en rekent die om naar een datum,
 * vertrekkend van de publicatiedatum (YYYY-MM-DD, Brusselse tijd).
 * certainty: 'exact' (datum letterlijk vermeld), 'afgeleid' (bv. uit "maandag"),
 * 'onzeker' (bv. "volgende week" of een dubbelzinnige weekdag).
 */
export function parseWhen(text, pubDate) {
  const t = String(text || "").toLowerCase();
  let m;

  // 12 november (2026) / 12 nov.
  m = t.match(new RegExp(`\\b(\\d{1,2})(?:ste|de|e)?\\s*${MONTH_RE}(?:\\s+(\\d{4}))?`));
  if (m) {
    const d = Number(m[1]), mo = MONTHS[m[2]];
    let y = m[3] ? Number(m[3]) : Number(pubDate.slice(0, 4));
    let iso = isoOf(y, mo, d);
    if (iso && !m[3] && diffDays(pubDate, iso) < -60) iso = isoOf(y + 1, mo, d); // jaarwissel
    if (iso) return { date: iso, certainty: "exact", text: m[0].trim() };
  }

  // 12/11 of 12/11/2026
  m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b(?![.,]?\d)(?!\s*(?:jaar|maand|maanden|uur|%|euro|miljoen|procent))/);
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]);
    let y = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : Number(pubDate.slice(0, 4));
    let iso = mo <= 12 ? isoOf(y, mo, d) : null;
    if (iso && !m[3] && diffDays(pubDate, iso) < -60) iso = isoOf(y + 1, mo, d);
    if (iso) return { date: iso, certainty: "exact", text: m[0] };
  }

  if (/\bovermorgen\b/.test(t)) return { date: addDays(pubDate, 2), certainty: "afgeleid", text: "overmorgen" };
  if (/\bmorgen(?:ochtend|voormiddag|namiddag|middag|avond)?\b/.test(t) && !/\b(maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)morgen\b/.test(t)) {
    return { date: addDays(pubDate, 1), certainty: "afgeleid", text: "morgen" };
  }
  if (/\bvandaag\b|\bdeze (?:voormiddag|namiddag|middag|ochtend)\b|\bstraks\b/.test(t)) {
    return { date: pubDate, certainty: "afgeleid", text: "vandaag" };
  }

  // weekdag, eventueel met "volgende week" erbij
  m = t.match(new RegExp(`\\b(volgende|komende|deze)?\\s*${WD_RE}\\b(\\s+(?:volgende|komende) week)?`));
  if (m) {
    const target = WEEKDAYS.indexOf(m[2]);
    const pubWd = weekday(pubDate);
    const nextWeekExplicit = Boolean(m[3]) || new RegExp(`(volgende|komende) week\\s+(op\\s+)?${WD_RE}`).test(t);
    if (nextWeekExplicit) {
      // maandag van volgende week + offset
      const daysToNextMonday = ((8 - pubWd) % 7) || 7;
      const monday = addDays(pubDate, daysToNextMonday);
      const offset = (target + 6) % 7;
      return { date: addDays(monday, offset), certainty: "afgeleid", text: m[0].trim() };
    }
    let delta = (target - pubWd + 7) % 7;
    let certainty = "afgeleid";
    if (delta === 0) { delta = 7; certainty = "onzeker"; } // zelfde weekdag als publicatie: vandaag of over een week?
    if (m[1] === "volgende") certainty = "onzeker"; // "volgende maandag" is in Vlaanderen dubbelzinnig
    return { date: addDays(pubDate, delta), certainty, text: m[0].trim() };
  }

  m = t.match(/\bover\s+(\d+|een|twee|drie|vier|vijf|zes|zeven|acht)\s+(dagen|weken|week)\b/);
  if (m) {
    const n = NUM_WORDS[m[1]] || Number(m[1]);
    const days = m[2].startsWith("dag") ? n : n * 7;
    return { date: null, approx: addDays(pubDate, days), certainty: "onzeker", text: m[0] };
  }
  m = t.match(/\b(volgende|komende) week\b/);
  if (m) {
    const pubWd = weekday(pubDate);
    const monday = addDays(pubDate, ((8 - pubWd) % 7) || 7);
    return { date: null, approx: monday, certainty: "onzeker", text: m[0] };
  }
  m = t.match(new RegExp(`\\b(begin|half|midden|eind|einde|in|na)\\s+${MONTH_RE}`));
  if (m) return { date: null, certainty: "onzeker", text: m[0] };
  m = t.match(/\b(later|op een latere datum|binnen (?:de )?(?:een )?(?:maand|vier weken|termijn van een maand)|na de (?:kerst|paas|zomer|herfst)vakantie|na nieuwjaar)\b/);
  if (m) return { date: null, certainty: "onzeker", text: m[0] };
  return null;
}

// ---------- patronen ----------

const NOUN = "(?:vonnis|vonnissen|uitspraak|verdict|beslissing|eindbeslissing|arrest|strafmaat|oordeel)";
const FUTURE_PATTERNS = [
  // het vonnis volgt / valt / wordt verwacht / is gepland
  { re: new RegExp(`\\b${NOUN}\\b[^.]{0,60}?\\b(volgt|volgen|valt|vallen|komt|wordt (?:verwacht|geveld|uitgesproken|gewezen|bekendgemaakt|meegedeeld)|is (?:gepland|voorzien|verwacht|vastgesteld|vastgelegd|aangekondigd)|staat (?:gepland|op)|zal (?:volgen|vallen|worden)|verwacht(?:en)? we)\\b`, "i"), weight: 3 },
  // het vonnis wordt op 3 december uitgesproken
  { re: new RegExp(`\\b${NOUN}\\b[^.]{0,40}?\\b(?:wordt|worden|zal|zullen)\\b[^.]{0,50}?\\b(?:uitgesproken|geveld|gewezen|bekendgemaakt|meegedeeld)\\b`, "i"), weight: 3 },
  // op maandag volgt het vonnis
  { re: new RegExp(`\\b(volgt|valt|komt)\\b[^.]{0,40}?\\b(?:het|de)\\s+${NOUN}\\b`, "i"), weight: 3 },
  // de rechter spreekt zich maandag uit / zal zich uitspreken
  { re: /\b(spreekt|spreken)\b[^.]{0,80}?\bzich\b[^.]{0,60}?\buit\b/i, weight: 3 },
  { re: /\b(zal|zullen)\b[^.]{0,80}?\bzich\b[^.]{0,60}?\buitspreken\b/i, weight: 3 },
  // de rechtbank doet volgende week uitspraak / zal uitspraak doen
  { re: /\b(doet|doen)\b[^.]{0,60}?\buitspraak\b/i, weight: 3 },
  { re: /\b(zal|zullen)\b[^.]{0,60}?\buitspraak doen\b/i, weight: 3 },
  // de beklaagde kent maandag zijn straf / maandag kent ze het verdict
  { re: /\b(kent|kennen|krijgt|krijgen|hoort|horen|verneemt|vernemen)\b[^.]{0,60}?\b(?:zijn|haar|hun|het|de)\s+(?:straf|strafmaat|vonnis|verdict|lot|uitspraak|vonnissen)\b/i, weight: 3 },
  { re: /\b(velt|vellen)\b[^.]{0,40}?\b(?:zijn|haar|hun|het|een)\s+(?:vonnis|oordeel|eindoordeel|uitspraak)\b/i, weight: 3 },
  // Geerts vaste formulering: "Vonnis op 2 december." / "Vonnis op maandag."
  { re: /\b(?:vonnis|uitspraak|verdict)(?:\s+(?:volgt\s+|valt\s+)?op|\s*:)\s*(?:\d{1,2}(?:[\/.\-\s]|[a-z])|(?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|morgen|overmorgen)\b)/i, weight: 3 },
  // in beraad tot ... / uitspraak op 12 november
  { re: /\bin beraad\b[^.]{0,40}?\b(tot|op|genomen tot)\b/i, weight: 3 },
  { re: new RegExp(`^\\s*(?:het\\s+|de\\s+)?${NOUN}\\s+(?:op|is op|volgt op|valt op)\\b`, "i"), weight: 2 },
  // de rechter beslist maandag / oordeelt op 3 december
  { re: /\b(?:rechter|rechtbank|raadkamer|jury|hof)\b[^.]{0,30}?\b(beslist|oordeelt|velt)\b/i, weight: 2 },
  { re: /\b(beslist|oordeelt|velt)\b[^.]{0,30}?\b(?:de rechter|de rechtbank|de raadkamer|het hof)\b/i, weight: 2 },
];

const PAST_RE = /\b(sprak|spraken|deed|deden|kende|kenden|viel|vielen|volgde|volgden|kreeg|kregen|hoorde|hoorden|besliste|beslisten|oordeelde|oordeelden|velde|veroordeelde|veroordeelden|uitgesproken|veroordeeld|vrijgesproken|geveld|gedaan|gewezen|bevestigde|legde|legden|opgelegd|werd|werden|was|waren)\b/i;
const CONDITIONAL_RE = /\b(zou|zouden|indien|mocht|als de rechter|tenzij)\b/i;
const POSTPONE_RE = /\b(uitgesteld|verdaagd|verschoven|uitstel|opgeschoven|naar een latere datum|later dan gepland|heropening van de debatten|heropend)\b/i;
const VERDICT_WORD_RE = /\b(vonnis|uitspraak|verdict|beslissing|arrest|strafmaat)\b/i;
const OUTCOME_RE = /\b(veroordeeld tot|veroordeelt|vrijgesproken|vrijspraak|krijgt|kreeg|legde .{0,30}op|celstraf van|gevangenisstraf van|werkstraf van|opschorting|probatie|cel met uitstel|jaar cel|maanden cel|jaar effectief|boete van)\b/i;

export const COURT_RE = /\b(rechtbank|rechter|rechters|vonnis|parket|beklaagde|beklaagden|proces|correctionele|assisen|strafzaak|celstraf|gevangenisstraf|werkstraf|vrijgesproken|veroordeeld|veroordeling|openbaar ministerie|raadkamer|vordert|vorderde|eiste|eist|strafpleiter|aanklager|procureur|politierechter|politierechtbank|terechtstaan|terecht|zitting|uitspraak|verdict|advocaat|meester)\b/gi;

// ---------- detectie ----------

function isInlineQuote(s) { return /^[«"“„'‘]/.test(s.trim()); }

export function detectAnnouncements(text, pubDate) {
  const sentences = splitSentences(text);
  const found = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    for (const c of clauses(s)) {
      if (!VERDICT_WORD_RE.test(c) && !/\bzich\b.*\buit(spreken)?\b|\bstraf\b|\blot\b|\bbeslist\b|\boordeelt\b|\bin beraad\b/i.test(c)) continue;
      const hit = FUTURE_PATTERNS.find((p) => p.re.test(c));
      if (!hit) continue;
      // De verleden tijd in dezelfde zinsdeel wijst op een verslag achteraf.
      // Toekomstig passief ("wordt op 12 november uitgesproken") is geen verleden tijd.
      const cForPast = c.replace(/\b(wordt|worden|zal|zullen)\b([^.]{0,60}?)\b(uitgesproken|geveld|gewezen|gedaan|meegedeeld|bekendgemaakt|genomen)\b/gi, "$1$2");
      const inBeraad = /\bin beraad\b/i.test(c) && parseWhen(c, pubDate);
      const pastMatch = cForPast.match(PAST_RE);
      if (pastMatch && !inBeraad && !POSTPONE_RE.test(c)) {
        // "werd uitgesteld" wordt apart behandeld; andere verleden tijd = geen aankondiging
        continue;
      }
      const when = parseWhen(c, pubDate) || parseWhen(sentences[i + 1] && /^(dat|die|dan|het|op|tegen)\b/i.test(sentences[i + 1]) ? sentences[i + 1] : "", pubDate);
      let confidence = hit.weight >= 3 ? "hoog" : "laag";
      if (CONDITIONAL_RE.test(c)) confidence = "laag";
      if (isInlineQuote(c)) confidence = "laag";
      found.push({ sentence: s, clause: c, when, confidence });
      break;
    }
  }
  return found;
}

export function detectPostponement(text, pubDate) {
  const hits = [];
  for (const s of splitSentences(text)) {
    if (POSTPONE_RE.test(s) && (VERDICT_WORD_RE.test(s) || /\bzaak\b|\bproces\b|\bbehandeling\b/i.test(s))) {
      hits.push({ sentence: s, when: parseWhen(s, pubDate), aboutVerdict: VERDICT_WORD_RE.test(s) });
    }
  }
  if (!hits.length) return null;
  const best = hits.find((h) => h.when?.date) || hits[0];
  if (hits.some((h) => h.aboutVerdict)) best.aboutVerdict = true;
  return best;
}

export function detectOutcome(text) {
  for (const s of splitSentences(text)) {
    if (OUTCOME_RE.test(s) && PAST_RE.test(s) && !FUTURE_PATTERNS.some((p) => p.re.test(s))) return { sentence: s };
    if (/\b(veroordeelt|spreekt .{0,40}vrij|legt .{0,40} op)\b/i.test(s) && /\b(rechter|rechtbank)\b/i.test(s)) return { sentence: s };
  }
  return null;
}

const COURT_CTX = "(?:rechtbank|rechter|rechters|strafrechter|politierechtbank|politierechter|correctionele|raadkamer|kamer van inbeschuldigingstelling|rechtszaal|gerechtsgebouw|justitiepaleis|assisen|assisenhof|hof van assisen|zitting|proces|vrederechter|arbeidsrechtbank|ondernemingsrechtbank)";

export function detectCourt(text) {
  const hits = new Set();
  const evidence = [];
  for (const s of splitSentences(text)) {
    const reA = new RegExp(`\\b(Hasseltse|Tongerse)\\s+${COURT_CTX}`, "gi");
    const reB = new RegExp(`\\b${COURT_CTX}\\b[^.]{0,25}?\\b(?:van|in|te)\\s+(Hasselt|Tongeren)\\b`, "gi");
    const reC = new RegExp(`\\b(?:in|te)\\s+(Hasselt|Tongeren)\\b[^.]{0,30}?\\b(?:voor de|bij de)\\s+${COURT_CTX}`, "gi");
    for (const re of [reA, reB, reC]) {
      let m;
      while ((m = re.exec(s))) {
        const town = /^hasselt/i.test(m[1]) ? "Hasselt" : "Tongeren";
        hits.add(town);
        evidence.push(s);
      }
    }
  }
  if (hits.size === 1) return { court: [...hits][0], evidence: evidence[0] };
  if (hits.size > 1) return { court: "Te controleren", evidence: "Zowel Hasselt als Tongeren vermeld." };
  return { court: "Te controleren", evidence: null };
}

export function detectDefendant(text) {
  const t = String(text || "");
  const patterns = [
    // "E.S. (37)", "Kevin V. (34)", "E. S. (37)"
    /\b((?:[A-Z][a-zà-ÿ]+\s)?(?:[A-Z]\.\s?){1,3})\s*\((\d{1,2})\)/,
    // "de 37-jarige E.S." / "de 41-jarige Kevin V."
    /\b(\d{1,2})-jarige\s+((?:[A-Z][a-zà-ÿ]+\s)?(?:[A-Z]\.\s?){1,3})/,
    // volledige naam met leeftijd: "Eddy Snelders (67)"
    /\b([A-Z][a-zà-ÿ]+(?:\s(?:van|de|der|den|Van|De|Vanden|Vander|Van den|Van der))?\s[A-Z][a-zà-ÿ'-]+)\s\((\d{1,2})\)/,
  ];
  let m = t.match(patterns[0]);
  if (m) return `${m[1].trim()} (${m[2]})`;
  m = t.match(patterns[1]);
  if (m) return `${m[2].trim()} (${m[1]})`;
  m = t.match(patterns[2]);
  if (m) return `${m[1].trim()} (${m[2]})`;
  return null;
}

export function detectHearingDate(text, pubDate) {
  for (const s of splitSentences(text)) {
    const m = s.match(/\b(?:zitting|terechtzitting|proces|pleidooien)\s+(?:van|op)\s+([^,.;]{3,40})/i);
    if (m) {
      const w = parseWhen(m[1], pubDate);
      if (w && w.certainty === "exact") return w.date;
    }
    if (/\b(stond|stonden)\b[^.]{0,40}\bterecht\b/i.test(s) || /\bterecht\s+(?:in|voor)\b/i.test(s)) {
      if (/\bgisteren\b/i.test(s)) return addDays(pubDate, -1);
      const m2 = s.match(new RegExp(`\\b(\\d{1,2})(?:ste|de|e)?\\s+${MONTH_RE}(?:\\s+(\\d{4}))?`, "i"));
      if (m2) { const w = parseWhen(m2[0], pubDate); if (w) return w.date; }
    }
  }
  return null;
}

export function courtScore(text) {
  const m = String(text || "").match(COURT_RE);
  return m ? m.length : 0;
}

export function isGeertHouben(author) {
  return /\bgeert\s+houben\b/i.test(String(author || ""));
}

/**
 * Volledige analyse van een artikel.
 * @param {{title?:string, text:string, publishedAt?:string|Date, author?:string, url?:string}} a
 */
export function analyzeArticle(a) {
  const pubDate = a.publishedAt ? brusselsDate(a.publishedAt) : brusselsDate(new Date());
  const full = [a.title || "", a.text || ""].join("\n");
  const announcements = detectAnnouncements(full, pubDate);
  const postponement = detectPostponement(full, pubDate);
  const outcome = announcements.length ? null : detectOutcome(full);
  const court = detectCourt(full);
  const defendant = detectDefendant(full);
  const hearingDate = detectHearingDate(full, pubDate);
  const score = courtScore(full);

  // Beste aankondiging: hoog vertrouwen en met datum eerst
  const rank = (x) => (x.confidence === "hoog" ? 4 : 0) + (x.when?.date ? 2 : 0) + (x.when?.certainty === "exact" ? 1 : 0);
  const best = announcements.slice().sort((p, q) => rank(q) - rank(p))[0] || null;

  let verdictDate = best?.when?.date || null;
  let dateCertainty = best?.when?.certainty || (best ? "onzeker" : null);
  let dateText = best?.when?.text || null;

  // Uitstel met nieuwe datum overschrijft
  let postponed = false;
  if (postponement && postponement.aboutVerdict) {
    postponed = true;
    if (postponement.when?.date) {
      verdictDate = postponement.when.date;
      dateCertainty = postponement.when.certainty;
      dateText = postponement.when.text;
    }
  }

  const reasons = [];
  let status = "check";
  if (best) {
    if (best.confidence === "hoog" && verdictDate && (dateCertainty === "exact" || dateCertainty === "afgeleid")) status = "aangekondigd";
    if (best.confidence !== "hoog") reasons.push("Formulering niet eenduidig (voorwaardelijk, citaat of zwak patroon).");
    if (!verdictDate) reasons.push(dateText ? `Geen exacte datum: “${dateText}”.` : "Geen uitspraakdatum gevonden.");
    if (dateCertainty === "afgeleid") reasons.push(`Datum afgeleid uit “${dateText}” en de publicatiedatum.`);
    if (dateCertainty === "onzeker" && verdictDate) reasons.push(`Datum onzeker: “${dateText}”.`);
  }
  if (postponed) { status = "uitgesteld"; reasons.push("Artikel vermeldt uitstel."); }
  if (court.court === "Te controleren") reasons.push("Rechtbanklocatie niet uitdrukkelijk vermeld.");

  return {
    pubDate,
    // Alleen een titel (bv. Google News): één gerechtelijk woord volstaat
    isCourtRelated: score >= ((a.text || "").length < 40 ? 1 : 2) || announcements.length > 0,
    courtScore: score,
    hasAnnouncement: Boolean(best),
    announcement: best,
    allAnnouncements: announcements,
    postponement,
    outcome,
    verdictDate,
    dateCertainty,
    dateText,
    court: court.court,
    courtEvidence: court.evidence,
    defendant,
    hearingDate,
    authorIsGeert: a.author ? isGeertHouben(a.author) : null,
    status,
    reasons,
  };
}

/**
 * Statusovergang op basis van de datum (alleen voor automatisch beheerde statussen).
 * Een uitspraak wordt nooit automatisch "bevestigd".
 */
export function autoStatus(c, today) {
  if (c.status_manual) return c.status;
  if (["bevestigd"].includes(c.status)) return c.status;
  if (!c.verdict_date) return c.status === "uitgesteld" ? "uitgesteld" : "check";
  const d = diffDays(today, c.verdict_date);
  if (d < 0) return "check"; // verwachte datum verstreken, nog niet bevestigd
  if (c.status === "check" && c.date_certainty === "onzeker") return "check";
  if (c.status === "check" && c.needs_review) return "check";
  if (d === 0) return "vandaag";
  if (d === 1) return "morgen";
  return c.status === "uitgesteld" ? "uitgesteld" : (c.status === "check" ? "check" : "aangekondigd");
}

export function normalizeDefendant(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function articleIdFromUrl(url) {
  const m = String(url || "").match(/\/(\d{6,})\.html/) || String(url || "").match(/\/cnt\/([a-z0-9_]+)/i);
  return m ? m[1] : null;
}

// ---------- begroeting ----------

const MORNING = [
  "Goedemorgen Geert, goed geslapen en lekker gedroomd? Neem alvast een koffie, dan zet ik de samenvatting voor vandaag klaar.",
  "Goedemorgen Geert! Als jij geniet van een lekker ontbijt en een kop koffie, doe ik alvast de eerste taken voor jou.",
  "Goeiemorgen Geert, de koffie staat (hopelijk) al te pruttelen. Ik heb de rechtbankagenda al voor je doorgenomen.",
  "Dag Geert, uitgerust? Schenk jezelf een koffie in, de vonnissen van vandaag staan hieronder netjes op een rij.",
  "Goedemorgen Geert! Eerst een slok koffie, dan het nieuws. Ik heb al uitgezocht welke uitspraken je best opvolgt.",
  "Hallo Geert, een nieuwe dag in Hasselt en Tongeren. Neem rustig je ontbijt, het overzicht staat al klaar.",
  "Goedemorgen Geert, lekker geslapen? Ik heb vannacht de wacht gehouden, zodat jij niets mist.",
  "Goeiemorgen Geert! Koffie in de ene hand, Vonnisalert in de andere: zo begint een goede werkdag.",
  "Dag Geert! Terwijl jij wakker wordt, heb ik de aangekondigde uitspraken al nagekeken.",
  "Goedemorgen Geert, de toga's worden gestreken en de rechters zoeken hun hamer. Hier is wat er vandaag op de rol staat.",
  "Goeiemorgen Geert, ontbijtje gehad? Dan kunnen we eraan beginnen: hier is je overzicht.",
  "Goedemorgen Geert! Geen enkel vonnis ontsnapt vandaag aan ons. Neem gerust eerst een koffie.",
];
const WEEKDAY_EXTRA = {
  1: " Fijne start van de week!",
  5: " Het is vrijdag, het weekend is in zicht!",
  6: " Een rustige zaterdag gewenst.",
  0: " Geniet van je zondag.",
};
const TOM = [
  "Goedemorgen Geert, bedenk vandaag eens dat jouw vriend Tom deze tool heeft gemaakt. Trakteer hem volgende keer maar eens op een frisse Duvel! 🍺",
  "Goeiemorgen Geert! Kleine herinnering: zonder Tom geen Vonnisalert. Een Duvel bij de volgende gelegenheid lijkt me op zijn plaats. 😉",
  "Goedemorgen Geert, goed geslapen? Tom heeft ervoor gezorgd dat jij geen vonnis meer mist. Een frisse Duvel zou hem enorm plezieren. 🍺",
  "Dag Geert! Weet je wie je dit overzicht bezorgt? Juist, je vriend Tom. Vergeet hem niet te bedanken, liefst met een Duvel. 😄",
  "Goedemorgen Geert, terwijl jij je koffie drinkt, denk ik aan Tom: hij maakte deze tool. Hij drinkt zijn Duvel graag fris. 🍺",
  "Goeiemorgen Geert! Vandaag sponsort Tom je ochtendoverzicht. De rekening? Eén frisse Duvel, te betalen bij de volgende ontmoeting. 😉",
];

function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
function tomDay(iso) { return hash(iso + "-tom") % 3 === 0; }

/**
 * Ochtendbegroeting: elke dag een andere zin. Ongeveer om de drie dagen een knipoog
 * naar Tom (de maker), nooit twee dagen na elkaar.
 * Geeft { line, tom } terug; op een Tom-dag is `line` zelf de Tom-begroeting.
 */
export function greetingFor(iso) {
  const showTom = tomDay(iso) && !tomDay(addDays(iso, -1));
  if (showTom) return { line: TOM[hash(iso + "w") % TOM.length], tom: null, isTomDay: true };
  const line = MORNING[hash(iso) % MORNING.length] + (WEEKDAY_EXTRA[weekday(iso)] || "");
  return { line, tom: null, isTomDay: false };
}

// ---------- begroeting volgens het uur (webapp) ----------

const PERIODS = {
  ochtend: {
    kicker: "☀️ GOEDEMORGEN GEERT",
    lines: null, // gebruikt MORNING hierboven
  },
  middag: {
    kicker: "🌤️ GOEIEMIDDAG GEERT",
    lines: [
      "Goeiemiddag Geert! Lekker gegeten? Hier is de stand van zaken voor vandaag.",
      "Dag Geert, halverwege de dag al. Even checken wat er nog op de rol staat?",
      "Goeiemiddag Geert! Tijd voor een koffie na de middag, en een snelle blik op de vonnissen.",
      "Hallo Geert, de rechtbank draait op volle toeren. Ik hou alles voor je in de gaten.",
      "Goeiemiddag Geert! Alles netjes bijgewerkt, je hoeft niets te missen.",
    ],
  },
  avond: {
    kicker: "🌆 GOEIENAVOND GEERT",
    lines: [
      "Goeienavond Geert! Even vooruitkijken: dit staat er morgen op de agenda.",
      "Dag Geert, de werkdag zit erop. Hier nog een laatste blik op wat er komt.",
      "Goeienavond Geert! Zet je voeten maar omhoog, ik waak over de vonnissen.",
      "Hallo Geert, nog even werken? Hier is het overzicht van vandaag en morgen.",
      "Goeienavond Geert! Morgenvroeg staat je samenvatting weer klaar in je mailbox.",
    ],
  },
  nacht: {
    kicker: "🌙 NOG WAKKER, GEERT?",
    lines: [
      "Nog wakker, Geert? De vonnissen lopen niet weg. Morgen om 7 uur krijg je alles in je mailbox.",
      "Dag nachtuil! Ik hou de wacht, ga gerust slapen.",
      "Laat geworden, Geert? Hier is het overzicht, en daarna snel je bed in.",
      "Goeienacht Geert! Terwijl jij slaapt, blijf ik elke 15 minuten opletten.",
    ],
  },
};
const TOM_PERIOD = {
  middag: [
    "Goeiemiddag Geert! Weet je nog wie deze tool maakte? Juist, Tom. Een frisse Duvel bij de volgende gelegenheid? 🍺",
    "Dag Geert, kleine reminder deze middag: zonder je vriend Tom geen Vonnisalert. 😉",
  ],
  avond: [
    "Goeienavond Geert! Perfect moment om je vriend Tom eens te bedanken… met een frisse Duvel. 🍺",
    "Dag Geert, mooie avond voor een Duvel. Tom (de maker van deze tool) zegt alvast santé! 😄",
  ],
  nacht: [
    "Nog wakker, Geert? Tom heeft deze tool gemaakt zodat jij gerust kan slapen. Een Duvel zou hem plezieren. 🍺",
  ],
};

export function periodFor(hour) {
  if (hour >= 5 && hour < 12) return "ochtend";
  if (hour >= 12 && hour < 17) return "middag";
  if (hour >= 17 && hour < 23) return "avond";
  return "nacht";
}

/** Begroeting voor de webapp, afhankelijk van dag en uur. */
export function greetingAt(iso, hour) {
  const period = periodFor(hour);
  const day = greetingFor(iso);
  if (period === "ochtend") return { period, kicker: PERIODS.ochtend.kicker, line: day.line, isTomDay: day.isTomDay };
  if (day.isTomDay) {
    const list = TOM_PERIOD[period];
    return { period, kicker: PERIODS[period].kicker, line: list[hash(iso + period) % list.length], isTomDay: true };
  }
  const list = PERIODS[period].lines;
  return { period, kicker: PERIODS[period].kicker, line: list[hash(iso + period) % list.length], isTomDay: false };
}
