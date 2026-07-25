#!/usr/bin/env python3
"""
Kreira (ili azurira) Amazon Transcribe custom vocabulary za hrvatski.

Custom vocabulary nije podrzan kao CloudFormation resurs, pa se postavlja
skriptom izvan Amplify deploya. Pokrenuti jednom, i ponovno svaki put kad
se promijeni transcribe/vet-vocabulary-hr.txt.

Preduvjeti: AWS credentials s dozvolama za s3:PutObject i transcribe:*Vocabulary.

Primjer:
    python3 scripts/create_transcribe_vocabulary.py --bucket moj-bucket

Nakon sto status prijedje u READY, ime vokabulara postavite u frontendu kao
VITE_TRANSCRIBE_VOCABULARY_HR (vidi src/lib/liveTranscribe.js).
"""
import argparse
import sys
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

DEFAULT_NAME = "vet-hr"
DEFAULT_FILE = Path(__file__).resolve().parent.parent / "transcribe" / "vet-vocabulary-hr.txt"
LANGUAGE_CODE = "hr-HR"


def upload(s3, bucket: str, key: str, path: Path) -> str:
    s3.upload_file(str(path), bucket, key)
    uri = f"s3://{bucket}/{key}"
    print(f"[vocab] Uploadano: {uri}")
    return uri


def exists(transcribe, name: str) -> bool:
    try:
        transcribe.get_vocabulary(VocabularyName=name)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NotFoundException", "BadRequestException"):
            return False
        raise


def wait_ready(transcribe, name: str, timeout_s: int = 300) -> str:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        resp = transcribe.get_vocabulary(VocabularyName=name)
        state = resp["VocabularyState"]
        if state == "READY":
            print(f"[vocab] '{name}' je READY — moze se koristiti u streamingu.")
            return state
        if state == "FAILED":
            # FailureReason navodi tocan redak/znak koji nije prosao validaciju
            print(f"[vocab] NEUSPJEH: {resp.get('FailureReason', '(bez detalja)')}", file=sys.stderr)
            return state
        print(f"[vocab] status={state}, cekam...")
        time.sleep(5)
    print(f"[vocab] Timeout nakon {timeout_s}s — provjerite status rucno.", file=sys.stderr)
    return "TIMEOUT"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bucket", required=True, help="S3 bucket za vocabulary datoteku")
    ap.add_argument("--key", default="transcribe/vet-vocabulary-hr.txt")
    ap.add_argument("--name", default=DEFAULT_NAME, help=f"ime vokabulara (default: {DEFAULT_NAME})")
    ap.add_argument("--file", default=str(DEFAULT_FILE))
    ap.add_argument("--region", default="us-east-1")
    args = ap.parse_args()

    path = Path(args.file)
    if not path.is_file():
        print(f"Datoteka ne postoji: {path}", file=sys.stderr)
        return 1

    session = boto3.Session(region_name=args.region)
    s3 = session.client("s3")
    transcribe = session.client("transcribe")

    uri = upload(s3, args.bucket, args.key, path)

    if exists(transcribe, args.name):
        print(f"[vocab] '{args.name}' vec postoji — azuriram.")
        transcribe.update_vocabulary(
            VocabularyName=args.name,
            LanguageCode=LANGUAGE_CODE,
            VocabularyFileUri=uri,
        )
    else:
        print(f"[vocab] Kreiram '{args.name}'.")
        transcribe.create_vocabulary(
            VocabularyName=args.name,
            LanguageCode=LANGUAGE_CODE,
            VocabularyFileUri=uri,
        )

    return 0 if wait_ready(transcribe, args.name) == "READY" else 1


if __name__ == "__main__":
    sys.exit(main())
