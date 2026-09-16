from __future__ import annotations

import re
from pathlib import Path

from domain import SourceTrace

from .docx_utils import clean_text


PAGE_MARKER = re.compile(r"^===PAGE\s+(\d+)===$")
NUMBER = r"[-+]?\d+(?:\.\d+)?"


def _metadata(file_name: str, text: str) -> dict:
    path = Path(file_name)
    first_line = next((clean_text(line) for line in text.splitlines() if clean_text(line) and not PAGE_MARKER.match(clean_text(line))), path.stem)
    source = f"{path.stem} {first_line}"
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


def _page_lines(text: str) -> list[tuple[int, str]]:
    page = 1
    result: list[tuple[int, str]] = []
    for raw_line in text.splitlines():
        line = clean_text(raw_line)
        if not line:
            continue
        marker = PAGE_MARKER.match(line)
        if marker:
            page = int(marker.group(1))
            continue
        if re.fullmatch(r"\d{1,3}", line):
            continue
        result.append((page, line))
    return result


def _slice(lines: list[tuple[int, str]], start_pattern: str, end_pattern: str | None = None) -> list[tuple[int, str]]:
    start = next((index for index, (_, line) in enumerate(lines) if re.search(start_pattern, line)), None)
    if start is None:
        return []
    end = len(lines)
    if end_pattern:
        end = next((index for index in range(start + 1, len(lines)) if re.search(end_pattern, lines[index][1])), len(lines))
    return lines[start + 1 : end]


def _format_value(lower: str, upper: str, unit: str) -> str:
    lower, upper, unit = clean_text(lower), clean_text(upper), clean_text(unit)
    value = f"{lower}–{upper}" if lower and upper else lower or upper
    return f"{value} {unit}".strip()


def _table_row(line: str, item_names: list[str]) -> tuple[str, str, str, str, str] | None:
    name = next((item for item in sorted(item_names, key=len, reverse=True) if line.startswith(item)), None)
    if not name:
        return None
    remainder = clean_text(line[len(name) :])
    units = ["mg/100 g", "mg/100g", "cm Hg", "cmHg", "20°C %", "20℃ %", "cps", "mL", "mm", "℃", "°C", "%", "g"]
    unit = next((candidate for candidate in units if remainder.startswith(candidate)), "")
    if unit:
        remainder = clean_text(remainder[len(unit) :])
    values = list(re.finditer(NUMBER, remainder))
    if values:
        lower = values[0].group(0)
        upper = values[1].group(0) if len(values) > 1 else ""
        note_start = values[1].end() if len(values) > 1 else values[0].end()
        note = clean_text(remainder[note_start:])
        return name, unit, lower, upper, note
    return name, unit, remainder, "", ""


def parse_rnd_pdf_text(text: str, file_name: str) -> dict:
    """Parse text extracted from a PDF version of the controlled R&D standard."""
    lines = _page_lines(text)
    product = _metadata(file_name, text)
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
        page: int | None = None,
        unit: str = "",
        lower: str = "",
        upper: str = "",
        note: str = "",
        process_hint: str = "",
        classification: str = "RND_PARAMETER",
        original: str = "",
    ) -> dict:
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
            "source": SourceTrace(
                file=file_name,
                section=section,
                original_text=original or f"{name} {value}",
                page_number=page,
            ).to_dict(),
        }
        parameters.append(record)
        return record

    for page, line in lines:
        match = re.match(r"^(20\d{2}\.\d{1,2}\.\d{1,2}(?:-\d+)?)\s+(?:(\d+\.\d+)\s+)?(.+)$", line)
        if match and page <= 2:
            history.append(
                {
                    "date": match.group(1),
                    "version": match.group(2) or "",
                    "change": match.group(3),
                    "source": SourceTrace(file_name, "版本履歷", line, page_number=page).to_dict(),
                }
            )

    formula_lines = _slice(lines, r"^配方表$", r"液體營養品作業流程|作業流程$")
    machine_names = {"二重釜", "溶糖機", "溶奶機", "冰沙機", "冰沙機-1", "溶解桶", "均質機", "調配桶"}
    current_machine = ""
    for page, line in formula_lines:
        if line in machine_names:
            current_machine = line
            formula_sections.append({"machine": current_machine, "items": []})
            continue
        if line.startswith(("原料 供應商", "*配方表水量計算")):
            continue
        if "AF_" in line and re.search(r"20\d{2}\.\d{2}\.\d{2}$", line):
            continue
        simple = re.match(r"^(水量|總共)\s+(.+)$", line)
        row = re.match(r"^(.+?)\s+(\S+)\s+([0-9.]+(?:\s*\*\s*[0-9.]+)?)$", line)
        if simple:
            name, supplier, raw_value = simple.group(1), "", simple.group(2)
        elif row:
            name, supplier, raw_value = row.group(1), row.group(2), row.group(3).replace(" ", "")
        else:
            continue
        unit = "L" if name in {"水量", "總共"} else "kg/2000 L"
        value = raw_value if name in {"水量", "總共"} else f"{raw_value} kg/2000 L"
        record = add_parameter(
            "formula",
            f"配方表 > {current_machine or '彙總'}",
            name,
            value,
            unit=unit,
            process_hint=current_machine,
            page=page,
            original=line,
        )
        record["supplier"] = supplier
        if not formula_sections or formula_sections[-1]["machine"] != (current_machine or "彙總"):
            formula_sections.append({"machine": current_machine or "彙總", "items": []})
        formula_sections[-1]["items"].append(record["id"])

    complete_text = "\n".join(line for _, line in lines)
    workflow_match = re.search(r"(.+液體營養品作業流程)(.*?)(?=充填及殺菌)", complete_text, re.S)
    workflow_text = workflow_match.group(0) if workflow_match else ""
    workflow_machines = []
    for machine in re.findall(r"【([^】]+)】", workflow_text):
        machine = clean_text(machine).replace("KOH", "")
        if machine and machine not in workflow_machines:
            workflow_machines.append(machine)
            workflow_blocks.append(
                {
                    "machine": machine,
                    "text": workflow_text,
                    "source": SourceTrace(file_name, f"作業流程 > 【{machine}】", workflow_text, page_number=5).to_dict(),
                }
            )

    workflow_patterns = [
        ("均質壓力第一段", r"均質壓力第一段\s*(" + NUMBER + r"\s*±\s*" + NUMBER + r"\s*bar)"),
        ("均質壓力第二段", r"第二段\s*(" + NUMBER + r")"),
        ("均質溫度", r"溫度\s*(" + NUMBER + r"\s*±\s*" + NUMBER + r"\s*°?C)"),
    ]
    for name, pattern in workflow_patterns:
        match = re.search(pattern, workflow_text, re.I)
        if match:
            value = f"{match.group(1)} bar" if name == "均質壓力第二段" else match.group(1)
            add_parameter("workflow", "作業流程 > 【均質機】", name, value, process_hint="調配液均質", page=5, original=match.group(0))

    filling_lines = _slice(lines, r"^1\.\s*充填條件$", r"^2\.\s*殺菌包裝條件$")
    for page, line in filling_lines:
        match = re.match(r"^(濾網規格|罐中心溫度|均質壓力|填充量)\s+(.+)$", line)
        if not match:
            continue
        name, value = match.groups()
        if name == "均質壓力":
            parts = re.split(r"[/／]", value, maxsplit=1)
            add_parameter("filling", "充填及殺菌 > 充填條件", "均質壓力", parts[0], process_hint="加熱均質", page=page, original=line)
            if len(parts) > 1:
                add_parameter("filling", "充填及殺菌 > 充填條件", "均質溫度", parts[1], process_hint="加熱均質", page=page, original=line)
        else:
            add_parameter("filling", "充填及殺菌 > 充填條件", name, value, process_hint=name, page=page, original=line)

    sterilization_lines = _slice(lines, r"^2\.\s*殺菌包裝條件$", r"^產品檢驗標準$")
    rotation_started = False
    for page, line in sterilization_lines:
        match = re.match(r"^(昇溫時間|上釜溫度|殺菌溫度|殺菌時間|保存期限)\s+(.+)$", line)
        if match:
            name, value = match.groups()
            add_parameter(
                "sterilization",
                "充填及殺菌 > 殺菌包裝條件",
                name,
                value,
                process_hint="殺菌",
                page=page,
                original=line,
                classification="REVIEW_REQUIRED" if name == "上釜溫度" and value.upper() == "X" else "RND_PARAMETER",
            )
            continue
        rotation = re.match(r"^(?:旋轉速度\s+)?(昇溫|殺菌|冷卻)\s+(.+rpm)$", line, re.I)
        if rotation:
            rotation_started = True
            stage, value = rotation.groups()
            add_parameter("sterilization", "充填及殺菌 > 殺菌包裝條件", f"旋轉速度-{stage}", value, process_hint="冷卻" if stage == "冷卻" else "殺菌", page=page, original=line)
        elif rotation_started and line.startswith("旋轉速度"):
            continue

    half_items = ["pH 值", "比重", "脂肪", "維生素 C", "黏度", "溫度", "水分", "糖度"]
    half_lines = _slice(lines, r"^1\.\s*半成品", r"標準書編號：?10-0209-013")
    for page, line in half_lines:
        parsed = _table_row(line, half_items)
        if not parsed:
            continue
        name, unit, lower, upper, note = parsed
        record = add_parameter(
            "half_finished",
            "產品檢驗標準 > 半成品（調配桶）",
            name,
            _format_value(lower, upper, unit),
            unit=unit,
            lower=lower,
            upper=upper,
            note=note,
            process_hint="半成品檢測",
            page=page,
            original=line,
        )
        record["standardNumber"] = "10-0209-013"

    finished_items = ["真空度", "pH 值", "內容量-重量", "Brix", "脂肪", "黏度", "容積", "上部空隙", "維生素 C", "水分", "色澤", "香氣", "口味", "雜質", "罐內壁"]
    finished_lines = _slice(lines, r"^2\.\s*成品規格", r"標準書編號：?10-0209-014")
    for page, line in finished_lines:
        parsed = _table_row(line, finished_items)
        if not parsed:
            continue
        name, unit, lower, upper, note = parsed
        locked = "不能修改" in line
        record = add_parameter(
            "finished",
            "產品檢驗標準 > 成品規格（內規）",
            name,
            _format_value(lower, upper, unit),
            unit=unit,
            lower=lower,
            upper=upper,
            note=note,
            process_hint="成品開罐",
            page=page,
            original=line,
            classification="LOCKED" if locked else "RND_PARAMETER",
        )
        record["standardNumber"] = "10-0209-014"

    incubation_lines = _slice(lines, r"^3\.\s*保溫試驗及微生物檢驗", r"^4\.\s*COA")
    for page, line in incubation_lines:
        if line.startswith(("項目 ", "條件")):
            continue
        if line.startswith("微生物檢驗"):
            name, value = "微生物檢驗", clean_text(line[len("微生物檢驗") :])
        else:
            value = clean_text(re.sub(r"^保溫試驗\s*", "", line))
            if not re.search(r"\d+\s*℃", value):
                continue
            name = f"保溫試驗-{re.sub(r'[、，, ]+', '/', value).strip('/')}"
        add_parameter(
            "incubation",
            "產品檢驗標準 > 保溫試驗及微生物檢驗",
            name,
            value,
            process_hint="保溫試驗",
            page=page,
            original=line,
            classification="RND_PARAMETER" if name.startswith("保溫試驗-") and "37" in value and "10" in value else "REVIEW_REQUIRED",
        )

    coa_items = ["淨重(公克)", "比重", "水分 (%)", "蛋白質 (%)", "脂肪 (%)", "維生素 C (mg/100g)", "pH", "黏度 (cps)", "可溶性固形物 (%)", "真空度 (cmHg)", "色澤", "風味"]
    coa_lines = _slice(lines, r"^4\.\s*COA", None)
    for page, line in coa_lines:
        if line.startswith("成品檢查"):
            continue
        if line.startswith("品質/"):
            add_parameter("coa", "COA 開立", "品質/液態流質、無顆粒結塊、無異物、無懸浮物", "無", page=page, original=line)
            continue
        name = next((item for item in sorted(coa_items, key=len, reverse=True) if line.startswith(item)), None)
        if name:
            value = clean_text(line[len(name) :]).replace(" ~ ", "–").replace("~", "–")
            add_parameter("coa", "COA 開立", name, value, page=page, original=line)

    machines = []
    for section in formula_sections:
        machine = section["machine"]
        if machine and machine != "彙總" and machine not in machines:
            machines.append(machine)
    for machine in workflow_machines:
        if machine not in machines:
            machines.append(machine)

    return {
        "product": product,
        "history": history,
        "machines": machines,
        "formulaSections": formula_sections,
        "workflowBlocks": workflow_blocks,
        "parameterCount": len(parameters),
        "parameters": parameters,
    }
