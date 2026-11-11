# Vonnisalert Limburg

Webapp voor Geert Houben om aangekondigde uitspraken van de Rechtbank Limburg (Hasselt en Tongeren) op te volgen.

## Hoe het werkt

| Onderdeel | Waar | Wat |
|---|---|---|
| Webapp | Vercel (`index.html`, `app.js`) | Dashboard, overzichten, zoeken, artikel plakken, dossiers bewerken. Werkt op gsm en computer, kan op het beginscherm gezet worden. |
| Databank | Supabase | Dossiers, geschiedenis, gerechtsartikels. Row Level Security: alleen Geerts account heeft toegang. |
| Geplande taak | Supabase Edge Function + pg_cron | Draait elke 15 minuten: feeds (als dat aan staat), statussen, ochtendmail om 07.00 uur en herinnering om 18.00 uur (Europe/Brussels, met zomer- en wintertijd). |
| Herkenning | `supabase/functions/_shared/parser.js` | Nederlandse taalregels: aankondiging in de toekomende tijd tegenover een verslag achteraf, datumberekening, rechtbank (nooit gegokt), beklaagde, uitstel. |
| Installatie | GitHub Actions (`.github/workflows/deploy.yml`) | Tests, databank, beveiliging, functie, planning, gebruiker en frontendconfiguratie. Draait bij elke push naar `main`. |

### HBVL-opvolging
- Bron: de publieke RSS-feed `hbvl.be/rss` (titel, intro, auteur, data; de laatste ~50 artikels) en Google News (alleen titels).
- **Standaard UIT.** HBVL maakt in zijn robots.txt een voorbehoud tegen automatische gegevensverzameling (art. 4 DSM-richtlijn). Zet de schakelaar in ⚙︎ Instellingen pas aan als daarvoor toestemming is.
- De volledige artikeltekst wordt nooit opgehaald. Staat de aankondiging pas verderop in het artikel? Plak de tekst dan via **＋ Dossier**.

### Regels
- Een uitspraak wordt nooit automatisch als *bevestigd* gemarkeerd.
- Is de verwachte datum voorbij zonder bevestiging, dan krijgt het dossier de status *Nog te controleren*.
- De rechtbank wordt alleen ingevuld als die uitdrukkelijk in een gerechtelijke context staat. Anders: *Te controleren*.
- Bij de auteur wordt bijgehouden of het effectief Geert Houben is.

## Artikel schrijven

Tabblad **✍︎ Artikel** maakt een prompt met Geerts stijlgids, de gekozen tekenlimiet (2.100 of 3.300 incl. spaties) en de dossiergegevens. Geert plakt die in zijn eigen Claude-account, met het vonnis als bijlage. De app roept zelf geen AI-dienst aan en bewaart geen bronteksten. Het resultaat terugplakken geeft een tekenteller en een inkort-opdracht. De stijlgids is aanpasbaar en wordt bewaard in `app_state.style_guide`.

## Eenmalige installatie (Tom)

Zet in GitHub → **Settings → Secrets and variables → Actions → New repository secret**:

| Naam | Waar te vinden |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com → avatar rechtsboven → Account preferences → **Access Tokens** → Generate new token |
| `SUPABASE_PROJECT_REF` | Supabase-project → Project Settings → General → **Project ID** (20 tekens) |
| `GEERT_EMAIL` | e-mailadres van Geert (om in te loggen en voor de mails) |
| `GEERT_PASSWORD` | een wachtwoord voor Geert, minstens 10 tekens |
| `RESEND_API_KEY` | resend.com → API Keys → Create (zie hieronder) |
| `MAIL_FROM` *(optioneel)* | bv. `Vonnisalert <vonnisalert@jouwdomein.be>` als je een domein in Resend verifieerde |
| `MAIL_CC` *(optioneel)* | extra ontvanger(s), komma-gescheiden |

Daarna: tabblad **Actions** → *Testen en Supabase installeren* → **Run workflow**.

**Mail via Resend:** zonder eigen domein kan Resend alleen mailen naar het e-mailadres waarmee het Resend-account is aangemaakt. Maak het account dus aan met Geerts adres, of verifieer een domein in Resend en vul `MAIL_FROM` in.

## Tests
```
node --test tests/*.test.mjs
```
