from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from parsers import parse_qc_template


def strip_control(control: dict) -> None:
    control.pop("source", None)
    control.pop("source_table_index", None)
    control.pop("source_row_index", None)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a sanitized QC master for the static website.")
    parser.add_argument("--source", default="input/qc-template.docx")
    parser.add_argument("--target", default="ui/static/qc-template-nutrition.json")
    parser.add_argument("--label", default="營養品母版")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = Path(args.source)
    target = Path(args.target)
    if not source.is_absolute():
        source = ROOT / source
    if not target.is_absolute():
        target = ROOT / target
    if not source.exists():
        raise SystemExit(f"Missing source template: {source}")
    qc = parse_qc_template(source)
    qc["sourceFile"] = args.label
    for step in qc["processSteps"]:
        step.pop("qc_template_source", None)
        step.pop("source_rows", None)
        for control in step["control_items"]:
            strip_control(control)
    for page in qc["layout"]["pages"]:
        page.pop("sourceTableIndex", None)
        for row in page["rows"]:
            row.pop("sourceTableIndex", None)
            row.pop("sourceRowIndex", None)
            for field_name, field in row["fields"].items():
                if field_name == "controlItem":
                    field["cells"] = [{"lines": cell.get("lines", [])} for cell in field.get("cells", [])]
                else:
                    field.pop("cells", None)
            for control in row["controlItems"]:
                strip_control(control)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(qc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {target.name}: {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
