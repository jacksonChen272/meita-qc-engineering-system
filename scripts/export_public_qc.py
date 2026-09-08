from __future__ import annotations

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


def main() -> None:
    source = ROOT / "input" / "qc-template.docx"
    target = ROOT / "ui" / "static" / "qc-template.json"
    if not source.exists():
        raise SystemExit("Missing input/qc-template.docx")
    qc = parse_qc_template(source)
    qc["sourceFile"] = "內建 QC 母版"
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
    target.write_text(json.dumps(qc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {target.name}: {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
