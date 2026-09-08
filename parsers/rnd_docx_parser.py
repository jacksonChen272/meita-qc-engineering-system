from __future__ import annotations

import re
from pathlib import Path

from domain import SourceTrace

from .docx_utils import DocxDocument, RawCell, RawRow, RawTable, clean_text


def _row_text(row: RawRow) -> str:
    return " | ".join(cell.text for cell in row.cells if cell.text)


def _table_text(table: RawTable) -> str:
    return "\n".join(_row_text(row) for row in table.rows)


def _cell_at_grid(row: RawRow, grid: int) -> RawCell | None:
    for cell in row.cells:
        if cell.grid_start <= grid < cell.grid_start + cell.grid_span:
            return cell
    return None


def _value_at_grid(row: RawRow, grid: int) -> str:
    cell = _cell_at_grid(row, grid)
    return "" if cell is None else clean_text(cell.text)


def _format_value(lower: str, upper: str, unit: str) -> str:
    lower = clean_text(lower)
    upper = clean_text(upper)
    unit = clean_text(unit)
    if lower and upper:
        value = f"{lower}–{upper}"
    else:
        value = lower or upper
    return f"{value} {unit}".strip()


def _metadata(path: Path, title: str) -> dict:
    source = f"{path.stem} {title}"
    code_match = re.search(r"(AF_[A-Z]+_[A-Z]+_\d+)", source, re.I)
    version_match = re.search(r"-(\d+\.\d+)\s+\d{4}\.\d{2}\.\d{2}", source)
    date_match = re.search(r"(20\d{2}\.\d{2}\.\d{2})", source)
    name = re.sub(r"^二課-", "", path.stem)
    name = re.split(r"-AF_[A-Z]", name, maxsplit=1, flags=re.I)[0].strip()
    return {
        "name": name,
        "code": code_match.group(1).upper() if code_match else "",
        "version": version_match.group(1) if version_match else "",
        "date": date_match.group(1) if date_match else "",
        "sourceFile": path.name,
    }


def parse_rnd_document(path: str | Path) -> dict:
    path = Path(path)
    document = DocxDocument(path)
    blocks = document.body_blocks()
    tables = document.tables()
    title = next((block.text for block in blocks if block.kind == "paragraph" and block.text), path.stem)
    product = _metadata(path, title)
    parameters: list[dict] = []
    workflow_blocks: list[dict] = []
    history: list[dict] = []
    formula_sections: list[dict] = []

    def add_parameter(
        category: str,
        section: str,
        name: str,
        value: str,
        *,
        unit: str = "",
        lower: str = "",
        upper: str = "",
        note: str = "",
        process_hint: str = "",
        page: int | None = None,
        table: int | None = None,
        row: int | None = None,
        original: str = "",
        classification: str = "RND_PARAMETER",
    ) -> dict:
        trace = SourceTrace(
            file=path.name,
            section=section,
            original_text=original or f"{name} {value}",
            page_number=page,
            table_index=table,
            row_index=row,
        )
        record = {
            "id": f"rnd-{len(parameters) + 1:03d}",
            "category": category,
            "section": section,
            "name": clean_text(name),
            "value": clean_text(value),
            "unit": clean_text(unit),
            "lower": clean_text(lower),
            "upper": clean_text(upper),
            "note": clean_text(note),
            "processHint": clean_text(process_hint),
            "classification": classification,
            "source": trace.to_dict(),
        }
        parameters.append(record)
        return record

    for table in tables:
        text = _table_text(table)
        if "日期" in text and "修改事項" in text:
            for row in table.rows[1:]:
                history.append(
                    {
                        "date": _value_at_grid(row, 0),
                        "version": _value_at_grid(row, 1),
                        "change": _value_at_grid(row, 2),
                        "source": SourceTrace(path.name, "版本履歷", _row_text(row), table_index=table.index, row_index=row.index).to_dict(),
                    }
                )
            continue

        if "供應商" in text and "kg/2000 L" in text:
            current_machine = ""
            for row in table.rows[1:]:
                if len(row.cells) == 1 and row.cells[0].grid_span >= 3:
                    current_machine = clean_text(row.cells[0].text)
                    formula_sections.append({"machine": current_machine, "items": []})
                    continue
                name = _value_at_grid(row, 0)
                supplier = _value_at_grid(row, 1)
                value = _value_at_grid(row, 2)
                if not name:
                    continue
                record = add_parameter(
                    "formula",
                    f"配方表 > {current_machine or '彙總'}",
                    name,
                    f"{value} kg/2000 L" if value and name not in {"水量", "總共"} else value,
                    unit="kg/2000 L" if value and name not in {"水量", "總共"} else "L",
                    process_hint=current_machine,
                    page=3 if row.index < 28 else 4,
                    table=table.index,
                    row=row.index,
                    original=_row_text(row),
                )
                record["supplier"] = supplier
                if not formula_sections or formula_sections[-1]["machine"] != (current_machine or "彙總"):
                    formula_sections.append({"machine": current_machine or "彙總", "items": []})
                formula_sections[-1]["items"].append(record["id"])
            continue

        if "濾網規格" in text and "罐中心溫度" in text:
            for row in table.rows:
                name = _value_at_grid(row, 0)
                raw_value = _value_at_grid(row, 1)
                section = "充填及殺菌 > 充填條件"
                if name == "均質壓力":
                    parts = re.split(r"[/／]", raw_value, maxsplit=1)
                    add_parameter("filling", section, "均質壓力", parts[0], process_hint="加熱均質", page=6, table=table.index, row=row.index, original=_row_text(row))
                    if len(parts) > 1:
                        add_parameter("filling", section, "均質溫度", parts[1], process_hint="加熱均質", page=6, table=table.index, row=row.index, original=_row_text(row))
                else:
                    add_parameter("filling", section, name, raw_value, process_hint=name, page=6, table=table.index, row=row.index, original=_row_text(row))
            continue

        if "上釜溫度" in text and "旋轉速度" in text:
            inherited_name = ""
            for row in table.rows:
                first = _value_at_grid(row, 0)
                first_cell = _cell_at_grid(row, 0)
                if first:
                    inherited_name = first
                if inherited_name == "旋轉速度":
                    stage = _value_at_grid(row, 1)
                    value = _value_at_grid(row, 2)
                    name = f"旋轉速度-{stage}"
                else:
                    name = first
                    value = _value_at_grid(row, 2) or _value_at_grid(row, 1)
                if not name:
                    continue
                classification = "REVIEW_REQUIRED" if name == "上釜溫度" and value.upper() == "X" else "RND_PARAMETER"
                add_parameter(
                    "sterilization",
                    "充填及殺菌 > 殺菌包裝條件",
                    name,
                    value,
                    process_hint="冷卻" if name.endswith("冷卻") else "殺菌",
                    page=6,
                    table=table.index,
                    row=row.index,
                    original=_row_text(row),
                    classification=classification,
                )
            continue

        if "項目" in text and "下限" in text and "上限" in text:
            is_finished = "真空度" in text or "內容量-重量" in text
            category = "finished" if is_finished else "half_finished"
            section = "產品檢驗標準 > 成品規格（內規）" if is_finished else "產品檢驗標準 > 半成品（調配桶）"
            standard_number = "10-0209-014" if is_finished else "10-0209-013"
            page = 8 if is_finished else 7
            for row in table.rows[1:]:
                name = _value_at_grid(row, 0)
                unit = _value_at_grid(row, 1)
                lower = _value_at_grid(row, 2)
                upper_cell = _cell_at_grid(row, 3)
                upper = "" if upper_cell is None or upper_cell.grid_start == 2 else clean_text(upper_cell.text)
                note = _value_at_grid(row, 4)
                if not name:
                    continue
                value = _format_value(lower, upper, unit)
                locked = "不能修改" in note
                record = add_parameter(
                    category,
                    section,
                    name,
                    value,
                    unit=unit,
                    lower=lower,
                    upper=upper,
                    note=note,
                    process_hint="成品開罐" if is_finished else "半成品檢測",
                    page=page,
                    table=table.index,
                    row=row.index,
                    original=_row_text(row),
                    classification="LOCKED" if locked else "RND_PARAMETER",
                )
                record["standardNumber"] = standard_number
            continue

        if "保溫試驗" in text and "微生物檢驗" in text:
            inherited_name = ""
            for row in table.rows[1:]:
                name = _value_at_grid(row, 0)
                if name:
                    inherited_name = name
                value = _value_at_grid(row, 1)
                if not value:
                    continue
                suffix = ""
                if inherited_name == "保溫試驗":
                    suffix = re.sub(r"[、，, ]+", "/", value).strip("/")
                add_parameter(
                    "incubation",
                    "產品檢驗標準 > 保溫試驗及微生物檢驗",
                    f"{inherited_name}-{suffix}" if suffix else inherited_name,
                    value,
                    process_hint="保溫試驗",
                    page=9,
                    table=table.index,
                    row=row.index,
                    original=_row_text(row),
                    classification="REVIEW_REQUIRED" if value not in {"37℃、10天", "37°C、10天"} or inherited_name == "微生物檢驗" else "RND_PARAMETER",
                )
            continue

        if "成品檢查" in text and "規格值" in text:
            for row in table.rows[1:]:
                name = _value_at_grid(row, 0)
                if not name:
                    continue
                left = _value_at_grid(row, 1)
                sep = _value_at_grid(row, 2)
                right = _value_at_grid(row, 3)
                value = f"{left}–{right}" if sep and right else left
                add_parameter("coa", "COA 開立", name, value, page=10, table=table.index, row=row.index, original=_row_text(row))

    workflow_text = next((block.text for block in blocks if block.kind == "paragraph" and "【均質機】" in block.text), "")
    if workflow_text:
        matches = list(re.finditer(r"【([^】]+)】", workflow_text))
        for index, match in enumerate(matches):
            machine = clean_text(match.group(1))
            content = clean_text(workflow_text[match.end() : matches[index + 1].start() if index + 1 < len(matches) else len(workflow_text)])
            if not content:
                continue
            block = {"machine": machine, "text": content, "source": SourceTrace(path.name, f"作業流程 > 【{machine}】", f"【{machine}】{content}", page_number=5).to_dict()}
            if not any(existing["machine"] == machine and existing["text"] == content for existing in workflow_blocks):
                workflow_blocks.append(block)

        homogenizer = next((block for block in workflow_blocks if block["machine"] == "均質機"), None)
        if homogenizer:
            patterns = [
                ("均質壓力第一段", r"第一段\s*([0-9.]+\s*±\s*[0-9.]+\s*bar)"),
                ("均質壓力第二段", r"第二段\s*([0-9.]+\s*bar)"),
                ("均質溫度", r"溫度\s*([0-9.]+\s*±\s*[0-9.]+\s*°?C)"),
            ]
            for name, pattern in patterns:
                match = re.search(pattern, homogenizer["text"], re.I)
                if match:
                    add_parameter(
                        "workflow",
                        "作業流程 > 【均質機】",
                        name,
                        match.group(1),
                        process_hint="調配液均質",
                        page=5,
                        original=homogenizer["source"]["original_text"],
                    )

    machines = []
    for section in formula_sections:
        machine = section["machine"]
        if machine and machine not in machines and machine != "彙總":
            machines.append(machine)
    for block in workflow_blocks:
        if block["machine"] not in machines:
            machines.append(block["machine"])

    return {
        "product": product,
        "history": history,
        "machines": machines,
        "formulaSections": formula_sections,
        "workflowBlocks": workflow_blocks,
        "parameterCount": len(parameters),
        "parameters": parameters,
    }
