-- Agenda van terugkerende evenementen om op te volgen voor verslaggeving
create table if not exists public.agenda_events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 200),
  place text check (length(place) <= 120),
  start_date date,
  end_date date,
  status text not null default 'voorspelling'
    check (status in ('bevestigd','te_bevestigen','voorspelling','eenmalig')),
  basis text check (length(basis) <= 1000),      -- waarop de datum gebaseerd is
  source_url text check (source_url is null or source_url ~* '^https?://'),
  previous text check (length(previous) <= 200),  -- datum vorige editie
  notes text check (length(notes) <= 3000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index if not exists agenda_events_start_idx on public.agenda_events (start_date);
drop trigger if exists agenda_touch on public.agenda_events;
create trigger agenda_touch before update on public.agenda_events
for each row execute function public.touch_updated_at();

alter table public.agenda_events enable row level security;
drop policy if exists agenda_all on public.agenda_events;
create policy agenda_all on public.agenda_events for all to authenticated
  using (public.is_app_user()) with check (public.is_app_user());
revoke all on public.agenda_events from anon;
grant select, insert, update, delete on public.agenda_events to authenticated;
grant all on public.agenda_events to service_role;

-- Startlijst oktober 2027 (opgezocht op 11/11/2026). Alleen invoegen als de agenda nog leeg is.
insert into public.agenda_events (title, place, start_date, end_date, status, basis, source_url, previous)
select * from (values
  ('Weekend van de Klant', 'Vlaanderen', date '2027-10-02', date '2027-10-03', 'te_bevestigen',
   'Wordt sinds 2017 telkens het eerste weekend van oktober georganiseerd (UNIZO, Comeos, UCM). Een lokale UNIZO-afdeling (Tielt) plant al een activiteit op 2–3 oktober 2027; nationale bevestiging nog af te wachten.',
   'https://www.unizo.be/node/165580', '3–4 oktober 2026'),
  ('Werelddierendag', null, date '2027-10-04', null, 'bevestigd',
   'Vaste datum: elk jaar op 4 oktober.', null, '4 oktober 2026'),
  ('Student Take Off', 'Hasselt, Kolonel Dusartplein', date '2027-10-06', null, 'voorspelling',
   'Traditie: het academiejaar wordt elk jaar de eerste woensdag van oktober afgetrapt met Student Take-Off (stad Hasselt en hogescholen).',
   'https://api-portal-mgmt.uhasselt.be/media/dttpbx4x/jaarverslag-student-startup-2022.pdf', '7 oktober 2026'),
  ('Musical MIJN Leven', 'Beringen, Mijnkathedraal', null, null, 'eenmalig',
   'Eerste productie van AMUSE vzw, gemaakt om het 5-jarig bestaan te vieren. Geen herneming in 2027 bekend.',
   'https://www.vrt.be/vrtnws/nl/2026/03/29/musical-mijn-leven-over-het-mijnverleden-van-beringen-voorgestel/', '8–18 oktober 2026'),
  ('Wielrennen – Ronde van Lombardije', 'Italië (Como)', date '2027-10-09', null, 'bevestigd',
   'Staat op de officiële UCI WorldTour-kalender 2027 op zaterdag 9 oktober.',
   'https://www.cyclingnews.com/pro-cycling/racing/uci-reveals-2027-worldtour-racing-calendars-with-super-world-championships-in-france-forcing-changes/', '10 oktober 2026'),
  ('Antiek- en brocantemarkt', 'Hasselt', date '2027-10-09', null, 'voorspelling',
   'Geen datum 2027 gevonden. Voorspelling op basis van dezelfde weekdag als 2026 (tweede zaterdag van oktober).', null, '10 oktober 2026'),
  ('Dwars door Hasselt', 'Hasselt, Kolonel Dusartplein', date '2027-10-10', null, 'voorspelling',
   'Stadsloop (Golazo) op een zondag begin oktober: 6 oktober 2024, 11 oktober 2026. Datum 2027 nog niet aangekondigd.',
   'https://gotrail.run/nl/race/dwars-door-hasselt', '11 oktober 2026'),
  ('Theater in de stad', 'Sint-Truiden', date '2027-10-15', date '2027-10-16', 'voorspelling',
   'Zelfde weekend als 2026 (vrijdag–zaterdag midden oktober). Nog niet aangekondigd.', null, '16–17 oktober 2026'),
  ('De Hasseltse Jeneverfeesten', 'Hasselt, binnenstad', date '2027-10-16', date '2027-10-17', 'voorspelling',
   'Traditie: elk jaar het derde weekend van oktober.',
   'https://www.brusselstimes.com/magazine/1713169/weekend-break-sass-in-hasselt', '17–18 oktober 2026'),
  ('Chrysantenfestival Japanse Tuin', 'Hasselt, Japanse Tuin', date '2027-10-16', date '2027-10-24', 'voorspelling',
   'Opent traditioneel samen met het Jeneverfeestenweekend (2025 en 2026). Nog niet aangekondigd.',
   'https://www.vrt.be/vrtnws/nl/2025/10/18/chrysantenfestival-in-japanse-tuin-hasselt-in-het-teken-van-verg/', '17–25 oktober 2026'),
  ('Kerkenloop', 'Kortessem, Sportpark De Weyer', date '2027-10-17', null, 'voorspelling',
   'Loopwedstrijd op een zondag half oktober (18 oktober 2026). Datum 2027 nog niet aangekondigd.',
   'https://haid.app/en/events/kerkenloop-kortessem-mq965lmh', '18 oktober 2026'),
  ('64ste verjaardag Prins Laurent', null, date '2027-10-19', null, 'bevestigd',
   'Geboren op 19 oktober 1963.', null, '19 oktober 2026 (63ste)'),
  ('Dag tegen Kanker', 'Vlaanderen', date '2027-10-21', null, 'voorspelling',
   'Actiedag van Kom op tegen Kanker, meestal op donderdag in week 42 (15/10/2020, 19/10/2023, 15/10/2026). Nog niet aangekondigd.',
   'https://www.vrt.be/nl/over-ons/nieuws-over-vrt/radio-2-dansathon-peter-van-de-veire-danst-opnieuw-24-uur-tegen-kanker', '15 oktober 2026'),
  ('Dag van de Jeugdbeweging', 'Vlaanderen en Brussel', date '2027-10-22', null, 'voorspelling',
   'Altijd op een vrijdag in de tweede helft van oktober (22/10/2021, 18/10/2024, 17/10/2025, 23/10/2026). Nog niet aangekondigd.',
   'https://www.dagvandejeugdbeweging.be', '23 oktober 2026'),
  ('Bloemenofferceremonie', 'Hasselt, Japanse Tuin', date '2027-10-24', null, 'voorspelling',
   'Slotdag van het Chrysantenfestival (zondag). Nog niet aangekondigd.', null, '25 oktober 2026'),
  ('26ste verjaardag Prinses Elisabeth', null, date '2027-10-25', null, 'bevestigd',
   'Geboren op 25 oktober 2001.', null, '25 oktober 2026 (25ste)'),
  ('Griezelzwemmen', 'Hasselt, zwembad Kapermolen', date '2027-10-30', null, 'voorspelling',
   'Halloweenactiviteit; Halloween valt in 2027 op zondag. Datum nog niet aangekondigd.', null, '31 oktober 2026'),
  ('Start wintertijd (klok uur terug)', null, date '2027-10-31', null, 'bevestigd',
   'EU-regel: de wintertijd start op de laatste zondag van oktober.', null, '25 oktober 2026'),
  ('Halloween', null, date '2027-10-31', null, 'bevestigd',
   'Vaste datum: 31 oktober.', null, '31 oktober 2026')
) as v(title, place, start_date, end_date, status, basis, source_url, previous)
where not exists (select 1 from public.agenda_events);
