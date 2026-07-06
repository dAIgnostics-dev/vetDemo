"""
Šablone za strukturu histopatološkog nalaza — ECVP deskriptivna tehnika.

Sadržaj šablone živi u datoteci `nalaz_sablona.md` (uredljiva, trajni izvor
znanja). Ovaj modul je učitava pri generiranju i u prompt ubacuje samo blokove
omeđene markerima:

    <!-- INJECT:COMMON -->    ... opća pravila ...          <!-- /INJECT -->
    <!-- INJECT:TUMOR -->     ... šablona za tumore ...     <!-- /INJECT -->
    <!-- INJECT:NON_TUMOR --> ... šablona za ne-tumore ...  <!-- /INJECT -->

Ostatak datoteke (npr. "## Referenca") NE ulazi u prompt — služi kao trajna
dokumentacija/podloga za buduće dorade.

Prema ključnim riječima biramo tumorsku ili ne-tumorsku šablonu. Ako datoteka
ili marker nedostaje, koristimo ugrađeni fallback (generiranje se ne ruši).

Izvor: ECVP / JPC (AFIP) deskriptivna tehnika — Roccabianca & Banco.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

TEMPLATE_PATH = Path(__file__).parent / "nalaz_sablona.md"

# Ključne riječi koje sugeriraju neoplaziju (tumor). Ako se ijedna pojavi,
# biramo tumorsku šablonu; inače ne-tumorsku.
_TUMOR_SIGNALS = (
    "tumor", "tumsk", "neoplaz", "karcinom", "carcinoma", "sarkom", "sarcoma",
    "adenom", "adenoma", "mastocit", "mastocytoma", "melanom", "melanoma",
    "limfom", "lymphoma", "papilom", "papilloma", "seminom", "seminoma",
    "mitoz", "mitot", "pleomorf", "anizokarioz", "anizocitoz", "infiltrativ",
    "maligni", "malignost", "benign", "metastaz", "neoplastičn", "neoplasticn",
    "gliom", "osteosarkom", "fibrosarkom", "hemangiosarkom", "histiocitom",
)

# --- Fallback ako nalaz_sablona.md nije dostupan (npr. deploy bez datoteke) ---
_FALLBACK_COMMON = (
    "Opisuj samo ono što ključne riječi podržavaju; ne izmišljaj konkretne "
    "brojeve (dimenzije, mitoze/HPF, postotke). Zadrži organ dosljednim kroz "
    "opis i dijagnozu."
)
_FALLBACK_TUMOR = (
    "STRUKTURA NALAZA (tumor): 1) uzorak i subgross (tkivo, lokacija, oblik, "
    "veličina, staničnost, opseg, rast, ograničenost, kapsula, rubovi), "
    "2) obrazac rasta i stroma, 3) citološke karakteristike, 4) atipične "
    "značajke, 5) mitotska aktivnost, 6) znakovi malignosti, 7) dodatni nalazi. "
    "Dg: tkivo + naziv/tip tumora + malignost/stupanj."
)
_FALLBACK_NON_TUMOR = (
    "STRUKTURA NALAZA (ne-tumor): 1) uzorak i subgross (sijelo, opseg, "
    "distribucija, tip procesa), 2) glavne promjene (dodano/promijenjeno/"
    "nedostaje — nabroji i kvantificiraj), 3) etiološki agens (ako postoji), "
    "4) clean up. Dg (5 komponenti): organ + težina + vremenski tijek + "
    "distribucija + tip lezije."
)

_BLOCK_RE = r"<!--\s*INJECT:{name}\s*-->\s*(.*?)\s*<!--\s*/INJECT\s*-->"


@lru_cache(maxsize=1)
def _blocks() -> dict[str, str]:
    """Učitaj i izreži INJECT blokove iz nalaz_sablona.md (cache-irano)."""
    out = {
        "COMMON": _FALLBACK_COMMON,
        "TUMOR": _FALLBACK_TUMOR,
        "NON_TUMOR": _FALLBACK_NON_TUMOR,
    }
    try:
        text = TEMPLATE_PATH.read_text(encoding="utf-8")
    except OSError:
        return out
    for name in out:
        m = re.search(_BLOCK_RE.format(name=name), text, re.DOTALL)
        if m and m.group(1).strip():
            out[name] = m.group(1).strip()
    return out


def is_tumor(keywords: list[str]) -> bool:
    """True ako ključne riječi sugeriraju neoplaziju (tumorska šablona)."""
    blob = " ".join(keywords).lower()
    return any(sig in blob for sig in _TUMOR_SIGNALS)


def build_structure_guidance(keywords: list[str]) -> str:
    """Vrati odgovarajuću ECVP šablonu (opća pravila + tumor/ne-tumor)."""
    b = _blocks()
    section = b["TUMOR"] if is_tumor(keywords) else b["NON_TUMOR"]
    return f"{b['COMMON']}\n\n{section}"
