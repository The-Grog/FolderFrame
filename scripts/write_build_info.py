#!/usr/bin/env python3
"""Stamp public build identity into a static deployment; never query latest releases."""
import argparse
import json
from pathlib import Path
import re

VERSION = re.compile(r"v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
REVISION = re.compile(r"[a-fA-F0-9]{40}")

def build_info(version="", revision="", deployment_revision=""):
    fields = (("version", version, VERSION), ("revision", revision, REVISION),
              ("deploymentRevision", deployment_revision, REVISION))
    result = {"schemaVersion": 1}
    for key, value, pattern in fields:
        if value and (len(value) > 100 or not pattern.fullmatch(value)):
            raise ValueError(f"Invalid {key}")
        result[key] = value or None
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default="")
    parser.add_argument("--revision", default="")
    parser.add_argument("--deployment-revision", default="")
    parser.add_argument("--output", type=Path, default=Path("build-info.json"))
    args = parser.parse_args()
    try:
        payload = build_info(args.version, args.revision, args.deployment_revision)
    except ValueError as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

if __name__ == "__main__":
    main()
