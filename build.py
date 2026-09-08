from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from diff import build_diff
from mapping import map_parameters, map_processes
from parsers import parse_qc_template, parse_rnd_document
from render import build_preview_model


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def build_bundle_from_qc(qc: dict, rnd_path: Path) -> tuple[dict, dict]:
    rnd = parse_rnd_document(rnd_path)
    process_mapping = map_processes(rnd, qc)
    parameter_mapping = map_parameters(rnd, qc)
    mapping = {"process": process_mapping, "parameters": parameter_mapping}
    diff = build_diff(qc, rnd, parameter_mapping)
    preview = build_preview_model(qc, diff, rnd)

    bundle = {"rnd": rnd, "qc": qc, "mapping": mapping, "diff": diff, "preview": preview}
    report = {
        "qcProcessSteps": qc["processStepCount"],
        "qcControlItems": qc["controlItemCount"],
        "rndParameters": rnd["parameterCount"],
        "autoMapped": parameter_mapping["autoMappedCount"],
        "statuses": diff["summary"],
        "paginationValid": preview["pagination"]["valid"],
        "pages": preview["pagination"]["pageCount"],
    }
    return bundle, report


def build_bundle(qc_path: Path, rnd_path: Path) -> tuple[dict, dict]:
    return build_bundle_from_qc(parse_qc_template(qc_path), rnd_path)


def build(qc_path: Path, rnd_path: Path) -> dict:
    bundle, report = build_bundle(qc_path, rnd_path)
    debug = ROOT / "debug"
    qc, rnd, mapping, diff = bundle["qc"], bundle["rnd"], bundle["mapping"], bundle["diff"]
    write_json(debug / "rnd-extracted.json", rnd)
    write_json(debug / "qc-template.json", qc)
    write_json(debug / "mapping-result.json", mapping)
    write_json(debug / "diff-result.json", diff)

    write_json(ROOT / "ui" / "static" / "data.json", bundle)
    write_json(ROOT / "build-report.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the QC engineering-map demo data.")
    parser.add_argument("--qc", type=Path, default=ROOT / "input" / "qc-template.docx")
    parser.add_argument(
        "--rnd",
        type=Path,
        default=ROOT / "input" / "rnd-standard.docx",
    )
    args = parser.parse_args()
    if not args.qc.exists() or not args.rnd.exists():
        parser.error(f"Input missing: qc={args.qc.exists()} rnd={args.rnd.exists()}")
    print(json.dumps(build(args.qc, args.rnd), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
