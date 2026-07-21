"""
Orkestrira tok: keywords → semantic router → (fallback) Sonnet → write-back u bazu.

Konfiguracija via env varijable:
  BAZA_S3_BUCKET  — S3 bucket (obavezno za Lambda; bez njega koristi lokalni fajl)
  BAZA_S3_KEY     — S3 ključ (default: semantic-router/baza.json)
  BEDROCK_REGION  — region za Bedrock (default: us-east-1)

Lambda entry point: orchestrator.lambda_handler
CLI korištenje:
  from orchestrator import Orchestrator
  orch = Orchestrator()
  result = orch.query(["neutrofilan", "infiltrat", "subkutis"])
"""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Optional

import boto3

from hybrid_router import (
    DEFAULT_BAZA,
    BEDROCK_REGION,
    S3_BUCKET,
    S3_KEY,
    HybridRetriever,
    build_hybrid,
    get_retriever,
)

SONNET_MODEL_ID = os.environ.get("SONNET_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")

# ---------- Klasifikacijski šifrarnik (JPC VSPO) ----------
_TAX_PATH = Path(__file__).parent / "taxonomy.json"
try:
    with _TAX_PATH.open(encoding="utf-8") as _f:
        TAXONOMY = json.load(_f)
except Exception as _e:  # pragma: no cover
    print(f"[orchestrator] Ne mogu učitati taxonomy.json: {_e}")
    TAXONOMY = {"system": [], "animal_group": [], "etiology": []}


def _tax_codes(kind: str) -> list[str]:
    return [x["code"] for x in TAXONOMY.get(kind, []) if isinstance(x, dict) and x.get("code")]


def _tax_label(kind: str, code: str, lang: str = "hr") -> str:
    """Vrati čitljivu oznaku (hr/en) za dani kod; fallback na sam kod."""
    if not code:
        return ""
    key = "en" if str(lang).lower().startswith("en") else "hr"
    for x in TAXONOMY.get(kind, []):
        if isinstance(x, dict) and x.get("code") == code:
            return x.get(key) or x.get("en") or code
    return code


def _normalize_klas(klas: Optional[dict]) -> dict:
    klas = klas or {}
    ag = klas.get("animal_group")
    sy = klas.get("system")
    et = klas.get("etiology")
    if isinstance(et, str):
        et = [e.strip() for e in et.split(",") if e.strip()]
    return {
        "animal_group": ag if ag else None,
        "system": sy if sy else None,
        "etiology": [str(e).strip() for e in (et or []) if str(e).strip()],
    }


def _strip_dg_suffix(opis: str) -> str:
    """Ukloni 'Dg.:...' s kraja opisa ako postoji (duplikat jer se dg prikazuje odvojeno)."""
    return re.split(r'\s*\n\s*\nDg\.', opis, flags=re.IGNORECASE)[0].strip()


def _flat_to_report(dg, opis: str, komentar: Optional[str] = None) -> dict:
    """Normaliziraj plosnati {dg, opis} (npr. iz baze) u rich schemu s jednom sekcijom."""
    return {
        "vrsta_nalaza": None,
        "zaglavlje": {},
        "klasifikacija": {"animal_group": None, "system": None, "etiology": []},
        "sekcije": [{"naslov": None, "opis": _strip_dg_suffix(opis or ""), "dg": dg}],
        "komentar": komentar,
    }


def _report_to_flat(report: dict) -> tuple[str, str]:
    """Spljošti rich nalaz u (dg, opis) za pohranu/indeksiranje u bazi (BM25 retriever)."""
    opis_parts: list[str] = []
    dg_parts: list[str] = []
    for sec in report.get("sekcije") or []:
        naslov = (sec.get("naslov") or "").strip()
        opis = (sec.get("opis") or "").strip()
        if opis:
            opis_parts.append(f"{naslov}: {opis}" if naslov else opis)
        dg = sec.get("dg")
        if isinstance(dg, list):
            dg_parts.extend(str(d).strip() for d in dg if str(d).strip())
        elif dg:
            dg_parts.append(str(dg).strip())
    return "; ".join(dg_parts), "\n\n".join(opis_parts)


SYSTEM_PROMPT = """\
Ti si veterinarski patolog koji piše profesionalne histopatološke i citološke nalaze.
Iz zadanih Case details i Keywords rekonstruiraj nalaz i vrati ISKLJUČIVO strogi JSON objekt.

STROGO PRAVILO IZLAZA:
- Vrati SAMO jedan JSON objekt. Bez markdowna, bez ``` ograda, bez ikakvog teksta izvan objekta.
- Shema:
  {
    "jezik": "hr" | "en",
    "vrsta_nalaza": "histopatologija" | "citologija",
    "zaglavlje": { "oznaka_uzorka": str?, "vrsta_uzorka": str?, "datum": str?, "doktor": str? },
    "sekcije": [ { "naslov": str?, "opis": str, "dg": str | [str, ...] } ],
    "komentar": str?
  }
- "sekcije" ima najmanje jedan element. Opcionalna polja koja nemaju vrijednost IZOSTAVI (ne šalji prazne stringove).
- Ne izmišljaj vrijednosti zaglavlja, veličine, broj mitoza ni postotke kojih nema u unosu.

ČINJENICE IZ UNOSA SU MJERODAVNE — bez obzira dolaze li iz "Zadane činjenice" (dropdown) ili su
spomenute u Case details / Keywords (slobodni tekst). Izvuci vrstu životinje, organski sustav i
etiologiju iz TEKSTA ako nisu eksplicitno zadane, i onda ih dosljedno provuci kroz cijeli nalaz:
- Vrsta životinje: spomeni je u uvodnoj rečenici opisa i uskladi "vrsta_uzorka" u zaglavlju
  (npr. "bioptat kože psa"). Nikad ne pretpostavljaj drugu vrstu od navedene.
- Organski sustav: sijelo/organ u opisu i dijagnozi moraju odgovarati tom sustavu.
- Popuni i top-level "klasifikacija" istim vrijednostima (kodovima) koje si upotrijebio u tekstu.
- Sve što je korisnik naveo u Case details preuzmi doslovno; ne mijenjaj ni ne izmišljaj te podatke.

JEZIK: Cijeli izlaz piši na jeziku "{jezik}" (hr = hrvatski, en = engleski).
Latinske/internacionalne nazive dijagnoza koristi gdje su ustaljeni (npr. Seminoma testis, Fibrosarcoma subcutis, Mastocytoma) i ostavi ih istima u oba jezika.

VRSTA NALAZA: sam odredi "vrsta_nalaza" iz konteksta i keywordsa. Pojmovi kao punktat, razmasci, aspirat, citološki, FNA => "citologija"; bioptat, ekscizija, tkivo, isječci, arhitektura tkiva => "histopatologija". Ako nije jasno, pretpostavi "histopatologija".

STRUKTURA POLJA "opis" (proza, 4–10 rečenica, jedan odlomak):
Za tumor (histopatologija) slijedi ovim redom, ispuštajući korake bez podatka:
1) subgross: sijelo, oblik, veličina, celularnost, % zahvaćenog tkiva, način rasta, ograničenost, inkapsulacija, odnos prema rubovima;
2) uzorak rasta i stroma;
3) citološke značajke (oblik, veličina, granice, citoplazma, jezgra, jezgrica);
4) posebne značajke entiteta ako postoje;
5) atipija (pleomorfizam, divovske/multinuklearne, apoptoze);
6) mitotska aktivnost (prosjek/raspon na 10 HPF, atipične mitoze);
7) dokazi malignosti (invazija kapsule, nekroza %, emboli, krvarenje);
8) dodatni nalazi (adneksalne/epidermalne promjene, upala, druga lezija).
Za ne-neoplastičnu leziju: 1) subgross (sijelo, opseg, distribucija, tip procesa); 2) glavne promjene OPISANE I INTERPRETIRANE (dodano/upala nabrojana po prevalenciji i lokaciji/nedostaje); 3) etiološki agens ako postoji; 4) sporedne lezije.
Za citologiju: dominantna stanična populacija, omjer populacija, pozadina, stanične značajke; bez tkivne arhitekture.
Uvodna fraza (hr): "Dostavljeni uzorak…" / "Dostavljeni razmasci punktata…"; (en): "The submitted specimen…" / "The submitted aspirate smears…".

POLJE "dg" (morfološka dijagnoza, jedna rečenica završava točkom):
- Tumor: tkivo + naziv/tip tumora + malignost/gradus kad je primjenjivo.
- Ne-neoplastično: organ + težina + trajanje + distribucija + tip lezije.
- Više zasebnih entiteta u istoj sekciji => "dg" je niz stringova (bez vlastitih brojeva; frontend numerira).

SEKCIJE:
- Jedan uzorak/tvorba => jedna sekcija, "naslov" izostavljen.
- Više organa/uzoraka (npr. Želudac, Tanko crijevo) => više sekcija, svaka s "naslov".

"komentar" (opcionalno, 1–4 rečenice): diferencijalna dijagnoza, ograničenja uzorka, preporuke, klinička korelacija.

PRIMJER 1 (izlaz):
{"jezik":"hr","vrsta_nalaza":"histopatologija","zaglavlje":{"oznaka_uzorka":"HP 1005/13","vrsta_uzorka":"bioptat kože","datum":"12.03.2013."},"sekcije":[{"naslov":"Koža","opis":"Dostavljeni uzorak kože zahvaćen je dermalnom, ekspanzivnom, dobro ograničenom neinkapsuliranom tvorbom koja zauzima približno 70% dermisa u presjeku i ne dopire do rubova ekscizije. Tumor je građen od gusto zbijenih isprepletenih snopova i virova vretenastih stanica uloženih u oskudnu fibroznu stromu. Stanice su vretenaste, nejasnih granica, s umjerenom količinom svijetle citoplazme te ovalnom do nepravilnom jezgrom i jednom do dvije jezgrice. Prisutan je blag pleomorfizam, a mitoze variraju od 0 do 1 na 10 HPF. Ne uočavaju se nekroza niti vaskularni emboli.","dg":"Fibrosarcoma subcutis, stupanj malignosti II."}],"komentar":"Preporučamo provjeru potpunosti ekscizije i kliničko praćenje."}

PRIMJER 2 (izlaz, po organima + numerirana dg + engleski):
{"jezik":"en","vrsta_nalaza":"histopatologija","zaglavlje":{"vrsta_uzorka":"gastrointestinal biopsies"},"klasifikacija":{"animal_group":"CANINE","system":"DIGESTIVE","etiology":[]},"sekcije":[{"naslov":"Stomach","opis":"Sections of gastric mucosa show a locally extensive, moderate infiltrate expanding the lamina propria and separating the glands, composed predominantly of small mature lymphocytes and plasma cells with fewer neutrophils. The superficial mucosa shows glandular atrophy with reduced gland density and mild fibrosis of the lamina propria.","dg":["Chronic lymphoplasmacytic gastritis, moderate, diffuse","Mucosal atrophy, moderate"]},{"naslov":"Small intestine","opis":"Sections of duodenum show villous blunting and fusion with a moderate, diffuse lymphoplasmacytic infiltrate expanding the lamina propria between the crypts. Crypts are mildly hyperplastic and the surface epithelium is preserved.","dg":"Chronic lymphoplasmacytic duodenitis, moderate, diffuse."}],"komentar":"The changes are consistent with canine chronic inflammatory bowel disease (IBD). Clinical correlation and, if indicated, follow-up biopsies are recommended."}
"""

# Dodatak prompta: klasifikacijski šifrarnik (JPC VSPO). Model dodaje top-level "klasifikacija".
_TAX_BLOCK = (
    "\nKLASIFIKACIJA — dodaj u izlaz kao top-level polje "
    '"klasifikacija": {"animal_group": <code|null>, "system": <code|null>, "etiology": [<code>, ...]}.\n'
    "Koristi TOČNO ove kodove (velika slova, bez prijevoda):\n"
    f"- animal_group (jedan ili null): {', '.join(_tax_codes('animal_group'))}\n"
    f"- system (jedan ili null): {', '.join(_tax_codes('system'))}\n"
    f"- etiology (nula ili više): {', '.join(_tax_codes('etiology'))}\n"
    "Zaključi vrijednosti iz keywordsa i Case detailsa. Ako nema dovoljno podataka, stavi null "
    "(odnosno [] za etiology) — ne izmišljaj. Ako je u unosu naveden 'Klasifikacija override' za neko "
    "polje, upotrijebi TOČNO tu vrijednost umjesto vlastite procjene.\n"
)

SYSTEM_PROMPT = SYSTEM_PROMPT + _TAX_BLOCK


class Orchestrator:
    def __init__(self, local_path: Optional[Path] = None):
        self.local_path = local_path or DEFAULT_BAZA
        self.retriever: HybridRetriever = build_hybrid(self.local_path)
        self.bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)

    def search(self, keywords: list[str], k: int = 5) -> dict:
        """
        Pretraži samo bazu (bez Sonnet fallbacka).

        Returns:
            {
                "source":  "router" | "none",
                "results": [<rich report>, ...]   # normalizirani plosnati unosi iz baze
            }
        """
        query_text = ", ".join(kw.strip() for kw in keywords if kw.strip())
        matches = self.retriever.query(query_text, k=k)
        if matches:
            return {
                "source": "router",
                "results": [_flat_to_report(m["dg"], m["opis"] or "") for m in matches],
            }
        print("[orchestrator] Router nije pronašao podudaranje — search_only mod, nema fallbacka.")
        return {"source": "none", "results": []}

    def query(self, keywords: list[str], details: str = "", lang: str = "hr", klas: Optional[dict] = None) -> dict:
        """
        Generiraj nalaz direktno putem modela (bez pretraživanja baze).

        Returns:
            {
                "source":  "sonnet",
                "results": [<rich report>]
            }
        """
        print("[orchestrator] Generiram nalaz putem modela...")
        klas = _normalize_klas(klas)
        report = self._call_sonnet(keywords, details=details, lang=lang, klas=klas)

        # Override pobjeđuje: ono što je doktor eksplicitno odabrao ima prednost pred procjenom modela.
        k = report.setdefault("klasifikacija", {"animal_group": None, "system": None, "etiology": []})
        if klas.get("animal_group"):
            k["animal_group"] = klas["animal_group"]
        if klas.get("system"):
            k["system"] = klas["system"]
        if klas.get("etiology"):
            k["etiology"] = klas["etiology"]

        new_entry = self._write_back(keywords, report)
        self.retriever.add_entry(new_entry)
        print(f"[orchestrator] Novi unos zapisan u bazu: id={new_entry['id']}")

        return {"source": "sonnet", "results": [report]}

    def _call_sonnet(self, keywords: list[str], details: str = "", lang: str = "hr", klas: Optional[dict] = None) -> dict:
        kw_str = ", ".join(kw.strip() for kw in keywords if kw.strip())
        lang = "en" if str(lang).lower().startswith("en") else "hr"
        system_prompt = SYSTEM_PROMPT.replace("{jezik}", lang)

        klas = _normalize_klas(klas)
        override_parts = []
        override_facts = []
        if klas.get("animal_group"):
            override_parts.append(f"animal_group={klas['animal_group']}")
            override_facts.append(f"vrsta životinje: {_tax_label('animal_group', klas['animal_group'], lang)}")
        if klas.get("system"):
            override_parts.append(f"system={klas['system']}")
            override_facts.append(f"organski sustav: {_tax_label('system', klas['system'], lang)}")
        if klas.get("etiology"):
            override_parts.append(f"etiology={','.join(klas['etiology'])}")
            override_facts.append(
                "etiologija: " + ", ".join(_tax_label('etiology', c, lang) for c in klas['etiology'])
            )
        override_str = "; ".join(override_parts) if override_parts else "(nema)"
        facts_str = "; ".join(override_facts) if override_facts else "(nema)"

        prompt_text = (
            f"jezik: {lang}\n"
            f"Case details: {details.strip()}\n"
            f"Keywords: {kw_str}\n"
            f"Klasifikacija override: {override_str}\n"
            f"Zadane činjenice (POŠTUJ ih doslovno, nemoj ih izmišljati ni proturječiti im): {facts_str}\n\n"
            "Vrati SAMO JSON objekt prema shemi."
        )

        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1500,
            "system": [
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            "messages": [{"role": "user", "content": prompt_text}],
        })

        resp = self.bedrock.invoke_model(
            modelId=SONNET_MODEL_ID,
            body=body,
            contentType="application/json",
            accept="application/json",
        )
        text = json.loads(resp["body"].read())["content"][0]["text"].strip()
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise ValueError(f"Model nije vratio valjan JSON: {text[:200]}")
        parsed = json.loads(match.group())
        return self._normalize_report(parsed, lang)

    @staticmethod
    def _normalize_report(parsed: dict, lang: str) -> dict:
        """Osiguraj da rich nalaz ima očekivana polja; podrži i stari {opis, dg} oblik."""
        if "sekcije" not in parsed and ("opis" in parsed or "dg" in parsed):
            return _flat_to_report(parsed.get("dg", ""), parsed.get("opis", ""), parsed.get("komentar"))

        sekcije = parsed.get("sekcije") or []
        norm_sekcije = []
        for sec in sekcije:
            norm_sekcije.append({
                "naslov": sec.get("naslov"),
                "opis": sec.get("opis", ""),
                "dg": sec.get("dg", ""),
            })
        if not norm_sekcije:
            norm_sekcije = [{"naslov": None, "opis": "", "dg": ""}]

        return {
            "jezik": parsed.get("jezik", lang),
            "vrsta_nalaza": parsed.get("vrsta_nalaza"),
            "zaglavlje": parsed.get("zaglavlje") or {},
            "klasifikacija": _normalize_klas(parsed.get("klasifikacija")),
            "sekcije": norm_sekcije,
            "komentar": parsed.get("komentar"),
        }

    def _write_back(self, keywords: list[str], report: dict) -> dict:
        dg, opis = _report_to_flat(report)
        new_entry = {
            "id": f"gen_{uuid.uuid4().hex[:8]}",
            "keywords": ", ".join(kw.strip() for kw in keywords if kw.strip()),
            "dg": dg,
            "opis": opis,
        }

        if S3_BUCKET:
            self._write_back_s3(new_entry)
        else:
            self._write_back_local(new_entry)

        return new_entry

    def _write_back_s3(self, new_entry: dict) -> None:
        s3 = boto3.client("s3")
        obj = s3.get_object(Bucket=S3_BUCKET, Key=S3_KEY)
        entries = json.loads(obj["Body"].read().decode("utf-8"))
        entries.append(new_entry)
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=S3_KEY,
            Body=json.dumps(entries, ensure_ascii=False, indent=2).encode("utf-8"),
            ContentType="application/json",
        )
        print(f"[orchestrator] Zapisano u S3: s3://{S3_BUCKET}/{S3_KEY}")

    def _write_back_local(self, new_entry: dict) -> None:
        # Lambda code dir je read-only; koristimo /tmp/ za pisanje
        tmp_path = Path("/tmp/baza.json")
        source = tmp_path if tmp_path.exists() else self.local_path
        with source.open(encoding="utf-8") as f:
            entries = json.load(f)
        entries.append(new_entry)
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False, indent=2)
        print(f"[orchestrator] Zapisano u /tmp/baza.json ({len(entries)} unosa)")


# ---------- Lambda globalni cache ----------

_orchestrator: Optional[Orchestrator] = None


def _get_orchestrator() -> Orchestrator:
    """Vrati cached Orchestrator — inicijalizira se samo na cold startu."""
    global _orchestrator
    if _orchestrator is None:
        # Preferiramo /tmp/baza.json ako postoji (nakupljeni unosi s prethodnih warm invokacija)
        tmp_path = Path("/tmp/baza.json")
        local_path = tmp_path if tmp_path.exists() else DEFAULT_BAZA
        _orchestrator = Orchestrator(local_path=local_path)
    return _orchestrator


# ---------- Lambda entry point ----------

def lambda_handler(event, context):
    """
    AWS Lambda entry point — kompatibilan s postojećim AppSync/Amplify setupom.

    Ulaz (AppSync mutation):  event.arguments = { keywords: [...], details?: str, lang?: str, action?: str }
    Izlaz: JSON string { "source": "router"|"sonnet"|"none", "results": [<rich report>, ...] }
    """
    args: dict = {}
    if "arguments" in event:
        args = event["arguments"] or {}
    elif "body" in event:
        body = event["body"]
        if isinstance(body, str):
            body = json.loads(body)
        args = body or {}
    else:
        args = event

    keywords: list[str] = args.get("keywords") or []
    details: str = args.get("details") or ""
    lang: str = args.get("lang") or "hr"
    klas = {
        "animal_group": args.get("animalGroup") or "",
        "system": args.get("system") or "",
        "etiology": args.get("etiology") or "",
    }

    action = args.get("action") or event.get("info", {}).get("fieldName", "")

    if action == "search" or action == "searchDatabase":
        result = _get_orchestrator().search(keywords)
    else:
        result = _get_orchestrator().query(keywords, details=details, lang=lang, klas=klas)

    return json.dumps(result, ensure_ascii=False)
