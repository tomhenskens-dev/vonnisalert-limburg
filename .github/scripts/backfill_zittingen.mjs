// Eenmalige/idempotente inhaalslag: bestaande gerechtsartikels (zonder dossier, nog niet ingedeeld)
// indelen als zitting / uitspraak / gerecht / ander. Zittingsverslagen van gevolgde journalisten
// krijgen een dossier zonder datum (vangnet). Draait in deploy.yml.
import { classifyCourtArticle, analyzeArticle, followedAuthor } from "../../supabase/functions/_shared/parser.js";

const REF = (process.env.REF || "").trim();
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
async function q(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`SQL-fout ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
const lit = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);

const st = await q("select value from public.app_state where key = 'followed_authors'");
const authors = st[0]?.value || [{ name: "Geert Houben" }];
const arts = await q("select article_id, source, url, title, lead, author, published_at from public.articles where case_id is null and not dismissed and coalesce(analysis->>'kind','') = ''");
const sql = [];
let made = 0;
for (const a of arts) {
  const kind = classifyCourtArticle(a.title, a.lead || "");
  sql.push(`update public.articles set analysis = coalesce(analysis,'{}'::jsonb) || jsonb_build_object('kind', ${lit(kind)}) where article_id = ${lit(a.article_id)};`);
  if (kind !== "zitting" || !followedAuthor(a.author, authors)) continue;
  const an = analyzeArticle({ title: a.title, text: a.lead || "", publishedAt: a.published_at, author: a.author });
  const reasons = ["Uitspraakdatum nog invullen: open het artikel en zoek onderaan “Vonnis op …”."];
  if (an.court === "Te controleren") reasons.push("Rechtbanklocatie niet uitdrukkelijk vermeld.");
  sql.push(`with c as (insert into public.cases (title, defendant, author, author_is_geert, article_url, article_id, published_at, court, status, needs_review, review_reasons, notes, source)
    select ${lit(a.title.slice(0, 400))}, ${lit(an.defendant)}, ${lit(a.author)}, true, ${lit(a.url)}, ${lit(a.article_id)}, ${lit(a.published_at)}, ${lit(an.court)}, 'check', true,
      array[${reasons.map(lit).join(",")}]::text[], 'Zittingsverslag: het vonnis volgt nog. De datum staat meestal onderaan het artikel (“Vonnis op …”).', ${lit(a.source === "hln" ? "hln" : "rss")}
    where not exists (select 1 from public.cases where article_id = ${lit(a.article_id)}) returning id),
  l as (update public.articles set case_id = (select id from c) where article_id = ${lit(a.article_id)} and exists (select 1 from c))
  insert into public.case_events (case_id, kind, message) select id, 'aangemaakt', 'Automatisch aangemaakt als zittingsverslag (inhaalslag, vonnisdatum nog onbekend).' from c;`);
  made++;
}
if (sql.length) await q(sql.join("\n"));
console.log(`Inhaalslag: ${arts.length} artikels ingedeeld, ${made} zittingsdossiers aangemaakt.`);
