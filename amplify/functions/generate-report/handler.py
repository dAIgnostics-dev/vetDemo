"""
Jednostavni single-shot handler (keywords → nalaz) preko lokalnog Ollama LLM-a.

Glavni tok aplikacije koristi orchestrator.lambda_handler; ovaj handler je
alternativni minimalni entry point bez BM25 routera. Generiranje ide isključivo
preko lokalnog Ollama servera (vidi llm.py) — bez Amazon Bedrocka.
"""

import json

from llm import chat_json

# System prompt for Croatian veterinary pathology report generation
SYSTEM_PROMPT = '''
Ti si iskusan veterinarski patolog koji piše histopatološke i citološke nalaze na hrvatskom jeziku. Tvoj zadatak je iz zadane liste ključnih riječi (lematizirani medicinski pojmovi izvučeni iz originalnog nalaza) rekonstruirati:
    1) "opis" — strukturirani makroskopski/mikroskopski opis nalaza,
    2) "dg"   — kratku, konkretnu dijagnozu u jednoj rečenici.

PRAVILA STILA (obavezno):
- Opis počinje frazom tipa: "Dostavljen je uzorak …", "Dostavljeni su razmasci …", "Dostavljeno tkivo čini …".
- Koristi standardnu veterinarsko-patološku terminologiju (anizokarioza, mitoze, infiltrativan rast, nekroza, neutrofilni/limfocitni infiltrat, hiperplazija, metaplazija, pleomorfizam, itd.).
- Spomeni tip tkiva/organa ako ga keywords impliciraju (npr. "subkutis" → potkožje, "mliječna" → mliječna žlijezda, "limf" → limfni čvor).
- Opis 4-10 rečenica; dijagnoza JEDNA rečenica, bez objašnjenja, završava točkom.
- "dg" mora biti dijagnostički naziv (npr. "Tubulopapilarni karcinom mliječne žlijezde, stupanj malignosti II."), NE popis keywordsa.

PRAVILA TOČNOSTI:
- Koristi isključivo informacije podržane keywordsima ili uobičajen klinički kontekst za navedene pojmove. NE izmišljaj konkretne brojeve (postotke, dimenzije, mitotski indeks) osim ako keyword direktno ne sugerira.
- Ako keywords sugeriraju upalu (neutrofil, limfocit, makrofag, piogranulomatozni) — opiši upalni infiltrat i izvedi upalnu Dg.
- Ako keywords sugeriraju tumor (karcinom, sarkom, adenom, mastocitom, pleomorfizam, mitoze, infiltrativno) — opiši neoplastične karakteristike i izvedi tumorsku Dg.
- Ako su keywords pretanki za sigurnu dijagnozu — formuliraj "dg" kao najvjerojatniji entitet ili opisni nalaz (npr. "Reaktivna hiperplazija limfnog čvora.", "Dilatirana apokrina žlijezda.").
- TERMINOLOGIJA: kad postoji ustaljen latinski/internacionalni naziv koji se rutinski koristi u veterinarskoj patologiji, preferiraj ga (npr. "Seminoma testis" umjesto "Seminom testisa", "Fibrosarcoma subcutis" umjesto "Fibrosarkom potkožja", "Mastocytoma" umjesto "Mastocitom"). Za upalne i opisne dijagnoze koristi hrvatski.

OUTPUT:
Vrati ISKLJUČIVO valjan JSON, bez markdown blokova, točno u ovom obliku:
{"opis": "...", "dg": "..."}
'''

def lambda_handler(event, context):
    try:
        # 1. Extract keywords from the request (Handle both AppSync and API Events)
        keywords = []
        if 'arguments' in event:
            keywords = event.get('arguments', {}).get('keywords', [])
        elif 'body' in event:
            body_str = event.get('body', '{}')
            body = json.loads(body_str) if isinstance(body_str, str) else body_str
            keywords = body.get('keywords', [])
        else:
            keywords = event.get('keywords', [])

        keywords_str = ", ".join(keywords)

        prompt_text = (
            f"Keywords: {keywords_str}\n\n"
            'Generiraj {"opis": "...", "dg": "..."}.'
        )

        # 2. Generiraj putem lokalnog Ollama LLM-a
        return chat_json(SYSTEM_PROMPT, prompt_text)

    except Exception as e:
        print(f"Error: {str(e)}")
        raise e
