from __future__ import annotations

import copy
import re
from collections import Counter
from pathlib import Path

from domain import ControlItem, ProcessStep, SourceTrace

from .docx_utils import DocxDocument, RawCell, RawRow, cells_for_range, clean_text, distinct_nonempty


FIELD_ORDER = [
    "flowSymbol",
    "engineeringName",
    "machine",
    "operationStandard",
    "controlItem",
    "controlStandard",
    "controlChart",
    "controller",
    "correctiveOwner",
    "samplingLocation",
    "samplingFrequency",
    "samplingQuantity",
    "instrument",
    "method",
]

HEADER_TO_FIELD = {
    "流程記號": "flowSymbol",
    "工程名稱": "engineeringName",
    "使用機具": "machine",
    "操作標準": "operationStandard",
    "管制項目": "controlItem",
    "管制基準": "controlStandard",
    "管制圖表": "controlChart",
    "管制人員": "controller",
    "矯正負責人": "correctiveOwner",
    "取樣地點": "samplingLocation",
    "取樣頻率": "samplingFrequency",
    "取樣數量": "samplingQuantity",
    "檢測儀器": "instrument",
    "檢測方法": "method",
}


def _header_key(text: str) -> str:
    return re.sub(r"\s+", "", text)


def _is_header(row: RawRow) -> bool:
    texts = {_header_key(cell.text) for cell in row.cells}
    return "流程記號" in texts and "工程名稱" in texts and "檢測方法" in texts


def _field_ranges(row: RawRow) -> dict[str, tuple[int, int]]:
    ranges: dict[str, tuple[int, int]] = {}
    for cell in row.cells:
        key = HEADER_TO_FIELD.get(_header_key(cell.text))
        if key:
            ranges[key] = (cell.grid_start, cell.grid_start + cell.grid_span)
    missing = [field for field in FIELD_ORDER if field not in ranges]
    if missing:
        raise ValueError(f"QC header is missing fields: {missing}")
    return ranges


def _field_payload(row: RawRow, ranges: dict[str, tuple[int, int]]) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for field, (start, end) in ranges.items():
        cells = cells_for_range(row, start, end)
        lines = [line for cell in cells for line in cell.lines]
        if lines and all(re.fullmatch(r"-+", clean_text(line)) for line in lines):
            # The master uses dashes only as a visual blank-field filler. Keep a
            # single, short line so it cannot wrap in the narrow machine column.
            lines = ["----------"]
        merge_values = [cell.v_merge for cell in cells if cell.v_merge]
        result[field] = {
            "text": "\n".join(lines),
            "lines": lines,
            "merge": merge_values[0] if merge_values else None,
            "cells": [cell.to_dict() for cell in cells],
        }
    return result


def _display_line(value: str) -> str:
    value = clean_text(value)
    return "—" if not value or re.fullmatch(r"-+", value) else value


def _aligned_value(lines: list[str], index: int, count: int) -> str:
    cleaned = [_display_line(line) for line in lines if clean_text(line)]
    if not cleaned:
        return ""
    if count == 1:
        return "\n".join(cleaned)
    if len(cleaned) == count:
        return cleaned[index]
    if len(cleaned) == count - 1 and index >= len(cleaned):
        return cleaned[-1]
    if len(cleaned) == 1:
        return cleaned[0]
    return cleaned[index] if index < len(cleaned) else cleaned[-1]


def _raw_cells(payload: dict) -> list[dict]:
    return payload.get("cells", [])


def _set_field(row: dict, field: str, value: str) -> None:
    payload = row["fields"][field]
    lines = value.splitlines() if value else []
    payload["text"] = value
    payload["lines"] = lines
    payload["merge"] = None
    payload.pop("resolvedFromMerge", None)


def _set_control_parts(row: dict, category: str, details: str) -> None:
    payload = row["fields"]["controlItem"]
    category_lines = category.splitlines()
    detail_lines = details.splitlines()
    cells = payload.get("cells", [])
    if cells:
        cells[0]["lines"] = category_lines
        cells[0]["text"] = "\n".join(category_lines)
    if len(cells) > 1:
        cells[1]["lines"] = detail_lines
        cells[1]["text"] = "\n".join(detail_lines)
    payload["lines"] = category_lines + detail_lines
    payload["text"] = "\n".join(payload["lines"])


def _apply_confirmed_master_corrections(rows: list[dict]) -> None:
    """Apply corrections explicitly confirmed from the plant's marked-up screenshots."""
    for row in rows:
        name = row["engineeringName"].replace("\n", "")

        # The continued row on the following source page belongs to the
        # inspection step, not to a third "封蓋／捲封檢查" process group.
        if name == "封蓋捲封檢查":
            row["engineeringName"] = "捲封檢查"
            _set_field(row, "engineeringName", "捲封檢查")
            name = "捲封檢查"

        sampling_locations = {
            "空罐儲放": "原物料儲放區",
            "罐蓋檢驗": "原物料儲放區",
            "罐蓋儲放": "原物料儲放區",
            "真空檢測打檢": "包裝區",
            "成品開罐": "包裝區",
        }
        if name in sampling_locations:
            _set_field(row, "samplingLocation", sampling_locations[name])

        if name == "空罐噴洗" and "水溫" in row["fields"]["controlItem"]["text"]:
            _set_field(row, "controlStandard", "≧70")
            for control in row["controlItems"]:
                if "水溫" in control.name:
                    control.standard = "≧70"

        if name == "包裝":
            _set_field(row, "operationStandard", "02-0203-042")

        if name == "出貨":
            _set_field(row, "samplingLocation", "出貨區")

        location = row["fields"]["samplingLocation"]["text"]
        if "包裝場" in location:
            _set_field(row, "samplingLocation", location.replace("包裝場", "包裝區"))

        chart = row["fields"]["controlChart"]["text"]
        if "成品包裝品質紀錄表" in chart:
            corrected_chart = chart.replace("成品包裝品質紀錄表", "成品包裝品質檢查表")
            _set_field(row, "controlChart", corrected_chart)
            for control in row["controlItems"]:
                control.chart = control.chart.replace("成品包裝品質紀錄表", "成品包裝品質檢查表")

        control_text = row["fields"]["controlItem"]["text"].replace("\n", "")
        if name in {"封蓋", "捲封檢查"} and "捲封外觀" in control_text and row["controlItems"]:
            details = "切罐\n凹罐\n層狀\n漏罐\n舌狀"
            _set_control_parts(row, "捲\n封\n外\n觀", details)
            row["controlItems"][0].item_details = details

        if name == "捲封檢查" and "捲封內部" in control_text and row["controlItems"]:
            details = "OL%\nWR\nT.W.C.BH\nCH.OL"
            _set_control_parts(row, "捲\n封\n內\n部", details)
            row["controlItems"][0].item_details = details

        if name == "殺菌":
            _set_field(row, "machine", "旋轉式熱水淋灑臥式高溫高壓殺菌釜")
            _set_field(row, "operationStandard", "02-0203-034")
            _set_field(row, "controlItem", "昇溫時間(min)\n溫度(℃)\n時間(min)\n轉速(rpm)")
            _set_field(row, "controlStandard", "17(CCP)\n121.5±0.5(CCP)\n15(CCP)\n4(CCP)")
            _set_field(row, "controlChart", "殺菌工作記錄表\n(圖)")
            _set_field(row, "instrument", "自動溫度記錄儀\n溫度計")
            _set_field(row, "method", "目視\n10-0205-014")
            corrected = row["controlItems"][1:]
            specifications = [
                ("昇溫時間(min)", "17(CCP)", "殺菌工作記錄表", "自動溫度記錄儀", "目視"),
                ("溫度(℃)", "121.5±0.5(CCP)", "(圖)", "溫度計", "10-0205-014"),
                ("時間(min)", "15(CCP)", "(圖)", "溫度計", "10-0205-014"),
                ("轉速(rpm)", "4(CCP)", "(圖)", "溫度計", "10-0205-014"),
            ]
            for index, (control, specification) in enumerate(zip(corrected, specifications)):
                control.name, control.standard, control.chart, control.instrument, control.method = specification
                control.source_item_index = index
                if control.source is not None:
                    control.source.original_text = f"{control.name}：{control.standard}"
            row["controlItems"] = corrected

        if name == "裝箱檢查" and row["controlItems"]:
            control = row["controlItems"][0]
            compact_name = control.name.replace(" ", "").replace("/", "")
            _set_field(row, "operationStandard", "10-0203-004")
            if compact_name in {"紙箱缺點", "外觀不良率"}:
                row["engineeringName"] = "包裝檢查"
                _set_field(row, "engineeringName", "包裝檢查")
                if compact_name == "外觀不良率":
                    details = "凹傷罐\n噴字不良\n罐緣損壞"
                    _set_control_parts(row, "外\n觀\n不\n良\n率", details)
                    control.item_details = details
            elif compact_name == "嚴重缺點":
                details = "真空不良\n膨罐\n彈性罐\n急跳罐\n污銹罐\n穿孔\n腐蝕凹罐"
                _set_control_parts(row, "嚴\n重\n缺\n點", details)
                control.item_details = details

        if name == "整箱打檢":
            _set_field(row, "samplingQuantity", "5批/次")
            for control in row["controlItems"]:
                control.sampling_quantity = "5批/次"


def _keep_split_processes_together(rows: list[dict], pages: list[dict]) -> None:
    """Keep confirmed cross-page continuations as one movable process group."""
    for process_name in ("捲封檢查", "整箱打檢"):
        process_rows = [row for row in rows if row["engineeringName"] == process_name]
        if len(process_rows) < 2 or len({row["paginationGroup"] for row in process_rows}) == 1:
            continue
        target = process_rows[-1]
        target_group = target["paginationGroup"]
        target_page = next((page for page in pages if page["id"] == target_group), None)
        if target_page is None:
            continue
        process_ids = {id(row) for row in process_rows}
        first_target_index = next(index for index, row in enumerate(target_page["rows"]) if id(row) in process_ids)
        target_index = sum(1 for row in target_page["rows"][:first_target_index] if id(row) not in process_ids)
        for page in pages:
            page["rows"] = [row for row in page["rows"] if id(row) not in process_ids]
        for row in process_rows:
            row["paginationGroup"] = target_group
        target_page["rows"][target_index:target_index] = process_rows


def _split_control_items(fields: dict[str, dict], file_name: str, page: int, table: int, row: int) -> list[ControlItem]:
    item_cells = _raw_cells(fields["controlItem"])
    standard_lines = fields["controlStandard"]["lines"]
    instrument_lines = fields["instrument"]["lines"]
    method_lines = fields["method"]["lines"]

    if len(item_cells) > 1:
        primary_lines = item_cells[0].get("lines", [])
        names = [_display_line(" / ".join(primary_lines))]
        item_details = "\n".join(line for cell in item_cells[1:] for line in cell.get("lines", []))
    else:
        primary_lines = item_cells[0].get("lines", []) if item_cells else []
        names = [_display_line(line) for line in primary_lines] or ["—"]
        item_details = ""

    count = len(names)
    items: list[ControlItem] = []
    for index, name in enumerate(names):
        standard = _aligned_value(standard_lines, index, count)
        chart = _aligned_value(fields["controlChart"]["lines"], index, count)
        instrument = _aligned_value(instrument_lines, index, count)
        method = _aligned_value(method_lines, index, count)
        ccp_oprp = "CCP" if "CCP" in standard or "CCP" in chart else "OPRP" if "OPRP" in standard or "OPRP" in chart else "一般"
        original = f"{name}：{standard}" if standard else name
        source = SourceTrace(
            file=file_name,
            section=f"QC 母版 > 第 {page} 頁",
            original_text=original,
            page_number=page,
            table_index=table,
            row_index=row,
        )
        items.append(
            ControlItem(
                id=f"qc-t{table}-r{row}-i{index}",
                name=name,
                standard=standard,
                chart=chart,
                sampling_frequency=_aligned_value(fields["samplingFrequency"]["lines"], index, count),
                sampling_quantity=_aligned_value(fields["samplingQuantity"]["lines"], index, count),
                instrument=instrument,
                method=method,
                item_details=item_details,
                ccp_oprp=ccp_oprp,
                classification="FIXED",
                editable=False,
                source=source,
                source_table_index=table,
                source_row_index=row,
                source_item_index=index,
            )
        )
    return items


def _flow_branch(name: str, sequence: int) -> str:
    """Assign the five independent incoming lanes used by this QC master."""
    if 1 <= sequence <= 4:
        return "material"
    if 5 <= sequence <= 12:
        return "water"
    if sequence in {20, 22, 23, 26, 27}:
        return "can"
    if sequence in {21, 24, 25}:
        return "lid"
    if 45 <= sequence <= 47:
        return "carton"
    return "main"


def _flow_symbol(name: str) -> str:
    if name == "出貨":
        return "end"
    if "入廠" in name or "進廠" in name or name == "原水存放":
        return "start"
    if any(token in name for token in ("檢查", "檢驗", "檢測", "打檢", "試驗")):
        return "inspection"
    if any(token in name for token in ("儲放", "貯存", "留樣", "入倉")):
        return "storage"
    return "operation"


def _unique_field(rows: list[dict], field: str) -> list[str]:
    return distinct_nonempty([row["fields"][field]["text"] for row in rows])


def parse_qc_template(path: str | Path) -> dict:
    path = Path(path)
    document = DocxDocument(path)
    tables = document.tables()
    physical_rows: list[dict] = []
    pages: list[dict] = []
    page_number = 0
    inherited: dict[str, str] = {}

    for table in tables:
        active_ranges: dict[str, tuple[int, int]] | None = None
        active_page: dict | None = None
        for row in table.rows:
            if _is_header(row):
                active_ranges = _field_ranges(row)
                page_number += 1
                widths = []
                for field in FIELD_ORDER:
                    start, end = active_ranges[field]
                    widths.append(sum(table.grid_widths[start:end]))
                active_page = {
                    "id": f"page-{page_number}",
                    "pageNumber": page_number,
                    "sourceTableIndex": table.index,
                    "columnWidths": widths,
                    "rows": [],
                }
                pages.append(active_page)
                inherited = {}
                continue
            if active_ranges is None or active_page is None:
                continue
            joined = "".join(cell.text for cell in row.cells)
            if "製造工程" in _header_key(joined) and "品質管制" in _header_key(joined):
                continue

            fields = _field_payload(row, active_ranges)
            if not any(fields[field]["text"] for field in FIELD_ORDER[1:]):
                continue

            for field in ("engineeringName", "machine", "operationStandard", "controlChart", "controller", "correctiveOwner", "samplingLocation", "samplingFrequency", "samplingQuantity"):
                payload = fields[field]
                if payload["merge"] == "continue" and not payload["text"]:
                    payload["text"] = inherited.get(field, "")
                    payload["resolvedFromMerge"] = True
                elif payload["text"]:
                    inherited[field] = payload["text"]

            source_name = _display_line(fields["engineeringName"]["text"]).replace("\n", "")
            if source_name == "—":
                continue
            display_names = ["空罐進廠", "罐蓋進廠"] if source_name == "空罐、罐蓋入廠" else [source_name]
            for branch_index, name in enumerate(display_names):
                branch_fields = copy.deepcopy(fields) if len(display_names) > 1 else fields
                if len(display_names) > 1:
                    branch_fields["engineeringName"]["text"] = name
                    branch_fields["engineeringName"]["lines"] = [name]
                item_objects = _split_control_items(branch_fields, path.name, page_number, table.index, row.index)
                if len(display_names) > 1:
                    for item in item_objects:
                        item.id = f"{item.id}-branch-{branch_index + 1}"
                physical = {
                    "sourceTableIndex": table.index,
                    "sourceRowIndex": row.index,
                    "paginationGroup": f"page-{page_number}",
                    "pageNumber": page_number,
                    "engineeringName": name,
                    "fields": branch_fields,
                    "controlItems": item_objects,
                }
                physical_rows.append(physical)
                active_page["rows"].append(physical)

    _apply_confirmed_master_corrections(physical_rows)
    _keep_split_processes_together(physical_rows, pages)

    process_steps: list[ProcessStep] = []
    occurrence_counter: Counter[str] = Counter()
    current_rows: list[dict] = []

    def flush_group() -> None:
        nonlocal current_rows
        if not current_rows:
            return
        name = current_rows[0]["engineeringName"]
        occurrence_counter[name] += 1
        step_id = f"process-{len(process_steps) + 1:03d}"
        page = current_rows[0]["pageNumber"]
        pagination_group = current_rows[0]["paginationGroup"]
        controls = [item for source_row in current_rows for item in source_row["controlItems"]]
        for source_row in current_rows:
            source_row["processStepId"] = step_id
            source_row["controlItems"] = [item.to_dict() for item in source_row["controlItems"]]
        source = SourceTrace(
            file=path.name,
            section=f"QC 母版 > 第 {page} 頁 > {name}",
            original_text=" / ".join(item.name for item in controls),
            page_number=page,
            table_index=current_rows[0]["sourceTableIndex"],
            row_index=current_rows[0]["sourceRowIndex"],
        )
        process_steps.append(
            ProcessStep(
                id=step_id,
                name=name,
                machines=_unique_field(current_rows, "machine"),
                operation_standards=_unique_field(current_rows, "operationStandard"),
                flow_symbol=_flow_symbol(name),
                flow_branch=_flow_branch(name, len(process_steps) + 1),
                control_people=_unique_field(current_rows, "controller"),
                corrective_owners=_unique_field(current_rows, "correctiveOwner"),
                sampling_locations=_unique_field(current_rows, "samplingLocation"),
                default_sampling_frequencies=_unique_field(current_rows, "samplingFrequency"),
                default_sampling_quantities=_unique_field(current_rows, "samplingQuantity"),
                pagination_group=pagination_group,
                qc_template_source=source,
                source_rows=[
                    {"tableIndex": row["sourceTableIndex"], "rowIndex": row["sourceRowIndex"], "pageNumber": row["pageNumber"]}
                    for row in current_rows
                ],
                control_items=controls,
            )
        )
        current_rows = []

    for row in physical_rows:
        if current_rows and (row["engineeringName"] != current_rows[-1]["engineeringName"] or row["paginationGroup"] != current_rows[-1]["paginationGroup"]):
            flush_group()
        current_rows.append(row)
    flush_group()

    for page in pages:
        page["rows"] = [
            {
                "sourceTableIndex": row["sourceTableIndex"],
                "sourceRowIndex": row["sourceRowIndex"],
                "processStepId": row["processStepId"],
                "fields": row["fields"],
                "controlItems": row["controlItems"],
            }
            for row in page["rows"]
        ]

    return {
        "sourceFile": path.name,
        "pageCount": len(pages),
        "tableCount": len(tables),
        "processStepCount": len(process_steps),
        "controlItemCount": sum(len(step.control_items) for step in process_steps),
        "fieldOrder": FIELD_ORDER,
        "processSteps": [step.to_dict() for step in process_steps],
        "layout": {"orientation": "landscape", "pages": pages},
    }
