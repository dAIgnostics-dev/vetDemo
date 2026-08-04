import base64
import json
import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from fields import FIELD_NAMES, build_tool_schema

# Textract is not available in eu-north-1, so it is called cross-region. Bedrock
# uses an EU inference profile because the form carries owner name and OIB.
TEXTRACT_REGION = os.environ.get("TEXTRACT_REGION", "eu-central-1")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "eu-north-1")
MODEL_ID = os.environ.get(
    "MODEL_ID", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0"
)

TOOL_NAME = "izvuci_uputnicu"

# Permission is not confirmed in every environment, so losing Textract must
# degrade to vision rather than fail the request.
TEXTRACT_FALLBACK_CODES = {
    "AccessDeniedException",
    "UnrecognizedClientException",
    "InvalidSignatureException",
    "UnsupportedDocumentException",
}

bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)
textract = boto3.client("textract", region_name=TEXTRACT_REGION)


def lambda_handler(event, context):
    args = event.get("arguments", event) or {}
    image_b64 = args.get("imageBase64")
    pdf_text = args.get("pdfText")

    if not image_b64:
        raise ValueError("imageBase64 is required")

    image_bytes = base64.b64decode(image_b64)

    textract_text, ocr_source, textract_error = run_textract(image_bytes)
    extraction = run_bedrock(image_b64, textract_text, pdf_text)

    return {
        "canonical": normalise_canonical(extraction.get("canonical", {})),
        "confidence": normalise_confidence(extraction.get("confidence", {})),
        "extraFields": normalise_extra_fields(extraction.get("extra_fields", [])),
        "warnings": extraction.get("warnings", []) or [],
        "ocrSource": ocr_source,
        "modelId": MODEL_ID,
        "textractError": textract_error,
    }


def run_textract(image_bytes):
    """Returns (serialised_text, ocr_source, error_message)."""
    try:
        response = textract.analyze_document(
            Document={"Bytes": image_bytes}, FeatureTypes=["FORMS"]
        )
        return serialise_textract(response), "textract", None
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code", "")
        if code in TEXTRACT_FALLBACK_CODES:
            print(f"Textract unavailable ({code}), falling back to vision only")
            return None, "vision", code
        raise
    except BotoCoreError as error:
        print(f"Textract transport error, falling back to vision only: {error}")
        return None, "vision", type(error).__name__


def serialise_textract(response):
    """Flattens Textract blocks into text where checkbox state is explicit.

    Selection elements are rendered as [X] / [ ] next to their label, which is
    the whole reason for using FORMS on this particular document.
    """
    blocks = {block["Id"]: block for block in response.get("Blocks", [])}

    pairs = []
    for block in blocks.values():
        if block.get("BlockType") != "KEY_VALUE_SET":
            continue
        if "KEY" not in block.get("EntityTypes", []):
            continue

        key = block_text(block, blocks).rstrip(":").strip()
        value_block = related_value(block, blocks)
        value = block_text(value_block, blocks) if value_block else ""

        if key or value:
            pairs.append(f"{key}: {value}".strip())

    lines = [
        block["Text"]
        for block in response.get("Blocks", [])
        if block.get("BlockType") == "LINE" and block.get("Text")
    ]

    sections = []
    if pairs:
        sections.append("POLJA I KVADRATICI:\n" + "\n".join(pairs))
    if lines:
        sections.append("SVE LINIJE TEKSTA:\n" + "\n".join(lines))

    return "\n\n".join(sections)


def related_value(key_block, blocks):
    for relationship in key_block.get("Relationships", []):
        if relationship.get("Type") != "VALUE":
            continue
        for value_id in relationship.get("Ids", []):
            value_block = blocks.get(value_id)
            if value_block:
                return value_block
    return None


def block_text(block, blocks):
    parts = []
    for relationship in block.get("Relationships", []):
        if relationship.get("Type") != "CHILD":
            continue
        for child_id in relationship.get("Ids", []):
            child = blocks.get(child_id)
            if not child:
                continue
            if child.get("BlockType") == "WORD":
                parts.append(child.get("Text", ""))
            elif child.get("BlockType") == "SELECTION_ELEMENT":
                selected = child.get("SelectionStatus") == "SELECTED"
                parts.append("[X]" if selected else "[ ]")
    return " ".join(part for part in parts if part).strip()


def build_prompt(textract_text, pdf_text):
    instructions = [
        "Ti si asistent koji iz skenirane veterinarske uputnice izvlaci strukturirane podatke.",
        "Dokument je na hrvatskom. Postoje različiti obrasci uputnica.",
        "",
        "Vrati:",
        "- canonical: samo zajednička polja (vlasnik ime/prezime/adresa/oib, zivotinja vrsta/pasmina/dob/spol/mikrocip)",
        "- extra_fields: SVA ostala polja s dokumenta (organizacija, kontakt, pretrage, uzorak, anamneza, veterinar...)",
        "- confidence za canonical polja",
        "- warnings za nejasna mjesta",
        "",
        "Pravila:",
        "1. Vrati null za kanonsko polje koje ne mozes procitati. Nikada ne pogadaj.",
        "2. Ako je na dokumentu jedno polje 'Ime i prezime', podijeli u vlasnik_ime i vlasnik_prezime kad je razdvajanje ocito. Inace stavi cijeli tekst u vlasnik_ime, vlasnik_prezime=null i dodaj warning.",
        "3. Label u extra_fields mora biti TOCNO kako piše na dokumentu (ne prevodi, ne pretvaraj u snake_case).",
        "4. Ne dupliciraj: ako je OIB vec u canonical.vlasnik_oib, ne stavljaj ga i u extra_fields. Isto za ostala kanonska polja.",
        "5. Za OIB i mikrocip vrati samo znamenke, bez razmaka i crtica.",
        "6. Kvadratic je oznacen samo ako na slici jasno vidis kvacicu, krizic ili ispunu.",
        "7. Checkbox grupe (npr. vrsta pretrage) spoji u jedno extra polje; value neka bude popis oznacenih stavki odvojenih s '; '.",
        "8. Zadrzi hrvatske dijakriticke znakove.",
        "9. U confidence stavi stvarnu sigurnost. Null polja neka imaju nisku vrijednost.",
    ]

    if textract_text:
        instructions += [
            "",
            "Ispod je OCR ocitanje istog dokumenta iz Amazon Textracta.",
            "Koristi ga kao pomoc pri citanju teksta, ali sliku smatraj konacnim izvorom istine.",
            "Ako se OCR i slika ne slazu, vjeruj slici i dodaj napomenu u warnings.",
            "",
            "--- TEXTRACT OCR ---",
            textract_text,
            "--- KRAJ TEXTRACT OCR ---",
        ]

    if pdf_text:
        instructions += [
            "",
            "Ispod je tekstualni sloj izvucen izravno iz PDF-a. Ako postoji, on je tocniji od OCR-a za tipkani tekst.",
            "",
            "--- TEKSTUALNI SLOJ PDF-a ---",
            pdf_text,
            "--- KRAJ TEKSTUALNOG SLOJA ---",
        ]

    instructions += [
        "",
        f"Pozovi alat {TOOL_NAME} s izvucenim podacima.",
    ]

    return "\n".join(instructions)


def run_bedrock(image_b64, textract_text, pdf_text):
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 4096,
        "temperature": 0,
        "tools": [
            {
                "name": TOOL_NAME,
                "description": (
                    "Zapisuje kanonske podatke i sva ostala polja izvucena "
                    "iz veterinarske uputnice."
                ),
                "input_schema": build_tool_schema(),
            }
        ],
        "tool_choice": {"type": "tool", "name": TOOL_NAME},
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": build_prompt(textract_text, pdf_text)},
                ],
            }
        ],
    }

    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps(body),
        contentType="application/json",
        accept="application/json",
    )

    payload = json.loads(response["body"].read())

    for block in payload.get("content", []):
        if block.get("type") == "tool_use" and block.get("name") == TOOL_NAME:
            return block.get("input", {})

    raise RuntimeError(
        f"Model did not return a tool_use block (stop_reason={payload.get('stop_reason')})"
    )


def normalise_canonical(values):
    """Guarantees every canonical field exists."""
    result = {}
    source = values if isinstance(values, dict) else {}

    for name in FIELD_NAMES:
        value = source.get(name)
        if isinstance(value, str):
            value = value.strip() or None
        result[name] = value

    return result


def normalise_confidence(values):
    source = values if isinstance(values, dict) else {}
    result = {}

    for name in FIELD_NAMES:
        raw = source.get(name)
        try:
            score = float(raw) if raw is not None else 0.0
        except (TypeError, ValueError):
            score = 0.0
        result[name] = max(0.0, min(1.0, score))

    return result


def normalise_extra_fields(items):
    """Keeps only usable extras and coerces shape for the frontend."""
    if not isinstance(items, list):
        return []

    normalised = []
    for item in items:
        if not isinstance(item, dict):
            continue

        label = item.get("label")
        if not isinstance(label, str):
            continue
        label = label.strip()
        if not label:
            continue

        value = item.get("value")
        if isinstance(value, str):
            value = value.strip() or None
        elif value is not None and not isinstance(value, str):
            value = str(value)

        try:
            confidence = float(item.get("confidence", 0))
        except (TypeError, ValueError):
            confidence = 0.0

        normalised.append(
            {
                "label": label,
                "value": value,
                "confidence": max(0.0, min(1.0, confidence)),
            }
        )

    return normalised
