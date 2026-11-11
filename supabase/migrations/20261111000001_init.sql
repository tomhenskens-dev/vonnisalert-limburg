-- Vonnisalert Limburg – databank
-- Eén gebruiker (Geert). Alle tabellen achter Row Level Security.
-- De geplande taak (Edge Function) werkt met de service_role-sleutel, die enkel
-- server-side bestaat en nooit in de frontend terechtkomt.

create extension if not exists pgcrypto;

-- Wie mag de app gebruiken (alleen via service_role te beheren)
create table if not exists public.app_users (
  email text primary key,
  created_at timestamptz not null default now()
);
alter table public.app_users enable row level security;
-- bewust geen policies: niet leesbaar of schrijfbaar vanuit de browser

create or replace function public.is_app_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_users u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_app_user() from public;
grant execute on function public.is_app_user() to authenticated;

-- Dossiers
create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 400),
  defendant text check (length(defendant) <= 120),
  author text check (length(author) <= 200),
  author_is_geert boolean,                -- null = niet gecontroleerd
  article_url text check (article_url is null or article_url ~* '^https?://'),
  article_id text,
  published_at timestamptz,
  hearing_date date,
  verdict_date date,
  verdict_date_text text,
  date_certainty text check (date_certainty in ('exact','afgeleid','onzeker','handmatig')),
  court text not null default 'Te controleren' check (court in ('Hasselt','Tongeren','Te controleren')),
  status text not null default 'check' check (status in ('aangekondigd','morgen','vandaag','bevestigd','uitgesteld','check')),
  status_manual boolean not null default false,  -- true = handmatig gezet, automatische regels blijven eraf
  needs_review boolean not null default true,
  review_reasons text[] not null default '{}',
  notes text check (length(notes) <= 5000),
  source text not null default 'manueel' check (source in ('rss','google','manueel','geplakt')),
  extra_links jsonb not null default '[]'::jsonb,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists cases_article_id_key on public.cases (article_id) where article_id is not null;
create index if not exists cases_verdict_date_idx on public.cases (verdict_date);
create index if not exists cases_status_idx on public.cases (status);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists cases_touch on public.cases;
create trigger cases_touch before update on public.cases
for each row execute function public.touch_updated_at();

-- Geschiedenis per dossier
create table if not exists public.case_events (
  id bigint generated always as identity primary key,
  case_id uuid not null references public.cases(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  message text not null
);
create index if not exists case_events_case_idx on public.case_events (case_id, at desc);

-- Gerechtsartikels uit de feeds (enkel artikels met een gerechtelijke context worden bewaard)
create table if not exists public.articles (
  article_id text primary key,
  source text not null,
  url text not null,
  title text not null,
  lead text,
  author text,
  category text,
  published_at timestamptz,
  updated_at_src timestamptz,
  premium boolean,
  court_related boolean not null default false,
  announcement boolean not null default false,
  analysis jsonb,
  case_id uuid references public.cases(id) on delete set null,
  dismissed boolean not null default false,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists articles_published_idx on public.articles (published_at desc);

-- Instellingen en status van de geplande taak
create table if not exists public.app_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.app_state (key, value) values
  ('rss_enabled', 'false'::jsonb),
  ('mail_enabled', 'true'::jsonb),
  ('reminder_enabled', 'true'::jsonb)
on conflict (key) do nothing;

create table if not exists public.run_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null,
  ok boolean not null,
  details jsonb
);
create index if not exists run_log_at_idx on public.run_log (at desc);

-- ---------- Row Level Security ----------
alter table public.cases enable row level security;
alter table public.case_events enable row level security;
alter table public.articles enable row level security;
alter table public.app_state enable row level security;
alter table public.run_log enable row level security;

drop policy if exists cases_all on public.cases;
create policy cases_all on public.cases for all to authenticated
  using (public.is_app_user()) with check (public.is_app_user());

drop policy if exists events_select on public.case_events;
create policy events_select on public.case_events for select to authenticated using (public.is_app_user());
drop policy if exists events_insert on public.case_events;
create policy events_insert on public.case_events for insert to authenticated with check (public.is_app_user());

drop policy if exists articles_select on public.articles;
create policy articles_select on public.articles for select to authenticated using (public.is_app_user());
drop policy if exists articles_update on public.articles;
create policy articles_update on public.articles for update to authenticated using (public.is_app_user()) with check (public.is_app_user());

drop policy if exists state_select on public.app_state;
create policy state_select on public.app_state for select to authenticated using (public.is_app_user());
-- Alleen de schakelaars mag Geert zelf aanpassen
drop policy if exists state_update on public.app_state;
create policy state_update on public.app_state for update to authenticated
  using (public.is_app_user() and key in ('rss_enabled','mail_enabled','reminder_enabled'))
  with check (public.is_app_user() and key in ('rss_enabled','mail_enabled','reminder_enabled'));

drop policy if exists runlog_select on public.run_log;
create policy runlog_select on public.run_log for select to authenticated using (public.is_app_user());

-- Anonieme bezoekers krijgen niets
revoke all on public.cases, public.case_events, public.articles, public.app_state, public.run_log, public.app_users from anon;
grant select, insert, update, delete on public.cases to authenticated;
grant select, insert on public.case_events to authenticated;
grant select, update on public.articles to authenticated;
grant select, update on public.app_state to authenticated;
grant select on public.run_log to authenticated;

-- Opruimen: run_log niet eindeloos laten groeien
create or replace function public.cleanup_old_logs()
returns void language sql security definer set search_path = public as $$
  delete from public.run_log where at < now() - interval '60 days';
  delete from public.articles where case_id is null and last_seen < now() - interval '120 days';
$$;
revoke all on function public.cleanup_old_logs() from public, anon, authenticated;
