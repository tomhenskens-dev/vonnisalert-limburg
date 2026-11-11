// Vonnisalert Limburg – verwerkingslogica (zonder netwerk of database).
// Wordt gebruikt door de Edge Function en door de tests.

import {
  analyzeArticle, autoStatus, brusselsDate, addDays, diffDays, formatDateNL,
  normalizeDefendant, articleIdFromUrl, greetingFor, STATUS, followedAuthor,
} from "./parser.js";

export const HBVL_RSS = "https://www.hbvl.be/rss";
export const HLN_RSS = "https://www.hln.be/hasselt/rss.xml";
export const GOOGLE_NEWS_RSS =
  "https://news.google.com/rss/search?q=site:hbvl.be+(vonnis+OR+uitspraak+OR+verdict+OR+rechtbank+OR+rechter)+when:7d&hl=nl&gl=BE&ceid=BE:nl";

// ---------- RSS ----------

function decode(s) {
  return String(s || "")
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")) : "";
}

/** @param {string} xml @param {string} [source] */
export function parseRss(xml, source = "hbvl") {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    let title = tag(b, "title");
    let url = tag(b, "link");
    const author = tag(b, "dc:creator") || tag(b, "author") || null;
    const published = tag(b, "pubDate");
    const updated = tag(b, "atom:updated") || published;
    let lead = tag(b, "description");
    let id = articleIdFromUrl(url);
    if (source === "google") {
      title = title.replace(/\s+-\s+HBVL\s*$/i, "");
      lead = ""; // Google News levert alleen titels; de beschrijving herhaalt de titel
      id = null;
    }
    if (!url || url.replace(/\/$/, "").match(/^https?:\/\/[^/]+$/)) url = tag(b, "guid") || url;
    if (!title || !url) continue;
    items.push({
      source,
      id: id || `${source}:${normTitle(title).slice(0, 80)}`,
      url,
      title,
      lead,
      author: author && author.toLowerCase() !== "redactie" ? author : author,
      category: tag(b, "category") || null,
      publishedAt: published ? new Date(published).toISOString() : null,
      updatedAt: updated ? new Date(updated).toISOString() : null,
      premium: /<premium>true<\/premium>/.test(b) || /paid[^>]*>\s*true/i.test(b),
    });
  }
  return items;
}

export function normTitle(t) {
  return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

const STOP = new Set(("rechtbank rechter vonnis uitspraak verdict maandag dinsdag woensdag donderdag vrijdag zaterdag zondag " +
  "hasselt tongeren hasseltse tongerse limburg limburgse straf celstraf jaar maanden euro parket beklaagde advocaat " +
  "veroordeeld vrijgesproken werkstraf proces assisen tegen omdat nadat zijn haar kent krijgt volgende staat terecht " +
  "vrouw man jongen meisje vader moeder").split(" "));

function distinctiveWords(t) {
  return new Set(normTitle(t).split(" ").filter((w) => w.length >= 5 && !STOP.has(w) && !/^\d+$/.test(w)));
}

/** Zoekt een bestaand dossier waar dit artikel bij hoort (zelfde artikel, beklaagde of duidelijk dezelfde zaak). */
export function findMatchingCase(item, analysis, cases) {
  const byArticle = cases.find((c) => c.article_id && c.article_id === item.id);
  if (byArticle) return { case: byArticle, how: "artikel" };
  const byUrl = cases.find((c) => c.article_url && c.article_url === item.url);
  if (byUrl) return { case: byUrl, how: "artikel" };
  const recent = cases.filter((c) => !c.archived && (!c.created_at || diffDays(brusselsDate(c.created_at), brusselsDate(item.publishedAt || new Date())) <= 120));
  const nd = normalizeDefendant(analysis.defendant);
  if (nd && nd.length >= 3) {
    const m = recent.find((c) => normalizeDefendant(c.defendant) === nd);
    if (m) return { case: m, how: "beklaagde" };
  }
  const words = distinctiveWords(item.title);
  if (words.size >= 2) {
    for (const c of recent) {
      const cw = distinctiveWords(c.title);
      const shared = [...words].filter((w) => cw.has(w));
      if (shared.length >= 2) return { case: c, how: `titel (${shared.join(", ")})` };
    }
  }
  return null;
}

/**
 * Verwerkt nieuwe of gewijzigde feed-items.
 * @param {any[]} items
 * @param {{cases?: any[], knownArticles?: Record<string, any>, now?: Date, authors?: any[]}} [opts]
 * @returns {{articles:any[], inserts:any[], updates:any[], events:any[]}}
 */
export function processItems(items, { cases = [], knownArticles = {}, now = new Date(), authors } = {}) {
  const out = { articles: [], inserts: [], updates: [], events: [] };
  const workingCases = cases.map((c) => ({ ...c }));
  const seen = new Set();

  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    // Hetzelfde artikel via Google News én via de HBVL-feed: één keer verwerken
    const dupTitle = items.find((o) => o !== item && o.source === "hbvl" && item.source === "google" && normTitle(o.title) === normTitle(item.title));
    if (dupTitle) continue;

    const known = knownArticles[item.id];
    if (known && known.updated_at_src === item.updatedAt && !known.reprocess) continue; // niets veranderd

    const analysis = analyzeArticle({ title: item.title, text: item.lead, publishedAt: item.publishedAt, author: item.author });
    if (!analysis.isCourtRelated && !analysis.hasAnnouncement) continue;

    const article = {
      article_id: item.id, source: item.source, url: item.url, title: item.title, lead: item.lead || null,
      author: item.author, category: item.category, published_at: item.publishedAt, updated_at_src: item.updatedAt,
      premium: item.premium, court_related: analysis.isCourtRelated, announcement: analysis.hasAnnouncement,
      analysis: compactAnalysis(analysis), last_seen: now.toISOString(),
    };

    const match = findMatchingCase(item, analysis, workingCases);
    if (match) {
      const c = match.case;
      article.case_id = c.id;
      const patch = {};
      const ev = [];
      const fromSameArticle = match.how === "artikel";
      if (analysis.postponement?.aboutVerdict) {
        if (c.status !== "uitgesteld") { patch.status = "uitgesteld"; patch.status_manual = false; }
        if (analysis.verdictDate && analysis.verdictDate !== c.verdict_date) {
          patch.verdict_date = analysis.verdictDate; patch.date_certainty = analysis.dateCertainty; patch.verdict_date_text = analysis.dateText;
        }
        ev.push({ kind: "uitgesteld", message: `Uitstel gemeld${analysis.verdictDate ? ` – nieuwe datum ${formatDateNL(analysis.verdictDate)}` : ""}: “${item.title}”` });
      } else if (analysis.hasAnnouncement && analysis.verdictDate && analysis.verdictDate !== c.verdict_date && !c.status_manual) {
        patch.verdict_date = analysis.verdictDate; patch.date_certainty = analysis.dateCertainty; patch.verdict_date_text = analysis.dateText;
        patch.needs_review = true;
        ev.push({ kind: "datum_gewijzigd", message: `Uitspraakdatum gewijzigd van ${c.verdict_date ? formatDateNL(c.verdict_date) : "onbekend"} naar ${formatDateNL(analysis.verdictDate)} (${fromSameArticle ? "artikel aangepast" : "nieuw artikel"}).` });
      } else if (analysis.outcome && !fromSameArticle) {
        // Mogelijk de uitspraak zelf – nooit automatisch bevestigen
        patch.needs_review = true;
        ev.push({ kind: "mogelijke_uitspraak", message: `Mogelijk verslag van de uitspraak: “${item.title}”. Controleer en bevestig handmatig.` });
      } else if (fromSameArticle) {
        ev.push({ kind: "artikel_bijgewerkt", message: "Het oorspronkelijke artikel werd aangepast; geen wijziging in datum of status." });
      }
      if (!fromSameArticle) {
        const links = Array.isArray(c.extra_links) ? c.extra_links.slice() : [];
        if (!links.some((l) => l.url === item.url) && c.article_url !== item.url) {
          links.push({ url: item.url, title: item.title, published_at: item.publishedAt });
          patch.extra_links = links;
        }
      }
      if (c.court === "Te controleren" && analysis.court !== "Te controleren") patch.court = analysis.court;
      if (!c.defendant && analysis.defendant) patch.defendant = analysis.defendant;
      if (Object.keys(patch).length || ev.length) {
        Object.assign(c, patch);
        out.updates.push({ id: c.id, patch });
        for (const e of ev) out.events.push({ case_id: c.id, ...e });
      }
    } else if (analysis.hasAnnouncement) {
      const id = cryptoId();
      const notes = [];
      if (analysis.announcement?.sentence) notes.push(`Aankondiging in artikel: “${analysis.announcement.sentence}”`);
      if (item.premium) notes.push("Plus-artikel: volledige tekst alleen voor abonnees.");
      if (item.source === "google") notes.push("Gevonden via Google News (alleen titel).");
      const c = {
        id,
        title: item.title,
        defendant: analysis.defendant,
        author: item.author || null,
        author_is_geert: item.author ? Boolean(followedAuthor(item.author, authors)) : null,
        article_url: item.url,
        article_id: item.id,
        published_at: item.publishedAt,
        hearing_date: analysis.hearingDate,
        verdict_date: analysis.verdictDate,
        verdict_date_text: analysis.dateText,
        date_certainty: analysis.dateCertainty,
        court: analysis.court,
        status: analysis.status,
        status_manual: false,
        needs_review: analysis.status !== "aangekondigd" || analysis.court === "Te controleren" || !item.author,
        notes: notes.join("\n"),
        review_reasons: analysis.reasons,
        source: item.source === "google" ? "google" : item.source === "hln" ? "hln" : "rss",
        extra_links: [],
        created_at: now.toISOString(),
      };
      c.status = autoStatus(c, brusselsDate(now));
      article.case_id = id;
      workingCases.push(c);
      out.inserts.push(c);
      out.events.push({ case_id: id, kind: "aangemaakt", message: `Automatisch aangemaakt uit ${item.source === "google" ? "Google News" : item.source === "hln" ? "de HLN-feed" : "de HBVL-feed"}: “${item.title}”` });
    }
    out.articles.push(article);
  }
  return out;
}

function compactAnalysis(a) {
  return {
    hasAnnouncement: a.hasAnnouncement, sentence: a.announcement?.sentence || null, verdictDate: a.verdictDate,
    dateCertainty: a.dateCertainty, dateText: a.dateText, court: a.court, defendant: a.defendant,
    outcome: a.outcome?.sentence || null, postponement: a.postponement?.sentence || null, reasons: a.reasons,
  };
}

function cryptoId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0; return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Dagelijkse statusupdate. Geeft enkel echte wijzigingen terug. */
/** @param {any[]} cases @param {string} today */
export function statusUpdates(cases, today) {
  const updates = [], events = [];
  for (const c of cases) {
    if (c.archived) continue;
    const next = autoStatus(c, today);
    if (next !== c.status) {
      const patch = { status: next };
      let msg = `Status automatisch: ${STATUS[c.status] || c.status} → ${STATUS[next]}.`;
      if (next === "check" && c.verdict_date && diffDays(today, c.verdict_date) < 0) {
        patch.needs_review = true;
        msg = `Verwachte uitspraakdatum (${formatDateNL(c.verdict_date)}) is verstreken; uitspraak nog niet bevestigd.`;
      }
      updates.push({ id: c.id, patch });
      events.push({ case_id: c.id, kind: "status", message: msg });
    }
  }
  return { updates, events };
}

// ---------- overzichtsmail ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** @param {any[]} cases @param {any[]} events @param {string} today @param {string} [since] */
export function digestSections(cases, events, today, since) {
  const open = cases.filter((c) => !c.archived && c.status !== "bevestigd");
  const tomorrow = addDays(today, 1);
  const sinceTs = since ? new Date(since).getTime() : Date.now() - 86400000;
  const changedIds = new Set(events.filter((e) => ["uitgesteld", "datum_gewijzigd"].includes(e.kind) && new Date(e.at || Date.now()).getTime() > sinceTs).map((e) => e.case_id));
  const byDate = (a, b) => String(a.verdict_date || "9999").localeCompare(String(b.verdict_date || "9999"));
  return {
    nieuw: cases.filter((c) => c.created_at && new Date(c.created_at).getTime() > sinceTs).sort(byDate),
    vandaag: open.filter((c) => c.verdict_date === today && c.status !== "uitgesteld"),
    morgen: open.filter((c) => c.verdict_date === tomorrow && c.status !== "uitgesteld"),
    onbevestigd: open.filter((c) => c.verdict_date && c.verdict_date < today && c.status !== "uitgesteld").sort(byDate),
    gewijzigd: cases.filter((c) => changedIds.has(c.id) || (c.status === "uitgesteld" && c.updated_at && new Date(c.updated_at).getTime() > sinceTs)),
  };
}

function caseRowHtml(c, appUrl) {
  const date = c.verdict_date ? formatDateNL(c.verdict_date) : (c.verdict_date_text ? `“${esc(c.verdict_date_text)}”` : "datum onbekend");
  const parts = [
    `<strong>${esc(c.title)}</strong>`,
    `<span style="color:#55657a">${esc(c.defendant || "beklaagde niet vermeld")} · ${esc(c.court)} · ${date}${c.date_certainty === "afgeleid" ? " (afgeleid)" : c.date_certainty === "onzeker" ? " (onzeker)" : ""}</span>`,
    `<span style="color:#55657a">${esc(STATUS[c.status] || c.status)} · auteur: ${esc(c.author || "onbekend")}</span>`,
  ];
  const links = [];
  if (c.article_url) links.push(`<a href="${esc(c.article_url)}">artikel</a>`);
  if (appUrl) links.push(`<a href="${esc(appUrl)}/#dossier/${esc(c.id)}">dossier</a>`);
  return `<li style="margin:0 0 12px">${parts.join("<br>")}${links.length ? `<br>${links.join(" · ")}` : ""}</li>`;
}

const EV_LABEL = { bevestigd: "bevestigd", te_bevestigen: "te bevestigen", voorspelling: "voorspelling", eenmalig: "eenmalig" };

/** @param {{cases:any[], events?:any[], agenda?:any[], today:string, since?:string, appUrl?:string}} p */
export function buildDigest({ cases, events = [], agenda = [], today, since, appUrl = "" }) {
  const s = digestSections(cases, events, today, since);
  const g = greetingFor(today);
  const blocks = [
    ["1. Nieuwe aankondigingen", s.nieuw],
    ["2. Uitspraken vandaag", s.vandaag],
    ["3. Uitspraken morgen", s.morgen],
    ["4. Aangekondigd maar nog niet bevestigd", s.onbevestigd],
    ["5. Uitgesteld of gewijzigd", s.gewijzigd],
  ];
  const week = addDays(today, 7);
  const agendaWeek = agenda.filter((e) => e.start_date && (e.end_date || e.start_date) >= today && e.start_date <= week)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const agendaHtml = agendaWeek.length ? `<h3 style="margin:22px 0 8px;font-size:16px">Agenda komende 7 dagen (${agendaWeek.length})</h3><ul style="padding-left:18px;margin:0">${agendaWeek.map((e) => `<li style="margin:0 0 8px"><strong>${esc(e.title)}</strong><br><span style="color:#55657a">${formatDateNL(e.start_date)}${e.end_date && e.end_date !== e.start_date ? ` – ${formatDateNL(e.end_date)}` : ""}${e.place ? ` · ${esc(e.place)}` : ""} · datum ${EV_LABEL[e.status] || e.status}</span></li>`).join("")}</ul>` : "";
  const total = s.vandaag.length + s.morgen.length;
  const subject = `Vonnisalert ${formatDateNL(today, false)}: ${s.vandaag.length} vandaag, ${s.morgen.length} morgen${s.nieuw.length ? `, ${s.nieuw.length} nieuw` : ""}`;
  const html = `<!doctype html><html><body style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#172536;max-width:640px;margin:auto;padding:16px">
<h2 style="margin:0 0 6px;color:#173f67">Vonnisalert Limburg</h2>
<p style="margin:0 0 4px">${esc(g.line)}</p>${g.tom ? `<p style="color:#55657a;font-size:13px">${esc(g.tom)}</p>` : ""}
${blocks.map(([h, list]) => `<h3 style="margin:22px 0 8px;font-size:16px">${h} (${list.length})</h3>${list.length ? `<ul style="padding-left:18px;margin:0">${list.map((c) => caseRowHtml(c, appUrl)).join("")}</ul>` : `<p style="color:#7a8797;margin:0">Niets te melden.</p>`}`).join("\n")}
${agendaHtml}
${appUrl ? `<p style="margin-top:26px"><a href="${esc(appUrl)}" style="background:#245b8d;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open Vonnisalert</a></p>` : ""}
<p style="color:#8a97a6;font-size:12px;margin-top:20px">Datums met “afgeleid” of “onzeker” zijn berekend uit de tekst en moeten nagekeken worden. Een uitspraak wordt nooit automatisch als bevestigd gemarkeerd.</p>
</body></html>`;
  const text = [g.line, g.tom || "", ...blocks.map(([h, list]) => `\n${h} (${list.length})\n${list.map((c) => `- ${c.title} | ${c.court} | ${c.verdict_date || c.verdict_date_text || "datum onbekend"} | ${STATUS[c.status]}${c.article_url ? ` | ${c.article_url}` : ""}`).join("\n") || "Niets te melden."}`)].join("\n");
  const agendaText = agendaWeek.length ? `\n\nAgenda komende 7 dagen\n${agendaWeek.map((e) => `- ${e.title} | ${e.start_date}${e.end_date ? ` – ${e.end_date}` : ""} | ${EV_LABEL[e.status]}`).join("\n")}` : "";
  return { subject, html, text: text + agendaText, sections: s, total, agendaWeek };
}

/** @param {{cases:any[], today:string, appUrl?:string}} p */
export function buildReminder({ cases, today, appUrl = "" }) {
  const tomorrow = addDays(today, 1);
  const list = cases.filter((c) => !c.archived && c.verdict_date === tomorrow && !["bevestigd", "uitgesteld"].includes(c.status));
  if (!list.length) return null;
  const subject = `Herinnering: morgen ${list.length} uitspra${list.length === 1 ? "ak" : "ken"} (${formatDateNL(tomorrow, false)})`;
  const html = `<!doctype html><html><body style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#172536;max-width:640px;margin:auto;padding:16px">
<h2 style="margin:0 0 10px;color:#173f67">Morgen verwacht</h2><ul style="padding-left:18px">${list.map((c) => caseRowHtml(c, appUrl)).join("")}</ul></body></html>`;
  const text = list.map((c) => `- ${c.title} | ${c.court} | ${c.article_url || ""}`).join("\n");
  return { subject, html, text, count: list.length };
}
