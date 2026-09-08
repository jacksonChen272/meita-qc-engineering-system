from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path

from .docx_utils import DocxDocument, clean_text


ROOT = Path(__file__).resolve().parents[1]
CONVERT_SCRIPT = ROOT / "scripts" / "convert_legacy_doc.ps1"


def _key(value: str) -> str:
    return re.sub(r"\s+", "", clean_text(value))


def _next_cell_value(row, label: str) -> str:
    label_key = _key(label)
    for index, cell in enumerate(row.cells):
        if _key(cell.text) == label_key and index + 1 < len(row.cells):
            return clean_text(row.cells[index + 1].text)
    return ""


def _display_date(value: str) -> str:
    text = clean_text(value)
    match = re.search(r"(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", text)
    if match:
        return f"{match.group(1)}.{int(match.group(2)):02d}.{int(match.group(3)):02d}"
    return text


def _display_unit(value: str) -> str:
    compact = _key(value)
    return compact if compact in {"生產一課", "生產二課", "生產三課"} else clean_text(value)


def _metadata_from_docx(path: Path) -> dict:
    document = DocxDocument(path)
    metadata = {
        "documentNumber": "",
        "documentName": "",
        "establishedDate": "",
        "unit": "",
        "pageText": "",
        "revisionHistory": [],
        "latestRevision": "",
    }
    legacy_revision_text = ""

    labels = {
        "文件編號": "documentNumber",
        "文件名稱": "documentName",
        "制定日期": "establishedDate",
        "權責單位": "unit",
        "適用範圍": "unit",
        "頁次": "pageText",
    }
    tables = document.tables()
    for table in tables:
        for row in table.rows:
            for label, field in labels.items():
                if metadata[field]:
                    continue
                value = _next_cell_value(row, label)
                if value:
                    metadata[field] = value
            if not metadata["documentNumber"]:
                metadata["documentNumber"] = _next_cell_value(row, "編號")
            if not metadata["establishedDate"]:
                metadata["establishedDate"] = _next_cell_value(row, "制訂") or _next_cell_value(row, "制定")
            if not legacy_revision_text:
                legacy_revision_text = _next_cell_value(row, "修訂")

        if not metadata["documentName"] and table.rows:
            for cell in table.rows[0].cells:
                title = clean_text(cell.text).replace("\n", " ")
                if "QC工程圖" in _key(title):
                    metadata["documentName"] = title
                    break

        header_index = next(
            (
                index
                for index, row in enumerate(table.rows)
                if {"修訂日期", "現行版次", "發行日期"}.issubset({_key(cell.text) for cell in row.cells})
            ),
            None,
        )
        if header_index is None:
            continue
        for row in table.rows[header_index + 1 :]:
            values = [clean_text(cell.text) for cell in row.cells]
            if len(values) < 4:
                continue
            revision_date, revision, content, issue_date = values[0], values[1], values[2], values[-1]
            if not any((revision_date, revision, content, issue_date)):
                continue
            if _key(revision_date) in {"核准", "審核"}:
                break
            metadata["revisionHistory"].append(
                {
                    "revisionDate": revision_date,
                    "revision": revision,
                    "content": content,
                    "issueDate": issue_date,
                }
            )

    revisions = [item["revision"] for item in metadata["revisionHistory"] if re.fullmatch(r"\d+(?:\.\d+)?", item["revision"])]
    if revisions:
        metadata["latestRevision"] = max(revisions, key=lambda value: tuple(int(part) for part in value.split(".")))
    elif legacy_revision_text:
        match = re.search(r"第\s*(\d+)\s*次修訂\s*[：:]?\s*(.*)", legacy_revision_text)
        if match:
            revision = f"{int(match.group(1))}.0"
            revision_date = _display_date(match.group(2))
            metadata["latestRevision"] = revision
            metadata["revisionHistory"].append(
                {
                    "revisionDate": revision_date,
                    "revision": revision,
                    "content": f"舊版第{int(match.group(1))}次修訂",
                    "issueDate": "",
                }
            )
    metadata["establishedDate"] = _display_date(metadata["establishedDate"])
    metadata["unit"] = _display_unit(metadata["unit"])
    return metadata


def convert_doc_to_docx(source: Path, target: Path) -> None:
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(CONVERT_SCRIPT),
            "-Source",
            str(source),
            "-Target",
            str(target),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0 or not target.exists():
        message = (result.stderr or result.stdout or "Word 轉檔失敗").strip()
        raise ValueError(message)


def parse_legacy_metadata(path: str | Path) -> dict:
    source = Path(path)
    suffix = source.suffix.lower()
    if suffix == ".docx":
        return _metadata_from_docx(source)
    if suffix != ".doc":
        raise ValueError("只接受 .doc 或 .docx 舊版文件")
    with tempfile.TemporaryDirectory(prefix="qc-legacy-convert-") as folder:
        converted = Path(folder) / "legacy.docx"
        convert_doc_to_docx(source, converted)
        return _metadata_from_docx(converted)
