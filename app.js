// Vonnisalert Limburg – webapp
// supabase-js staat lokaal in /vendor (geen afhankelijkheid van een externe CDN)
const { createClient } = window.supabase;
import {
  analyzeArticle, STATUS, brusselsDate, addDays, weekday, formatDateNL, greetingFor, diffDays,
  articleIdFromUrl, isGeertHouben, greetingAt, followedAuthor, DEFAULT_AUTHORS,
} from "/supabase/functions/_shared/parser.js";

const cfg = window.VONNISALERT_CONFIG || {};
const configured = Boolean(cfg.supabaseUrl && cfg.supabaseKey);
const db = configured ? createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

const $ = (id) => document.getElementById(id);
const esc = (s = "") => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("app");

let state = { cases: [], articles: [], events: [], requests: [], settings: {}, user: null, filter: { q: "", court: "", status: "", author: "" }, weekOffset: 0, agendaYear: 2027 };
const authors = () => (Array.isArray(state.settings.followed_authors) && state.settings.followed_authors.length ? state.settings.followed_authors : DEFAULT_AUTHORS);
const today = () => brusselsDate(new Date());

function toast(msg, ms = 2800) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- opstart ----------

async function start() {
  if (!configured) {
    app.innerHTML = `<div class="notice warn"><strong>Nog niet gekoppeld.</strong> De databank wordt automatisch gekoppeld zodra de installatie via GitHub is uitgevoerd (zie README). Tot dan kan je niet inloggen.</div>`;
    return;
  }
  const { data } = await db.auth.getSession();
  db.auth.onAuthStateChange((_e, session) => {
    const had = Boolean(state.user);
    state.user = session?.user || null;
    if (had !== Boolean(state.user)) boot();
  });
  state.user = data.session?.user || null;
  boot();
}

async function boot() {
  const logged = Boolean(state.user);
  $("nav").hidden = !logged; $("headBtns").hidden = !logged;
  if (!logged) return renderLogin();
  try {
    await loadAll();
  } catch (e) {
    app.innerHTML = `<div class="notice err"><strong>Kon de gegevens niet laden.</strong><br>${esc(e.message || e)}</div>
      <p class="muted small">Is dit account wel als gebruiker ingesteld? Probeer opnieuw in te loggen.</p><button class="secondary" id="lo">Uitloggen</button>`;
    $("lo").onclick = () => db.auth.signOut();
    return;
  }
  route();
}

async function loadAll() {
  const [c, a, s, ev, rq] = await Promise.all([
    db.from("cases").select("*").order("verdict_date", { ascending: true, nullsFirst: false }),
    db.from("articles").select("article_id,source,url,title,lead,author,category,published_at,premium,announcement,analysis,case_id,dismissed").is("case_id", null).eq("dismissed", false).order("published_at", { ascending: false }).limit(150),
    db.from("app_state").select("key,value,updated_at"),
    db.from("agenda_events").select("*").order("start_date", { ascending: true, nullsFirst: false }),
    db.from("agenda_requests").select("*").order("created_at", { ascending: false }).limit(20),
  ]);
  for (const r of [c, a, s]) if (r.error) throw r.error;
  state.events = ev.error ? [] : ev.data || [];
  state.requests = rq.error ? [] : rq.data || [];
  state.cases = c.data || [];
  state.articles = a.data || [];
  state.settings = Object.fromEntries((s.data || []).map((r) => [r.key, r.value]));
  updateBadges();
}

function setTodayLabel() {
  const el = $("todayLabel");
  if (el) el.textContent = " · " + formatDateNL(today()).replace(/ \d{4}$/, "");
}
setTodayLabel();

function updateBadges() {
  $("badgeCheck").textContent = state.cases.filter(isOpenCheck).length;
  $("badgeArt").textContent = state.articles.filter((a) => !isColleagueItem(a.author)).length;
  $("authorTabs").innerHTML = colleagues().map((c) => {
    const n = state.articles.filter((a) => ownerOf(a.author)?.name === c.name).length;
    const h = "j/" + slug(c.name);
    return `<a href="#${h}" data-view="${h}" class="${location.hash === "#" + h ? "active" : ""}">${esc(c.name.split(" ")[0])} <span class="badge">${n}</span></a>`;
  }).join("");
  const lr = state.settings.last_run?.at;
  $("footer").innerHTML = `Ingelogd als ${esc(state.user?.email || "")} · laatste automatische controle: ${lr ? new Date(lr).toLocaleString("nl-BE", { timeZone: "Europe/Brussels" }) : "nog niet"} · automatische opvolging: <strong>${state.settings.rss_enabled ? "aan" : "uit"}</strong>`;
}

window.addEventListener("hashchange", () => state.user && route());
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.user && !$("caseDialog").open) { try { await loadAll(); route(); } catch { /* stil */ } }
});

// ---------- login ----------

function renderLogin() {
  const hr = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", hour12: false }).format(new Date())) % 24;
  const hi = { ochtend: "Goedemorgen", middag: "Goeiemiddag", avond: "Goeienavond", nacht: "Goeienacht" }[greetingAt(today(), hr).period];
  app.innerHTML = `<form class="login" id="loginForm">
    <img src="/logo.svg" alt="" class="llogo">
    <h1>${hi} Geert</h1>
    <p class="muted small lsub">Meld je aan om je vonnissen te bekijken. Je blijft op dit toestel aangemeld.</p>
    <div class="field"><label for="le">E-mailadres</label><input id="le" type="email" autocomplete="username" required></div>
    <div class="field"><label for="lp">Wachtwoord</label><input id="lp" type="password" autocomplete="current-password" required></div>
    <button class="primary" style="width:100%;justify-content:center">Aanmelden</button>
    <p class="small muted" id="lerr"></p></form>`;
  $("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    $("lerr").textContent = "Bezig…";
    const { error } = await db.auth.signInWithPassword({ email: $("le").value.trim(), password: $("lp").value });
    $("lerr").textContent = error ? "Aanmelden mislukt: controleer e-mailadres en wachtwoord." : "";
  };
}

// ---------- hulpfuncties ----------

const isArchived = (c) => c.archived || c.status === "bevestigd" || (c.verdict_date && diffDays(c.verdict_date, today()) > 21 && c.status !== "check");
const isOpenCheck = (c) => !isArchived(c) && (c.status === "check" || c.needs_review);
const sortDate = (a, b) => String(a.verdict_date || "9999").localeCompare(String(b.verdict_date || "9999"));

function dateLabel(c) {
  if (!c.verdict_date) return c.verdict_date_text ? `“${esc(c.verdict_date_text)}”` : "Datum onbekend";
  const d = diffDays(today(), c.verdict_date);
  const rel = d === 0 ? "vandaag" : d === 1 ? "morgen" : d === -1 ? "gisteren" : "";
  const f = formatDateNL(c.verdict_date).replace(/ \d{4}$/, "");
  return `${rel ? `<span>${rel} · </span>` : ""}${f}`;
}

function item(c) {
  const flags = [];
  if (c.date_certainty === "afgeleid") flags.push("datum afgeleid");
  if (c.date_certainty === "onzeker") flags.push("datum onzeker");
  if (c.court === "Te controleren") flags.push("rechtbank?");
  if (!c.author) flags.push("auteur?");
  const fa = followedAuthor(c.author, authors());
  const author = c.author ? (fa ? `${esc(fa.name)} ✓` : esc(c.author)) : "auteur onbekend";
  const medium = c.source === "hln" ? "HLN" : c.source === "rss" ? "HBVL" : fa?.medium || "";
  return `<div class="item st-${esc(c.status)}" data-id="${esc(c.id)}">
    <div class="main"><div class="title">${esc(c.title)}</div>
      <div class="meta"><span>${esc(c.defendant || "beklaagde niet vermeld")}</span><span>${esc(c.court)}</span><span>${author}</span>${medium ? `<span class="mtag">${esc(medium)}</span>` : ""}${c.needs_review && flags.length ? `<span class="flag">⚠ ${flags.join(", ")}</span>` : ""}</div></div>
    <div class="side"><span class="date">${dateLabel(c)}</span><span class="pill s-${esc(c.status)}">${esc(STATUS[c.status] || c.status)}</span></div></div>`;
}

const list = (arr, empty = "Niets.") => (arr.length ? `<div class="list">${arr.map(item).join("")}</div>` : `<div class="empty">${empty}</div>`);
const block = (title, arr, empty, extra = "") => `<section class="block"><div class="blockhead"><h2>${title} <span class="muted small">(${arr.length})</span></h2>${extra}</div>${list(arr, empty)}</section>`;

function bindItems() {
  app.querySelectorAll(".item[data-id]").forEach((el) => (el.onclick = () => openCase(el.dataset.id)));
}

// ---------- views ----------

function route() {
  const h = location.hash.replace(/^#/, "") || "vandaag";
  if (h.startsWith("dossier/")) { renderToday(); openCase(h.split("/")[1]); return; }
  if (h.startsWith("j/")) {
    document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === h));
    renderJournalist(h.slice(2)); bindItems(); return;
  }
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === h));
  ({ vandaag: renderToday, komend: renderUpcoming, week: renderWeek, controle: renderCheck, artikels: renderArticles, agenda: renderAgenda, alle: renderAll, archief: renderArchive, instellingen: renderSettings }[h] || renderToday)();
  bindItems();
}

function renderToday() {
  const t = today(), tm = addDays(t, 1);
  const open = state.cases.filter((c) => !c.archived && c.status !== "bevestigd");
  const vandaag = open.filter((c) => c.verdict_date === t && c.status !== "uitgesteld");
  const morgen = open.filter((c) => c.verdict_date === tm && c.status !== "uitgesteld");
  const nieuw = state.cases.filter((c) => c.created_at && Date.now() - new Date(c.created_at).getTime() < 36 * 3600e3).sort(sortDate);
  const onbevestigd = open.filter((c) => c.verdict_date && c.verdict_date < t && c.status !== "uitgesteld").sort(sortDate);
  const uitgesteld = open.filter((c) => c.status === "uitgesteld").sort(sortDate);
  const week = open.filter((c) => c.verdict_date && diffDays(t, c.verdict_date) >= 0 && diffDays(t, c.verdict_date) < 7);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", hour12: false }).format(new Date())) % 24;
  const g = greetingAt(t, hour);
  const icon = { ochtend: "☀️", middag: "🌤️", avond: "🌆", nacht: "🌙" }[g.period];
  app.innerHTML = `
    <section class="greet g-${g.period}${g.isTomDay ? " tom" : ""}"><div class="gi">${g.isTomDay ? "🍺" : icon}</div><div class="gk">${esc(g.kicker.replace(/^\S+\s/, ""))}</div><div class="gt">${esc(g.line)}</div></section>
    ${state.settings.rss_enabled ? "" : `<div class="notice">Automatische HBVL-opvolging staat <strong>uit</strong>. Nieuwe zaken voeg je toe met <strong>＋ Dossier</strong> (artikel plakken). Zie ⚙︎ Instellingen.</div>`}
    <div class="cards">
      <a class="card c-vandaag" href="#vandaag"><span class="ci">⚖️</span><div class="label">Uitspraak vandaag</div><div class="num">${vandaag.length}</div></a>
      <a class="card c-morgen" href="#vandaag"><span class="ci">⏰</span><div class="label">Uitspraak morgen</div><div class="num">${morgen.length}</div></a>
      <a class="card c-week" href="#week"><span class="ci">📅</span><div class="label">Komende 7 dagen</div><div class="num">${week.length}</div></a>
      <a class="card c-check" href="#controle"><span class="ci">🔍</span><div class="label">Nog te controleren</div><div class="num">${state.cases.filter(isOpenCheck).length}</div></a>
    </div>
    ${block("Uitspraken vandaag", vandaag, "Vandaag geen aangekondigde uitspraken.")}
    ${block("Uitspraken morgen", morgen, "Morgen geen aangekondigde uitspraken.")}
    ${block("Nieuw (laatste 36 uur)", nieuw, "Geen nieuwe aankondigingen.")}
    ${block("Aangekondigd, nog niet bevestigd", onbevestigd, "Alles is bijgewerkt.")}
    ${block("Uitgesteld of gewijzigd", uitgesteld, "Geen uitgestelde zaken.")}
    ${(() => {
      const evs = state.events.filter((e) => e.start_date && (e.end_date || e.start_date) >= t && e.start_date <= addDays(t, 7));
      return evs.length ? `<section class="block"><div class="blockhead"><h2>Agenda komende 7 dagen <span class="muted small">(${evs.length})</span></h2><a href="#agenda" class="small">Volledige agenda →</a></div><div class="list">${evs.map((e) => `<div class="item ev-${esc(e.status)}" onclick="location.hash='agenda'"><div class="main"><div class="title">${esc(e.title)}</div><div class="meta">${e.place ? esc(e.place) : ""}</div></div><div class="side"><span class="date">${evDateLabel(e)}</span><span class="pill e-${esc(e.status)}">${EV_STATUS[e.status]}</span></div></div>`).join("")}</div></section>` : "";
    })()}`;
}

function renderUpcoming() {
  const t = today();
  const up = state.cases.filter((c) => !isArchived(c) && c.verdict_date && c.verdict_date >= t).sort(sortDate);
  const nodate = state.cases.filter((c) => !isArchived(c) && !c.verdict_date);
  app.innerHTML = `<h1>Komende uitspraken</h1><p class="muted">Gesorteerd op verwachte uitspraakdatum.</p>
    ${block("Met datum", up, "Geen komende uitspraken.")}${block("Zonder exacte datum", nodate, "Geen.")}`;
}

function renderWeek() {
  const t = today();
  const monday = addDays(t, -((weekday(t) + 6) % 7) + state.weekOffset * 7);
  const days = [...Array(7)].map((_, i) => addDays(monday, i));
  app.innerHTML = `<h1>Weekoverzicht</h1>
    <div class="weeknav"><button class="secondary sm" id="wPrev">‹ Vorige</button><button class="secondary sm" id="wNow">Deze week</button><button class="secondary sm" id="wNext">Volgende ›</button>
    <span class="muted small">${formatDateNL(days[0], false)} – ${formatDateNL(days[6], false)}</span></div>
    ${days.map((d) => {
      const arr = state.cases.filter((c) => c.verdict_date === d && !c.archived);
      return `<div class="day ${d === t ? "today" : ""}"><h3>${formatDateNL(d).replace(/ \d{4}$/, "")}${d === t ? " · vandaag" : ""}</h3>${list(arr, "—")}</div>`;
    }).join("")}`;
  $("wPrev").onclick = () => { state.weekOffset--; route(); };
  $("wNext").onclick = () => { state.weekOffset++; route(); };
  $("wNow").onclick = () => { state.weekOffset = 0; route(); };
}

function renderCheck() {
  const arr = state.cases.filter(isOpenCheck).sort(sortDate);
  app.innerHTML = `<h1>Nog te controleren</h1><p class="muted">Dossiers met een afgeleide of onzekere datum, een onbekende rechtbank of auteur, of een verstreken datum zonder bevestiging. Open een dossier, controleer en vink “gecontroleerd” aan.</p>${list(arr, "Niets te controleren. 🎉")}`;
}

// Artikels per journalist: de eerste in de lijst (Geert) is de hoofdgebruiker; collega's krijgen een eigen tabblad
const slug = (n) => String(n || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const colleagues = () => authors().slice(1);
const ownerOf = (author) => followedAuthor(author, authors());
const isColleagueItem = (author) => { const o = ownerOf(author); return Boolean(o && colleagues().some((c) => c.name === o.name)); };

function artItem(a) {
  return `<div class="item" style="cursor:default"><div class="main"><div class="title">${esc(a.title)}</div>
      <div class="meta"><span>${a.published_at ? new Date(a.published_at).toLocaleString("nl-BE", { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" }) : ""}</span><span>${esc(a.author || "auteur onbekend")}</span>${a.premium ? "<span>Plus</span>" : ""}<span class="mtag">${a.source === "google" ? "Google News" : a.source === "hln" ? "HLN" : "HBVL"}</span></div>
      ${a.lead ? `<div class="small muted" style="margin-top:6px">${esc(a.lead.slice(0, 260))}${a.lead.length > 260 ? "…" : ""}</div>` : ""}</div>
      <div class="side"><a class="btn secondary sm" href="${esc(a.url)}" target="_blank" rel="noopener">Open ↗</a><button class="primary sm" data-mk="${esc(a.article_id)}">Maak dossier</button><button class="secondary sm" data-dis="${esc(a.article_id)}">Negeer</button></div></div>`;
}
function bindArticleButtons() {
  app.querySelectorAll("[data-dis]").forEach((b) => (b.onclick = async () => {
    const { error } = await db.from("articles").update({ dismissed: true }).eq("article_id", b.dataset.dis);
    if (error) return toast("Fout: " + error.message);
    state.articles = state.articles.filter((x) => x.article_id !== b.dataset.dis); updateBadges(); route();
  }));
  app.querySelectorAll("[data-mk]").forEach((b) => (b.onclick = () => {
    const a = state.articles.find((x) => x.article_id === b.dataset.mk);
    openNew({ url: a.url, text: [a.title, a.lead].filter(Boolean).join("\n"), pub: a.published_at, author: a.author, articleId: a.article_id });
  }));
}

function renderArticles() {
  const arts = state.articles.filter((a) => !isColleagueItem(a.author));
  app.innerHTML = `<h1>Gerechtsartikels</h1>
    <p class="muted">Rechtbankartikels zonder herkende aankondiging in titel of intro. De aankondiging staat soms pas verderop in het artikel: open het, en plak de tekst als dossier als er een uitspraak wordt aangekondigd.${colleagues().length ? ` Artikels van ${colleagues().map((c) => esc(c.name)).join(", ")} staan in een eigen tabblad.` : ""}</p>
    ${state.settings.rss_enabled ? "" : `<div class="notice">De automatische opvolging staat uit, dus deze lijst wordt niet automatisch aangevuld.</div>`}
    ${arts.length ? `<div class="list">${arts.map(artItem).join("")}</div>` : `<div class="empty">Geen openstaande gerechtsartikels.</div>`}`;
  bindArticleButtons();
}

function renderJournalist(sl) {
  const j = colleagues().find((c) => slug(c.name) === sl);
  if (!j) { location.hash = "#vandaag"; return; }
  const own = (x) => ownerOf(x)?.name === j.name;
  const cases = state.cases.filter((c) => own(c.author) && !isArchived(c)).sort(sortDate);
  const arch = state.cases.filter((c) => own(c.author) && isArchived(c)).sort((a, b) => sortDate(b, a));
  const arts = state.articles.filter((a) => own(a.author));
  app.innerHTML = `<h1>${esc(j.name)} <span class="mtag" style="font-size:13px;vertical-align:middle">${esc(j.medium || "")}</span></h1>
    <p class="muted">Alles van ${esc(j.name.split(" ")[0])} op één plaats: dossiers met een aangekondigde uitspraak en rechtbankartikels om na te kijken.</p>
    ${block("Dossiers", cases, "Nog geen dossiers.")}
    <section class="block"><div class="blockhead"><h2>Rechtbankartikels om na te kijken <span class="muted small">(${arts.length})</span></h2></div>
      ${arts.length ? `<div class="list">${arts.map(artItem).join("")}</div>` : `<div class="empty">Geen openstaande artikels.</div>`}</section>
    ${arch.length ? block("Afgewerkt", arch, "") : ""}`;
  bindArticleButtons();
}

function renderAll() {
  const f = state.filter;
  const q = f.q.toLowerCase();
  const arr = state.cases.filter((c) =>
    (!f.court || c.court === f.court) && (!f.status || c.status === f.status) &&
    (!f.author || (followedAuthor(c.author, authors())?.name === f.author)) &&
    (!q || [c.title, c.defendant, c.author, c.notes, c.court].join(" ").toLowerCase().includes(q))).sort(sortDate);
  app.innerHTML = `<h1>Zoeken</h1>
    <div class="filters"><input id="fq" placeholder="Zoek op zaak, beklaagde, auteur, notities…" value="${esc(f.q)}">
    <select id="fc"><option value="">Hasselt + Tongeren</option><option ${f.court === "Hasselt" ? "selected" : ""}>Hasselt</option><option ${f.court === "Tongeren" ? "selected" : ""}>Tongeren</option><option ${f.court === "Te controleren" ? "selected" : ""}>Te controleren</option></select>
    <select id="fa"><option value="">Alle journalisten</option>${authors().map((x) => `<option ${f.author === x.name ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
    <select id="fs"><option value="">Alle statussen</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
    <p class="muted small">${arr.length} dossier(s)</p><div id="res">${list(arr, "Geen dossiers gevonden.")}</div>`;
  $("fq").oninput = (e) => { f.q = e.target.value; const pos = e.target.selectionStart; route(); $("fq").focus(); $("fq").setSelectionRange(pos, pos); };
  $("fc").onchange = (e) => { f.court = e.target.value; route(); };
  $("fs").onchange = (e) => { f.status = e.target.value; route(); };
  $("fa").onchange = (e) => { f.author = e.target.value; route(); };
}

function renderArchive() {
  const arr = state.cases.filter(isArchived).sort((a, b) => sortDate(b, a));
  app.innerHTML = `<h1>Archief</h1><p class="muted">Bevestigde uitspraken en oudere zaken.</p>${list(arr, "Het archief is nog leeg.")}`;
}

function renderSettings() {
  const s = state.settings;
  const lr = s.last_run, ld = s.last_digest;
  app.innerHTML = `<h1>Instellingen</h1><div class="settings">
    <div class="row"><div><strong>Automatische HBVL-opvolging</strong><p>Elke 15 minuten de publieke RSS-feeds van HBVL en HLN (regio Hasselt) controleren op aangekondigde uitspraken (titel, intro, auteur).<br><span class="flag">Let op:</span> HBVL en DPG Media (HLN) behouden zich het recht voor om automatische gegevensverzameling te verbieden. Zet dit pas aan als je daarvoor toestemming hebt.</p></div>
      <label class="switch"><input type="checkbox" id="sRss" ${s.rss_enabled ? "checked" : ""}><span></span></label></div>
    <div class="row" style="display:block"><strong>Gevolgde journalisten</strong><p>De automatische opvolging zoekt in de HBVL-feed en de HLN-feed (regio Hasselt) naar artikels van deze journalisten. Schrijf de naam zoals ze onder het artikel staat.</p>
      <div id="authList" style="margin-top:8px"></div>
      <div class="filters" style="margin-top:8px"><input id="newAuth" placeholder="Naam journalist"><select id="newMed"><option>HBVL</option><option>HLN</option></select><button class="secondary sm" id="addAuth">＋ Toevoegen</button></div></div>
    <div class="row"><div><strong>Alleen artikels van gevolgde journalisten</strong><p>Aan: enkel artikels van bovenstaande journalisten. Uit: alle artikels uit de feeds plus Google News.</p></div>
      <label class="switch"><input type="checkbox" id="sGeert" ${s.only_geert !== false ? "checked" : ""}><span></span></label></div>
    <div class="row"><div><strong>Ochtendmail om 07.00 uur</strong><p>Overzicht van nieuwe aankondigingen, uitspraken vandaag en morgen, onbevestigde en uitgestelde zaken.</p></div>
      <label class="switch"><input type="checkbox" id="sMail" ${s.mail_enabled !== false ? "checked" : ""}><span></span></label></div>
    <div class="row"><div><strong>Herinnering om 18.00 uur</strong><p>Mail de avond voordien als er de volgende dag uitspraken verwacht worden.</p></div>
      <label class="switch"><input type="checkbox" id="sRem" ${s.reminder_enabled !== false ? "checked" : ""}><span></span></label></div>
    <div class="row"><div><strong>Nu controleren</strong><p>Voert de automatische controle meteen uit (statussen${s.rss_enabled ? " en feeds" : ""}).</p></div><button class="primary sm" id="runNow">Start</button></div>
    <div class="row"><div><strong>Testmail</strong><p>Stuurt het huidige overzicht als test naar het ingestelde e-mailadres.</p></div><button class="secondary sm" id="testMail">Verstuur</button></div>
    <div class="row"><div><strong>Laatste controle</strong><p>${lr ? new Date(lr.at).toLocaleString("nl-BE", { timeZone: "Europe/Brussels" }) : "Nog niet uitgevoerd."}</p>
      <p>Laatste ochtendmail: ${ld ? `${esc(ld.subject)} – ${ld.mail?.sent ? "verstuurd" : esc(ld.mail?.reason || "niet verstuurd")}` : "nog geen"}</p></div></div>
    <pre class="log" id="runOut" hidden></pre>
    <div class="row"><div><strong>Afmelden</strong><p>${esc(state.user?.email || "")}</p></div><button class="secondary sm" id="logout">Afmelden</button></div></div>`;
  const toggle = (key, el) => (el.onchange = async () => {
    if (key === "rss_enabled" && el.checked && !confirm("Bevestig dat jullie toestemming hebben om de feeds van HBVL en HLN automatisch te verwerken.")) { el.checked = false; return; }
    const { error } = await db.from("app_state").update({ value: el.checked, updated_at: new Date().toISOString() }).eq("key", key);
    if (error) { el.checked = !el.checked; return toast("Fout: " + error.message); }
    state.settings[key] = el.checked; updateBadges(); toast("Bewaard");
  });
  toggle("rss_enabled", $("sRss")); toggle("only_geert", $("sGeert")); toggle("mail_enabled", $("sMail")); toggle("reminder_enabled", $("sRem"));
  const renderAuth = () => {
    $("authList").innerHTML = authors().map((x, i) => `<div class="item" style="cursor:default;padding:8px 12px;margin-bottom:6px"><div class="main"><div class="title">${esc(x.name)} <span class="mtag">${esc(x.medium || "")}</span></div></div><div class="side"><button class="secondary sm" data-rmauth="${i}">Verwijderen</button></div></div>`).join("");
    $("authList").querySelectorAll("[data-rmauth]").forEach((b) => (b.onclick = () => saveAuth(authors().filter((_, i) => i !== Number(b.dataset.rmauth)))));
  };
  const saveAuth = async (list) => {
    if (!list.length) return toast("Er moet minstens één journalist overblijven.");
    const { error } = await db.from("app_state").update({ value: list, updated_at: new Date().toISOString() }).eq("key", "followed_authors");
    if (error) return toast("Fout: " + error.message);
    state.settings.followed_authors = list; renderAuth(); toast("Bewaard");
  };
  renderAuth();
  $("addAuth").onclick = () => {
    const name = $("newAuth").value.trim().replace(/\s+/g, " ");
    if (name.length < 3) return toast("Geef een volledige naam.");
    if (authors().some((x) => x.name.toLowerCase() === name.toLowerCase())) return toast("Staat al in de lijst.");
    saveAuth([...authors(), { name, medium: $("newMed").value }]);
  };
  $("runNow").onclick = () => callFn("run", $("runNow"));
  $("testMail").onclick = () => callFn("testmail", $("testMail"));
  $("logout").onclick = () => db.auth.signOut();
}

async function callFn(action, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = "Bezig…";
  try {
    const { data, error } = await db.functions.invoke("vonnisalert", { body: { action } });
    const out = $("runOut");
    out.hidden = false;
    if (error) {
      let detail = error.message;
      try { detail = JSON.stringify(await error.context.json(), null, 2); } catch { /* */ }
      out.textContent = "Fout: " + detail;
    } else out.textContent = JSON.stringify(data, null, 2);
    await loadAll();
  } catch (e) { toast("Fout: " + e.message); }
  btn.disabled = false; btn.textContent = old;
}

// ---------- agenda ----------

const EV_STATUS = { bevestigd: "Bevestigd", te_bevestigen: "Te bevestigen", voorspelling: "Voorspelling", eenmalig: "Eenmalig" };
const MONTHS_NL = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function evDateLabel(e) {
  if (!e.start_date) return e.status === "eenmalig" ? "Niet verwacht" : "Datum onbekend";
  const a = formatDateNL(e.start_date).replace(/ \d{4}$/, "");
  if (!e.end_date || e.end_date === e.start_date) return a;
  return `${a} – ${formatDateNL(e.end_date).replace(/ \d{4}$/, "")}`;
}

function renderAgenda() {
  const y = state.agendaYear;
  const inYear = state.events.filter((e) => e.start_date ? e.start_date.startsWith(String(y)) : true);
  const years = [...new Set(state.events.map((e) => e.start_date?.slice(0, 4)).filter(Boolean))].sort();
  if (!years.includes(String(y))) years.push(String(y));
  const byMonth = {};
  for (const e of inYear) { const k = e.start_date ? Number(e.start_date.slice(5, 7)) - 1 : 99; (byMonth[k] ||= []).push(e); }
  const t = today();
  const evItem = (e) => {
    const past = e.end_date ? e.end_date < t : e.start_date && e.start_date < t;
    return `<div class="item ev-${esc(e.status)}" data-ev="${esc(e.id)}" style="${past ? "opacity:.6" : ""}">
      <div class="main"><div class="title">${esc(e.title)}</div>
        <div class="meta">${e.place ? `<span>📍 ${esc(e.place)}</span>` : ""}${e.previous ? `<span>vorige editie: ${esc(e.previous)}</span>` : ""}</div>
        ${e.basis ? `<div class="basis">${esc(e.basis)}</div>` : ""}</div>
      <div class="side"><span class="date">${evDateLabel(e)}</span><span class="pill e-${esc(e.status)}">${EV_STATUS[e.status] || e.status}</span></div></div>`;
  };
  app.innerHTML = `<h1>Agenda ${y}</h1>
    <p class="muted">Terugkerende evenementen om op te volgen voor verslaggeving. Kijk “te bevestigen” en “voorspelling” na zodra de organisatie de datum bekendmaakt.</p>
    <div class="filters"><select id="agYear">${years.map((yy) => `<option ${String(y) === yy ? "selected" : ""}>${yy}</option>`).join("")}</select>
      <button class="primary sm" id="evAdd">＋ Evenement</button> <button class="secondary sm" id="reqAdd">📋 Lijst laten checken</button></div>
    ${state.requests.length ? `<div class="notice"><strong>Lijsten om te checken</strong>${state.requests.slice(0, 5).map((r) => `<div style="margin-top:6px">${r.status === "wachtend" ? "⏳" : r.status === "verwerkt" ? "✅" : "⚠️"} ${new Date(r.created_at).toLocaleDateString("nl-BE")} · ${r.target_year} · ${esc(r.content.split("\n").filter((l) => l.trim()).length)} regels · <strong>${esc(r.status)}</strong>${r.result_note ? ` – ${esc(r.result_note)}` : r.status === "wachtend" ? " – wordt bij de volgende automatische controle opgezocht" : ""}</div>`).join("")}</div>` : ""}
    <div class="legend"><span class="pill e-bevestigd">Bevestigd</span> datum officieel <span class="pill e-te_bevestigen">Te bevestigen</span> bijna zeker <span class="pill e-voorspelling">Voorspelling</span> afgeleid uit vorige jaren <span class="pill e-eenmalig">Eenmalig</span> geen nieuwe editie verwacht</div>
    ${Object.keys(byMonth).sort((a, b) => a - b).map((k) => `<h2 class="monthhead">${k == 99 ? "Zonder datum" : MONTHS_NL[k] + " " + y}</h2><div class="list">${byMonth[k].map(evItem).join("")}</div>`).join("") || `<div class="empty">Nog geen evenementen voor ${y}.</div>`}`;
  $("agYear").onchange = (e) => { state.agendaYear = Number(e.target.value); route(); };
  $("evAdd").onclick = () => openEvent(null);
  $("reqAdd").onclick = () => { $("rq_year").value = String(state.agendaYear); $("rq_text").value = ""; $("rq_file").value = ""; rqDlg.showModal(); };
  app.querySelectorAll("[data-ev]").forEach((el) => (el.onclick = () => openEvent(el.dataset.ev)));
}

const evDlg = $("evDialog");
evDlg.querySelectorAll("[data-evclose]").forEach((b) => (b.onclick = () => evDlg.close()));
function openEvent(id) {
  const e = id ? state.events.find((x) => x.id === id) : { status: "voorspelling", start_date: `${state.agendaYear}-01-01` };
  $("evTitle").textContent = id ? "Evenement" : "Nieuw evenement";
  $("e_id").value = id || "";
  $("e_title").value = e.title || ""; $("e_place").value = e.place || "";
  $("e_start").value = id ? e.start_date || "" : ""; $("e_end").value = e.end_date || "";
  $("e_status").value = e.status || "voorspelling"; $("e_prev").value = e.previous || "";
  $("e_basis").value = e.basis || ""; $("e_url").value = e.source_url || ""; $("e_notes").value = e.notes || "";
  $("evDelete").hidden = !id; $("evOpen").hidden = !e.source_url; if (e.source_url) $("evOpen").href = e.source_url;
  evDlg.showModal();
}
$("evForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const id = $("e_id").value;
  const row = {
    title: $("e_title").value.trim(), place: $("e_place").value.trim() || null,
    start_date: $("e_start").value || null, end_date: $("e_end").value || null,
    status: $("e_status").value, previous: $("e_prev").value.trim() || null,
    basis: $("e_basis").value.trim() || null, source_url: $("e_url").value.trim() || null, notes: $("e_notes").value.trim() || null,
  };
  if (!row.title) return toast("Geef een naam voor het evenement.");
  if (row.end_date && row.start_date && row.end_date < row.start_date) return toast("De einddatum ligt voor de startdatum.");
  const res = id ? await db.from("agenda_events").update(row).eq("id", id) : await db.from("agenda_events").insert(row);
  if (res.error) return toast("Fout: " + res.error.message, 4500);
  evDlg.close(); toast("Evenement bewaard");
  if (row.start_date) state.agendaYear = Number(row.start_date.slice(0, 4));
  await loadAll(); route();
};
$("evDelete").onclick = async () => {
  const id = $("e_id").value;
  if (!id || !confirm("Dit evenement verwijderen?")) return;
  const { error } = await db.from("agenda_events").delete().eq("id", id);
  if (error) return toast("Fout: " + error.message);
  evDlg.close(); await loadAll(); route();
};

const rqDlg = $("rqDialog");
rqDlg.querySelectorAll("[data-rqclose]").forEach((b) => (b.onclick = () => rqDlg.close()));
$("rq_file").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 200000) return toast("Bestand te groot (max. 200 kB).");
  if (!/\.(txt|csv|md|tsv)$/i.test(f.name) && !f.type.startsWith("text/")) return toast("Gebruik een tekstbestand (.txt of .csv), of kopieer de lijst uit Word en plak ze hier.");
  $("rq_text").value = (await f.text()).slice(0, 20000);
};
$("rqForm").onsubmit = async (e) => {
  e.preventDefault();
  const content = $("rq_text").value.trim();
  if (content.length < 3) return toast("Plak of upload eerst een lijst.");
  const { error } = await db.from("agenda_requests").insert({ content: content.slice(0, 20000), target_year: Number($("rq_year").value) });
  if (error) return toast("Fout: " + error.message);
  rqDlg.close(); toast("Lijst ontvangen – wordt bij de volgende controle opgezocht");
  await loadAll(); route();
};

// ---------- dossier toevoegen / bewerken ----------

const dlg = $("caseDialog");
let pendingArticleId = null;
let lastAnalysis = null;

function setMode(mode) {
  document.querySelectorAll("#modeTabs button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("pasteBox").hidden = mode !== "paste";
  $("formBox").hidden = mode === "paste" && !lastAnalysis;
}
document.querySelectorAll("#modeTabs button").forEach((b) => (b.onclick = () => { if (b.dataset.mode === "manual") lastAnalysis = lastAnalysis || {}; setMode(b.dataset.mode); }));
dlg.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => dlg.close()));
dlg.addEventListener("close", () => { if (location.hash.startsWith("#dossier/")) history.replaceState(null, "", "#vandaag"); });

function fillForm(c = {}) {
  $("caseId").value = c.id || "";
  $("f_title").value = c.title || "";
  $("f_defendant").value = c.defendant || "";
  $("f_author").value = c.author || "";
  $("f_author_is_geert").value = c.author_is_geert == null ? "" : String(c.author_is_geert);
  $("f_published").value = c.published_at ? brusselsDate(c.published_at) : "";
  $("f_hearing").value = c.hearing_date || "";
  $("f_verdict").value = c.verdict_date || "";
  $("f_court").value = c.court || "Te controleren";
  $("f_status").value = c.status || "check";
  $("f_auto").checked = !c.status_manual;
  $("f_reviewed").checked = c.id ? !c.needs_review : false;
  $("f_url").value = c.article_url || "";
  $("f_notes").value = c.notes || "";
  $("openArticle").hidden = !c.article_url; if (c.article_url) $("openArticle").href = c.article_url;
}

function openNew(prefill = {}) {
  lastAnalysis = null; pendingArticleId = prefill.articleId || null;
  $("dialogTitle").textContent = "Nieuw dossier";
  $("pasteUrl").value = prefill.url || ""; $("pasteText").value = prefill.text || "";
  $("pastePub").value = prefill.pub ? brusselsDate(prefill.pub) : today();
  $("pasteAuthor").value = prefill.author || "";
  $("analysisOut").innerHTML = ""; $("caseExtra").innerHTML = "";
  $("modeTabs").hidden = false; $("deleteBtn").hidden = true;
  fillForm({});
  setMode("paste");
  dlg.showModal();
  if (prefill.text) analyze();
}
$("addBtn").onclick = () => openNew();

function analyze() {
  const url = $("pasteUrl").value.trim();
  const text = $("pasteText").value.trim();
  if (!text) return toast("Plak eerst de tekst van het artikel.");
  const aid = articleIdFromUrl(url);
  const dup = state.cases.find((c) => (aid && c.article_id === aid) || (url && c.article_url === url));
  if (dup) { dlg.close(); toast("Dit artikel zit al in een dossier."); return openCase(dup.id); }
  const [title, ...rest] = text.split(/\n+/);
  const pub = $("pastePub").value || today();
  const r = analyzeArticle({ title, text: rest.join("\n"), publishedAt: `${pub}T10:00:00Z`, author: $("pasteAuthor").value });
  lastAnalysis = r;
  $("analysisOut").innerHTML = `<div class="analysis">
    <strong>${r.hasAnnouncement ? "✅ Aankondiging gevonden" : "⚠ Geen duidelijke aankondiging gevonden"}</strong>
    ${r.announcement ? `<div style="margin-top:4px">“${esc(r.announcement.sentence)}”</div>` : ""}
    <ul><li>Uitspraakdatum: <strong>${r.verdictDate ? formatDateNL(r.verdictDate) : "niet gevonden"}</strong>${r.dateCertainty ? ` (${r.dateCertainty})` : ""}</li>
    <li>Rechtbank: <strong>${esc(r.court)}</strong>${r.courtEvidence && r.court !== "Te controleren" ? ` – “${esc(r.courtEvidence.slice(0, 140))}”` : ""}</li>
    <li>Beklaagde: ${esc(r.defendant || "niet gevonden")}</li>${r.hearingDate ? `<li>Zitting: ${formatDateNL(r.hearingDate)}</li>` : ""}
    ${r.reasons.length ? `<li>Te controleren: ${r.reasons.map(esc).join(" ")}</li>` : ""}</ul>
    <div class="small muted" style="margin-top:6px">Controleer en vul hieronder aan, en bewaar.</div></div>`;
  const notes = [];
  if (r.announcement) notes.push(`Aankondiging: “${r.announcement.sentence}”`);
  if (r.outcome) notes.push(`Mogelijk al uitspraak in tekst: “${r.outcome.sentence}”`);
  fillForm({
    title: title.slice(0, 400), defendant: r.defendant, author: $("pasteAuthor").value.trim() || null,
    author_is_geert: $("pasteAuthor").value.trim() ? isGeertHouben($("pasteAuthor").value) : null,
    published_at: `${pub}T10:00:00Z`, hearing_date: r.hearingDate, verdict_date: r.verdictDate,
    court: r.court, status: r.status, article_url: url, notes: notes.join("\n"),
  });
  $("formBox").hidden = false;
}
$("analyzeBtn").onclick = analyze;

async function openCase(id) {
  const c = state.cases.find((x) => x.id === id);
  if (!c) return toast("Dossier niet gevonden.");
  lastAnalysis = {}; pendingArticleId = null;
  $("dialogTitle").textContent = "Dossier";
  $("modeTabs").hidden = true; $("pasteBox").hidden = true; $("formBox").hidden = false;
  $("deleteBtn").hidden = false;
  fillForm(c);
  const links = (c.extra_links || []).map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || l.url)}</a></li>`).join("");
  $("caseExtra").innerHTML = `${c.review_reasons?.length && c.needs_review ? `<div class="analysis"><strong>Waarom te controleren?</strong><ul>${c.review_reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
    ${links ? `<div class="analysis"><strong>Gekoppelde artikels</strong><ul>${links}</ul></div>` : ""}
    <div style="margin-top:12px"><strong class="small">Geschiedenis</strong><ul class="events" id="evList"><li class="muted">Laden…</li></ul></div>
    <p class="small muted">Bron: ${esc(c.source)} · aangemaakt ${new Date(c.created_at).toLocaleString("nl-BE", { timeZone: "Europe/Brussels" })}${c.verdict_date_text ? ` · datum uit tekst: “${esc(c.verdict_date_text)}”` : ""}</p>`;
  if (!dlg.open) dlg.showModal();
  const { data } = await db.from("case_events").select("at,kind,message").eq("case_id", id).order("at", { ascending: false }).limit(30);
  $("evList").innerHTML = (data || []).map((e) => `<li><time>${new Date(e.at).toLocaleString("nl-BE", { timeZone: "Europe/Brussels" })}</time>${esc(e.message)}</li>`).join("") || `<li class="muted">Geen geschiedenis.</li>`;
}

$("caseForm").onsubmit = async (e) => {
  e.preventDefault();
  if ($("formBox").hidden) return analyze();
  const id = $("caseId").value || null;
  const old = id ? state.cases.find((c) => c.id === id) : null;
  const url = $("f_url").value.trim() || null;
  const verdict = $("f_verdict").value || null;
  const auto = $("f_auto").checked;
  const row = {
    title: $("f_title").value.trim(),
    defendant: $("f_defendant").value.trim() || null,
    author: $("f_author").value.trim() || null,
    author_is_geert: $("f_author_is_geert").value === "" ? null : $("f_author_is_geert").value === "true",
    article_url: url,
    published_at: $("f_published").value ? `${$("f_published").value}T10:00:00Z` : null,
    hearing_date: $("f_hearing").value || null,
    verdict_date: verdict,
    court: $("f_court").value,
    status: $("f_status").value,
    status_manual: !auto,
    needs_review: !$("f_reviewed").checked,
    notes: $("f_notes").value.trim() || null,
  };
  if (!row.title) return toast("Geef een omschrijving van de zaak.");
  if (!old || old.verdict_date !== verdict) {
    if (old && verdict) row.date_certainty = "handmatig";
    else if (!old && lastAnalysis?.verdictDate && lastAnalysis.verdictDate === verdict) { row.date_certainty = lastAnalysis.dateCertainty; row.verdict_date_text = lastAnalysis.dateText; }
    else if (verdict) row.date_certainty = "handmatig";
  }
  if (row.needs_review === false) row.review_reasons = [];
  // automatische status meteen correct zetten
  if (auto && verdict && !["bevestigd", "uitgesteld"].includes(row.status)) {
    const d = diffDays(today(), verdict);
    if (d === 0) row.status = "vandaag"; else if (d === 1) row.status = "morgen"; else if (d > 1 && row.status !== "check") row.status = "aangekondigd";
  }
  $("saveBtn").disabled = true;
  let res;
  if (old) {
    res = await db.from("cases").update(row).eq("id", id).select().single();
  } else {
    row.article_id = pendingArticleId || articleIdFromUrl(url);
    row.source = lastAnalysis && Object.keys(lastAnalysis).length ? "geplakt" : "manueel";
    row.review_reasons = row.needs_review ? (lastAnalysis?.reasons || []) : [];
    res = await db.from("cases").insert(row).select().single();
  }
  $("saveBtn").disabled = false;
  if (res.error) return toast(res.error.code === "23505" ? "Er bestaat al een dossier voor dit artikel." : "Fout: " + res.error.message, 4500);
  const saved = res.data;
  const changes = old ? Object.keys(row).filter((k) => JSON.stringify(old[k] ?? null) !== JSON.stringify(row[k] ?? null)) : [];
  await db.from("case_events").insert({ case_id: saved.id, kind: old ? "handmatig" : "aangemaakt", message: old ? `Handmatig aangepast: ${changes.join(", ") || "geen wijzigingen"}.` : `Handmatig aangemaakt${row.source === "geplakt" ? " uit geplakte artikeltekst" : ""}.` });
  if (pendingArticleId) await db.from("articles").update({ case_id: saved.id }).eq("article_id", pendingArticleId);
  dlg.close(); toast("Dossier bewaard");
  await loadAll(); route();
};

$("deleteBtn").onclick = async () => {
  const id = $("caseId").value;
  if (!id || !confirm("Dit dossier definitief verwijderen?")) return;
  const { error } = await db.from("cases").delete().eq("id", id);
  if (error) return toast("Fout: " + error.message);
  dlg.close(); await loadAll(); route();
};

start();
