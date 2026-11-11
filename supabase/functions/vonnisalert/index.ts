// Vonnisalert Limburg – geplande taak (Supabase Edge Function, Deno)
//
// Wordt elke 15 minuten aangeroepen door pg_cron (header x-cron-secret).
// Kan ook vanuit de app manueel gestart worden door Geert (met zijn login).
//
// Taken per run:
//  1. Feeds ophalen en verwerken – alleen als "rss_enabled" aan staat.
//  2. Statussen bijwerken (morgen / vandaag / datum verstreken).
//  3. Om 07.00 uur Brusselse tijd: ochtendoverzicht (één keer per dag).
//  4. Om 18.00 uur: herinnering voor de uitspraken van morgen.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { brusselsParts, isGeertHouben } from "../_shared/parser.js";
import {
  parseRss, processItems, statusUpdates, buildDigest, buildReminder, HBVL_RSS, GOOGLE_NEWS_RSS,
} from "../_shared/engine.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const MAIL_FROM = Deno.env.get("MAIL_FROM") || "Vonnisalert Limburg <onboarding@resend.dev>";
const MAIL_TO = Deno.env.get("GEERT_EMAIL") ?? "";
const MAIL_CC = Deno.env.get("MAIL_CC") ?? "";
const APP_URL = (Deno.env.get("APP_URL") || "https://vonnisalert-limburg.vercel.app").replace(/\/$/, "");
// Alleen voor lokale tests; in productie niet ingesteld.
const HBVL_URL = Deno.env.get("HBVL_RSS_URL") || HBVL_RSS;
const GOOGLE_URL = Deno.env.get("GOOGLE_NEWS_RSS_URL") || GOOGLE_NEWS_RSS;
const RESEND_URL = Deno.env.get("RESEND_API_URL") || "https://api.resend.com/emails";
const nowFn = () => (Deno.env.get("NOW_OVERRIDE") ? new Date(Deno.env.get("NOW_OVERRIDE")!) : new Date());
const UA = "VonnisalertLimburg/1.0 (RSS-lezer voor persoonlijk gebruik)";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function authorize(req: Request, db: SupabaseClient): Promise<"cron" | "user" | null> {
  const secret = req.headers.get("x-cron-secret");
  if (CRON_SECRET && secret && timingSafeEqual(secret, CRON_SECRET)) return "cron";
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: u } = await db.from("app_users").select("email").ilike("email", email).maybeSingle();
  return u ? "user" : null;
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function getState(db: SupabaseClient) {
  const { data, error } = await db.from("app_state").select("key,value");
  if (error) throw error;
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}
async function setState(db: SupabaseClient, key: string, value: unknown) {
  const { error } = await db.from("app_state").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return await res.text();
}

async function sendMail(subject: string, html: string, text: string) {
  if (!RESEND_API_KEY || !MAIL_TO) return { sent: false, reason: "Mail niet geconfigureerd (RESEND_API_KEY of GEERT_EMAIL ontbreekt)." };
  const to = [MAIL_TO, ...MAIL_CC.split(",").map((s) => s.trim()).filter(Boolean)];
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to, subject, html, text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${body.slice(0, 300)}`);
  return { sent: true, id: JSON.parse(body).id };
}

async function loadCases(db: SupabaseClient) {
  const { data, error } = await db.from("cases").select("*").eq("archived", false);
  if (error) throw error;
  return data || [];
}

async function applyChanges(db: SupabaseClient, r: { inserts?: any[]; updates?: any[]; events?: any[]; articles?: any[] }) {
  if (r.inserts?.length) {
    const rows = r.inserts.map(({ ...c }) => c);
    const { error } = await db.from("cases").upsert(rows, { onConflict: "id" });
    if (error) throw error;
  }
  for (const u of r.updates || []) {
    if (!Object.keys(u.patch).length) continue;
    const { error } = await db.from("cases").update(u.patch).eq("id", u.id);
    if (error) throw error;
  }
  if (r.events?.length) {
    const { error } = await db.from("case_events").insert(r.events);
    if (error) throw error;
  }
  if (r.articles?.length) {
    const { error } = await db.from("articles").upsert(r.articles, { onConflict: "article_id" });
    if (error) throw error;
  }
}

async function pollFeeds(db: SupabaseClient, now: Date, minute: number, force: boolean, onlyGeert: boolean) {
  const report: Record<string, unknown> = {};
  const items = [];
  try {
    items.push(...parseRss(await fetchText(HBVL_URL), "hbvl"));
    report.hbvl = items.length;
  } catch (e) { report.hbvl_error = errText(e); }
  // Google News (alleen titels, zonder auteur) één keer per uur – niet bij filter op Geert
  if (!onlyGeert && (force || minute < 15)) {
    try {
      const g = parseRss(await fetchText(GOOGLE_URL), "google");
      items.push(...g);
      report.google = g.length;
    } catch (e) { report.google_error = errText(e); }
  }
  if (onlyGeert) {
    const before = items.length;
    items.splice(0, items.length, ...items.filter((i) => isGeertHouben(i.author)));
    report.van_geert = `${items.length} van ${before}`;
  }
  if (!items.length) return report;

  const ids = items.map((i) => i.id);
  const { data: known } = await db.from("articles").select("article_id,updated_at_src").in("article_id", ids);
  const knownArticles = Object.fromEntries((known || []).map((k) => [k.article_id, { updated_at_src: k.updated_at_src ? new Date(k.updated_at_src).toISOString() : null }]));
  const cases = await loadCases(db);
  const r = processItems(items, { cases, knownArticles, now });
  await applyChanges(db, r);
  return { ...report, nieuwe_dossiers: r.inserts.length, bijgewerkt: r.updates.length, gerechtsartikels: r.articles.length };
}

async function run(db: SupabaseClient, opts: { force?: boolean; action?: string }) {
  const now = nowFn();
  const { date: today, hour, minute } = brusselsParts(now);
  const state = await getState(db);
  const report: Record<string, unknown> = { today, hour, minute };

  if (state.rss_enabled === true) report.feeds = await pollFeeds(db, now, minute, Boolean(opts.force), state.only_geert !== false);
  else report.feeds = "uitgeschakeld";

  const cases = await loadCases(db);
  const su = statusUpdates(cases, today);
  await applyChanges(db, su);
  report.statuswijzigingen = su.updates.length;

  const mailOn = state.mail_enabled !== false;
  if (hour >= 7 && state.last_digest_date !== today) {
    const fresh = await loadCases(db);
    const since = state.last_digest_at || new Date(now.getTime() - 86400000).toISOString();
    const { data: events } = await db.from("case_events").select("case_id,kind,at").gte("at", since);
    const d = buildDigest({ cases: fresh, events: events || [], today, since, appUrl: APP_URL });
    let mail: unknown = { sent: false, reason: "Mail uitgeschakeld in instellingen." };
    if (mailOn) mail = await sendMail(d.subject, d.html, d.text);
    await setState(db, "last_digest", { subject: d.subject, at: now.toISOString(), mail, counts: Object.fromEntries(Object.entries(d.sections).map(([k, v]) => [k, (v as unknown[]).length])) });
    await setState(db, "last_digest_date", today);
    await setState(db, "last_digest_at", now.toISOString());
    report.digest = { subject: d.subject, mail };
  }

  if (hour >= 18 && state.last_reminder_date !== today && state.reminder_enabled !== false) {
    const rem = buildReminder({ cases: await loadCases(db), today, appUrl: APP_URL });
    if (rem && mailOn) report.reminder = { subject: rem.subject, mail: await sendMail(rem.subject, rem.html, rem.text) };
    await setState(db, "last_reminder_date", today);
  }

  if (hour === 3 && minute < 15) await db.rpc("cleanup_old_logs");
  await setState(db, "last_run", { at: now.toISOString(), report });
  return report;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    return [o.message, o.code, o.details, o.hint].filter(Boolean).join(" | ") || JSON.stringify(e);
  }
  return String(e);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Alleen POST" }, 405);
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const who = await authorize(req, db);
  if (!who) return json({ error: "Niet toegelaten" }, 401);

  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* lege body */ }
  const action = body.action || "run";

  try {
    if (action === "preview") {
      const { date: today } = brusselsParts(nowFn());
      const state = await getState(db);
      const since = state.last_digest_at || new Date(Date.now() - 86400000).toISOString();
      const { data: events } = await db.from("case_events").select("case_id,kind,at").gte("at", since);
      return json(buildDigest({ cases: await loadCases(db), events: events || [], today, since, appUrl: APP_URL }));
    }
    if (action === "testmail") {
      const { date: today } = brusselsParts(nowFn());
      const d = buildDigest({ cases: await loadCases(db), events: [], today, since: new Date(Date.now() - 86400000).toISOString(), appUrl: APP_URL });
      const mail = await sendMail(`[TEST] ${d.subject}`, d.html, d.text);
      return json({ ok: true, mail });
    }
    const report = await run(db, { force: who === "user", action });
    await db.from("run_log").insert({ kind: who, ok: true, details: report });
    return json({ ok: true, report });
  } catch (e) {
    await db.from("run_log").insert({ kind: who, ok: false, details: { error: errText(e) } });
    return json({ ok: false, error: errText(e) }, 500);
  }
});
