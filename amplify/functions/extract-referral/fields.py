"""Canonical field contract for hybrid referral extraction.

Mirrors src/referralSchema.js. Extra (non-canonical) fields are returned as a
free-form list so different referral templates can be handled without a new
schema deploy.
"""

TEXT = "text"
ENUM = "enum"

FIELDS = [
    ("vlasnik_ime", TEXT, None, "Ime vlasnika zivotinje"),
    ("vlasnik_prezime", TEXT, None, "Prezime vlasnika zivotinje"),
    ("vlasnik_adresa", TEXT, None, "Adresa vlasnika"),
    ("vlasnik_oib", TEXT, None, "OIB vlasnika, tocno 11 znamenki, samo znamenke"),
    ("vrsta", TEXT, None, "Vrsta zivotinje, npr. pas, macka — točno kako piše ili je označeno"),
    ("pasmina", TEXT, None, "Pasmina zivotinje"),
    ("dob", TEXT, None, "Dob zivotinje kako piše na dokumentu (npr. 3 godine, 5 m, 12.01.2020.)"),
    ("spol", ENUM, ["M", "Z"], "Spol zivotinje: M ili Z"),
    ("mikrocip", TEXT, None, "Broj mikrocipa, tocno 15 znamenki, samo znamenke"),
]

FIELD_NAMES = [name for name, _, _, _ in FIELDS]


def build_tool_schema():
    """Builds the JSON schema Claude is forced to fill via tool_choice."""
    canonical_properties = {}

    for name, kind, options, description in FIELDS:
        prop = {
            "type": ["string", "null"],
            "description": f"{description}. Vrati null ako podatak nije citljiv.",
        }
        if kind == ENUM and options is not None:
            prop["enum"] = options + [None]
        canonical_properties[name] = prop

    confidence_properties = {
        name: {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": f"Sigurnost za kanonsko polje {name}, 0 do 1",
        }
        for name in FIELD_NAMES
    }

    return {
        "type": "object",
        "properties": {
            "canonical": {
                "type": "object",
                "properties": canonical_properties,
                "required": FIELD_NAMES,
                "description": "Zajednička polja koja postoje na većini uputnica",
            },
            "confidence": {
                "type": "object",
                "properties": confidence_properties,
                "required": FIELD_NAMES,
                "description": "Sigurnost po kanonskom polju",
            },
            "extra_fields": {
                "type": "array",
                "description": (
                    "Sva ostala polja s dokumenta koja nisu u canonical. "
                    "Label mora biti točno kako piše na dokumentu."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {
                            "type": "string",
                            "description": "Naziv polja točno kako piše na dokumentu",
                        },
                        "value": {
                            "type": ["string", "null"],
                            "description": "Vrijednost; za više označenih stavki spoji s '; '",
                        },
                        "confidence": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1,
                        },
                    },
                    "required": ["label", "value", "confidence"],
                },
            },
            "warnings": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Kratke napomene o nečitljivim ili dvosmislenim mjestima",
            },
        },
        "required": ["canonical", "confidence", "extra_fields", "warnings"],
    }
