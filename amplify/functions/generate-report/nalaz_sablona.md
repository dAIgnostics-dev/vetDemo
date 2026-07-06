<!--
  Šablona za generiranje veterinarsko-patološkog nalaza.
  Učitava je report_templates.py pri svakom zahtjevu za generiranje.

  U PROMPT se ubacuju samo blokovi omeđeni s <!-- INJECT:... --> ... <!-- /INJECT -->.
  Sve ostalo (npr. "## Referenca") je dokumentacija i NE ide u prompt — služi
  kao trajni izvor znanja i podloga za buduće doradenije groundanje.

  Izvor: ECVP / JPC (AFIP) deskriptivna tehnika —
  "Descriptive Techniques: Histology of Neoplasia" i
  "Descriptive Techniques: Histology of Non-Neoplastic Lesions",
  Paola Roccabianca (DIMEVET, Milano) & Barbara Banco (Lab. La Vallonea, Rho).
-->

# Šablona za generiranje veterinarsko-patološkog nalaza

Nalaz se piše prema ECVP deskriptivnoj tehnici: prvo se opisuje što se vidi,
zatim se to interpretira i sažima u morfološku dijagnozu. Biraj šablonu prema
naravi lezije — **tumor** (neoplazija) ili **ne-tumorska** (upalna/degenerativna)
lezija.

<!-- INJECT:COMMON -->
## Opća pravila pisanja

- Opis počinje frazom o uzorku: „Dostavljen je uzorak …", „Dostavljeni su razmasci …", „Dostavljeno tkivo čini …".
- Koristi standardnu veterinarsko-patološku terminologiju (anizokarioza, mitoze, infiltrativan rast, nekroza, upalni infiltrat, hiperplazija, metaplazija, pleomorfizam, desmoplazija …). Kad postoji ustaljen latinski/internacionalni naziv entiteta, preferiraj ga (npr. *Fibrosarcoma*, *Mastocytoma*, *Seminoma testis*).
- **Opisuj samo ono što ključne riječi podržavaju ili proizlazi iz uobičajenog kliničkog konteksta.** Elemente strukture bez podloge preskoči — ne nabrajaj prazne slotove.
- **Ne izmišljaj konkretne brojeve** (dimenzije u cm/μm, mitoze po HPF, postotke). Ako ključna riječ ne daje broj, koristi kvalitativan izraz: „povišen mitotski indeks", „umjerena staničnost", „djelomično zahvaćeno tkivo" — a ne izmišljenu brojku.
- Zadrži organ/sijelo dosljednim kroz cijeli opis i dijagnozu (organ iz opisa mora biti isti organ u Dg).
<!-- /INJECT -->

<!-- INJECT:TUMOR -->
## Šablona: TUMOR (neoplazija)

Opis slijedi ovaj redoslijed rečenica (izostavi ono za što nema podloge):

1. **Uzorak i subgross.** Dostavljeno tkivo/organ, anatomska lokacija, oblik, veličina, staničnost, koliki dio tkiva je zahvaćen (potiskuje / efacira), rast (ekspanzivan / infiltrativan / egzofitičan), ograničenost (dobro / loše ograničen), kapsula (inkapsuliran / neinkapsuliran), rubovi resekcije (doseže / ne doseže).
2. **Obrazac rasta i stroma.** Obrazac (kordoni, otoci, lobuli, papile, snopovi, vrtlozi, storiformno, gnijezda, ploče); količina i tip strome (fibrozna / fibrovaskularna / miksoidna; desmoplazija ako je uzrokovana tumorom).
3. **Citološke karakteristike.** Oblik stanica (okrugle / vretenaste / poligonalne), veličina, granice, citoplazma (količina, boja, sadržaj), jezgra (oblik, položaj, kromatin), nukleolus (broj, veličina); posebni termini entiteta ako je prepoznatljiv.
4. **Atipične značajke.** Pleomorfizam (anizocitoza, anizokarioza), maligne divovske stanice, višejezgrene stanice, apoptoze.
5. **Mitotska aktivnost.** Broj/raspon mitoza po HPF i morfologija (atipične mitoze) — samo ako je dano; inače kvalitativno.
6. **Znakovi malignosti.** Invazija kapsule, nekroza (opseg), vaskularni embolusi, krvarenje.
7. **Dodatni nalazi.** Upala, ulceracija, mineralizacija, druge lezije tkiva.

**Morfološka dijagnoza (Dg):** tkivo + naziv i tip tumora + malignost/stupanj.
Primjer: `Koža: dermalni melanocitom, vretenastostanični tip.`
<!-- /INJECT -->

<!-- INJECT:NON_TUMOR -->
## Šablona: NE-TUMOR (upalna / degenerativna lezija)

Opis slijedi ovaj redoslijed rečenica (izostavi ono za što nema podloge):

1. **Uzorak i subgross.** Specifično sijelo (mikroanatomska lokacija), opseg oštećenja (koliki dio; arhitektura očuvana / izgubljena), distribucija (fokalno / multifokalno / difuzno / lokalno ekstenzivno / transmuralno), tip procesa (upalni / degenerativni / nekrotizirajući / nešto nedostaje).
2. **Glavne promjene (komponente) — opiši i interpretiraj.**
   - *Dodano:* stroma/fibroza, pigmenti, poremećaji cirkulacije (edem, hiperemija, krvarenje, fibrin, tromb), nakupine tvari (npr. amiloid), upalne stanice — **nabroji i kvantificiraj po prevalenciji i lokaciji**.
   - *Promijenjeno:* degeneracija, nekroza, hipoplazija / displazija / metaplazija.
   - *Nedostaje:* koji mikroanatomski element izostaje.
3. **Etiološki agens (ako je prisutan).** Sijelo (intra/ekstracelularno), opis (veličina, oblik, broj, posebnosti), interpretacija; virusna inkluzijska tjelešca / citopatski efekt.
4. **Clean up.** Manje/dodatne lezije koje se ne smiju propustiti.

**Morfološka dijagnoza (Dg) — 5 komponenti:** organ/sijelo + težina (minimalna / blaga / umjerena / teška) + vremenski tijek (akutno / subakutno / kronično / kronično-aktivno) + distribucija + tip lezije (tip upale / degeneracije). Ako je poznat, dodaj etiološku dijagnozu / naziv bolesti.
Primjer: `Pluća: teški, akutni, difuzni, fibrinozni pneumonitis.`
<!-- /INJECT -->

---

## Referenca (dokumentacija — NE ulazi u prompt)

Detaljna podloga preuzeta iz ECVP dokumenata. Ovo je izvor znanja za buduće
dorade (npr. preciznije opise etioloških agensa); trenutno se ne ubacuje u prompt
da bi prompt ostao kratak.

### Oblik lezije → tip tumora (subgross)

| Oblik | Primjeri tumora |
|---|---|
| Kupolast | Histiocitom |
| Nodularan do difuzan | Plazmocitom, limfom |
| Multinodularan | Trihoepiteliom, kožna histiocitoza |
| Multilobuliran | Hemangiopericitom, bazocelularni tumor, trihoblastom |
| Multilokularan (cistični) | Hemangiom (kavernozni), apokrini cistadenom/karcinom |
| Verukozan | Fibropapilom, Bowenova bolest |

### Obrasci rasta

- **Epitelni:** kordoni, otoci, lobuli, papilarno/papilomatozno, „pockets" (Merkelov tumor), vrpce (trihoblastom).
- **Žljezdani:** acinusi, lobuli, papilarne resice (tumori znojnih žlijezda), tubuli.
- **Mezenhimski:** snopovi (interlacing/interwoven), struje (isti smjer), vrtlozi, storiformno, „herringbone".
- **Okruglostanični:** ploče (gusto, bez orijentacije, oskudna stroma), gnijezda (plazmocitom, melanom).

### Posebni termini po entitetu

| Entitet | Posebni termin |
|---|---|
| Tumori apokrinih žlijezda | Ceroidofagi |
| Epiteliotropni limfom | Pautrierovi mikroapscesi |
| Pilomatriksni tumori | „Ghost" (sjenaste) stanice |
| Planocelularni karcinom | Keratinske/rožnate perle, diskeratoza |
| Virusni papilomi | Koilociti, velike keratohijaline granule |
| Hordom | Fizaliferne stanice |
| Plazmocitom | Russellova tjelešca (Mottove stanice) |
| Rabdomiosarkom | „Strap" stanice |
| Švanom | Verocayeva tjelešca, Antoni A/B područja |

### Katalog etioloških agensa (nenneoplastične granulomatozne/piogranulomatozne lezije)

- **Histoplasma capsulatum:** u makrofazima; okrugle do ovalne, 2–5 μm, bazofilna jezgra, periferna svijetla zona, nejasna stijenka.
- **Cryptococcus neoformans:** izgled „mjehurića sapunice"; varijabilna veličina (4–20 μm), tanka (1 μm) eozinofilna stijenka, mukikarmin-pozitivna kapsula (nebojena u HE), usko pupanje.
- **Blastomyces dermatitidis:** slobodno ili u makrofazima; 7–20 μm, okrugle do ovalne, bazofilna jezgra, dvokonturna 1–2 μm stijenka, široko pupanje.
- **Sporothrix schenckii:** 2–6 μm, pleomorfne, cigaroliki oblik, usko pupanje.
- **Coccidioides immitis:** sferule 30–60 μm s debelom dvokonturnom stijenkom, ispunjene 2–5 μm endosporama.
- **Malassezia pachydermatis:** ovalne do „otisak stopala"/kikiriki (bilobirane), 3–4 μm; u stratum corneumu / lumenu folikula.
- **Leishmania sp.:** citoplazma makrofaga ispunjena ovalnim amastigotima 2–5 μm; svijetla vanjska stijenka, bazofilna jezgra i štapićasti kinetoplast okomit na jezgru.
- **Toxoplasma gondii:** srpasti tahizoiti 2–6 μm, slobodni ili u makrofazima; cisti s bradizoitima; boje se u HE; bez „haloa".
- **Neospora caninum:** u makrofazima/keratinocitima, srpasti tahizoiti 2×6 μm; cisti do 70 μm s debelom (3 μm) stijenkom.
- **Prototheca spp.:** sferične do ovoidne, 2–20 μm, refraktilna stijenka; „Mercedes-Benz" raspored endospora (morula).
- **Cryptosporidium spp.:** uz mikrovilarnu površinu, sitne (1–6 μm) bazofilne točke.

### Bodovanje (za orijentaciju o težini pojedinih dijelova)

Dizajn/stil 2, prepoznavanje tkiva 0–1, opis lezije do 16, morfološka dijagnoza 3–4, dodatna pitanja 1–2 (ukupno 20; prolaz 12). Najveća težina je na **opisu lezije** — otud važnost pune, uredne strukture.
