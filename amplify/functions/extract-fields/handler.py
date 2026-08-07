"""
Inkrementalna ekstrakcija polja obrasca iz diktiranog transkripta.

Zove se dok doktor jos govori — svaki put s cijelim dosadasnjim transkriptom,
i vraca trenutno najbolju procjenu svih polja. Doktor to vidi i ispravlja prije
nego klikne "Generiraj", pa je ovdje Haiku prikladan izbor: greska je vidljiva
i jeftina, za razliku od finalnog nalaza koji ide na Sonnet.

Ulaz (AppSync):  event.arguments = { transcript: str, lang?: str }
Izlaz: JSON string { details, keywords[], zaglavlje{}, klasifikacija{} }
"""
import json
import os
import re
from pathlib import Path

import boto3

BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "eu-north-1")
# Haiku: ekstrakcija je low-risk korak koji doktor pregledava prije generiranja.
EXTRACT_MODEL_ID = os.environ.get("EXTRACT_MODEL_ID", "eu.anthropic.claude-haiku-4-5-20251001-v1:0")

_TAX_PATH = Path(__file__).parent / "taxonomy.json"
with _TAX_PATH.open(encoding="utf-8") as _f:
    TAXONOMY = json.load(_f)

_bedrock = None


def _client():
    global _bedrock
    if _bedrock is None:
        _bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)
    return _bedrock


def _codes(kind: str) -> list[str]:
    return [item["code"] for item in TAXONOMY.get(kind, [])]


def _labels(kind: str, lang: str) -> str:
    key = "en" if str(lang).lower().startswith("en") else "hr"
    return ", ".join(f"{i['code']} ({i.get(key, i['code'])})" for i in TAXONOMY.get(kind, []))


def _system_prompt(lang: str) -> str:
    return f"""Ti si asistent za veterinarsku patologiju. Iz sirovog transkripta diktata
izvlacis polja obrasca. Diktat je nastao govornim prepoznavanjem i moze sadrzavati
greske, postapalice i nedovrsene recenice.

VAZNO — brojevi: hrvatski ASR ne normalizira brojeve, pa ih dobivas ispisane
rijecima. Pretvori ih u znamenke: "sedamdeset posto" -> "70%", "deset H P F" -> "10 HPF",
"dvanaesti treci dvijetisucetrinaeste" -> "12.03.2013.", "stupanj dva" -> "II".

Vrati SAMO JSON objekt, bez ikakvog teksta oko njega, prema shemi:
{{
  "details": "ocisceni, profesionalno sroceni opis slucaja",
  "keywords": ["kljucna rijec", ...],
  "zaglavlje": {{"oznaka_uzorka": "", "vrsta_uzorka": "", "datum": ""}},
  "klasifikacija": {{"animal_group": null, "system": null, "etiology": []}}
}}

Pravila:
- "details": ocisti postapalice i ponavljanja, zadrzi SVE klinicke informacije.
  Nemoj dodavati nalaze koje doktor nije izrekao.
- "keywords": kratki klinicki pojmovi iz diktata, bez duplikata.
- "zaglavlje": popuni samo ono sto je izreceno; ostalo ostavi kao "".
- "klasifikacija.animal_group": tocno jedan kod ili null. Dopusteni: {_labels('animal_group', lang)}
- "klasifikacija.system": tocno jedan kod ili null. Dopusteni: {_labels('system', lang)}
- "klasifikacija.etiology": lista kodova (moze prazna). Dopusteni: {_labels('etiology', lang)}
- Ako necega nema u diktatu, ostavi prazno/null. NEMOJ nagadjati.
- Cijeli tekstualni izlaz na jeziku "{lang}"."""


def _coerce(parsed: dict, lang: str) -> dict:
    """Odbaci sve sto model vrati izvan sifrarnika — obrazac prima samo validne kodove."""
    klas = parsed.get("klasifikacija") or {}

    ag = klas.get("animal_group")
    ag = ag if ag in _codes("animal_group") else None

    sysc = klas.get("system")
    sysc = sysc if sysc in _codes("system") else None

    allowed_et = set(_codes("etiology"))
    et_raw = klas.get("etiology") or []
    if isinstance(et_raw, str):
        et_raw = [et_raw]
    et = [c for c in et_raw if c in allowed_et]

    zag = parsed.get("zaglavlje") or {}
    kws = parsed.get("keywords") or []
    if isinstance(kws, str):
        kws = [k.strip() for k in kws.split(",")]

    # Zadrzi redoslijed, makni duplikate bez obzira na velika/mala slova
    seen, keywords = set(), []
    for k in kws:
        k = str(k).strip()
        if k and k.lower() not in seen:
            seen.add(k.lower())
            keywords.append(k)

    return {
        "details": str(parsed.get("details") or "").strip(),
        "keywords": keywords,
        "zaglavlje": {
            "oznaka_uzorka": str(zag.get("oznaka_uzorka") or "").strip(),
            "vrsta_uzorka": str(zag.get("vrsta_uzorka") or "").strip(),
            "datum": str(zag.get("datum") or "").strip(),
        },
        "klasifikacija": {"animal_group": ag, "system": sysc, "etiology": et},
        "lang": lang,
    }


def _empty(lang: str) -> dict:
    return {
        "details": "",
        "keywords": [],
        "zaglavlje": {"oznaka_uzorka": "", "vrsta_uzorka": "", "datum": ""},
        "klasifikacija": {"animal_group": None, "system": None, "etiology": []},
        "lang": lang,
    }


def extract(transcript: str, lang: str = "hr") -> dict:
    lang = "en" if str(lang).lower().startswith("en") else "hr"
    transcript = (transcript or "").strip()
    if not transcript:
        return _empty(lang)

    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1200,
        "system": _system_prompt(lang),
        "messages": [{"role": "user", "content": f"Transkript diktata:\n\n{transcript}"}],
    })

    resp = _client().invoke_model(
        modelId=EXTRACT_MODEL_ID,
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    payload = json.loads(resp["body"].read())
    u = payload.get("usage", {})
    print(f"[extract] usage: in={u.get('input_tokens')} out={u.get('output_tokens')}")

    text = payload["content"][0]["text"].strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"Model nije vratio valjan JSON: {text[:200]}")
    return _coerce(json.loads(match.group()), lang)


def lambda_handler(event, context):
    args = event.get("arguments") or event or {}
    transcript = args.get("transcript") or ""
    lang = args.get("lang") or "hr"

    try:
        result = extract(transcript, lang)
    except Exception as e:
        # Ekstrakcija se okida dok doktor jos govori — nikad ne rusi glasovnu
        # sesiju zbog jednog neuspjelog poziva. Frontend zadrzi prethodno stanje.
        print(f"[extract] GRESKA: {type(e).__name__}: {e}")
        result = _empty("en" if str(lang).lower().startswith("en") else "hr")
        result["error"] = str(e)

    return json.dumps(result, ensure_ascii=False)
