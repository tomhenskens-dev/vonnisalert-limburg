VONNISALERT LIMBURG – VERCEL-READY PROTOTYPE

Inhoud:
- index.html: de huidige interactieve demo
- manifest.webmanifest en iconen: basis voor toevoegen aan beginscherm
- sw.js: eenvoudige cache voor het openen van de demo bij een wegvallende verbinding

Deploy via Vercel:
1. Maak op GitHub een nieuwe repository, bijvoorbeeld "vonnisalert-limburg".
2. Upload alle bestanden uit deze map naar de hoofdmap van de repository.
3. Ga naar https://vercel.com/new en importeer die GitHub-repository.
4. Kies bij Framework Preset: Other.
5. Laat Build Command en Output Directory leeg (of gebruik "." als Vercel erom vraagt).
6. Klik Deploy.

Na de deploy krijg je een publieke URL. Open die op een iPhone in Safari en kies Deel > Zet op beginscherm.

Belangrijke beperkingen van deze demo:
- Dossiers worden nog lokaal in de browser opgeslagen (localStorage).
- Er is nog geen login, centrale database, automatische HBVL-import of geplande melding om 07.00 uur.
- De service worker cachet alleen de statische demo; hij synchroniseert geen dossiers tussen apparaten.
- Gebruik voor de volgende fase een centrale database en een server-side geplande taak. Deel geen HBVL-inloggegevens in de app of repository.
