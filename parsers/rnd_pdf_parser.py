from __future__ import annotations

import re
from pathlib import Path

from domain import SourceTrace

from .docx_utils import clean_text


PAGE_MARKER = re.compile(r"^===PAGE\s+(\d+)===$")
NUMBER = r"[-+]?\d+(?:\.\d+)?"


def _is_sauce_standard(file_name: str, text: str) -> bool:
    source = f"{Path(file_name).stem}\n{text}"
    signals = ["配方與製程", "在產品規格", "製程工程", "成品規格(統萬)", "蕃茄醬"]
    return sum(signal in source for signal in signals) >= 2


def _normalize_sauce_ocr(value: str) -> str:
    """Correct recurring OCR glyph substitutions without inventing values."""
    replacements = {
        "著茄": "蕃茄", "著苟": "蕃茄", "蕃元": "蕃茄", "著元": "蕃茄", "蕃苑": "蕃茄",
        "食覽": "食鹽", "過渡": "過濾", "渡網": "濾網", "水人釜": "水入釜",
        "裝箱和人庫": "裝箱入庫", "溫合均勻": "混合均勻", "漆菌": "殺菌", "殺落": "殺菌",
        "凌達": "美達", "徽菌": "黴菌", "粘度": "黏度",
    }
    result = clean_text(value)
    for before, after in replacements.items():
        result = result.replace(before, after)
    result = re.sub(r"(?<=\d)[一－—](?=\d)", "–", result)
    result = re.sub(r"(?<=\d)[gG](?=\d)", "0", result)
    result = re.sub(r"(?<=\d)\s*[Cc](?=\b|x|×)", "℃", result)
    result = re.sub(r"(?<=\d)\s*[xX]\s*(?=\d+\s*分)", "×", result)
    return result.replace("%%", "%")


def _sauce_lines(text: str) -> list[tuple[int, str]]:
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
        if line == "===OCR===":
            continue
        result.append((page, _normalize_sauce_ocr(line)))
    return result


def _sauce_value(value: str) -> str:
    value = _normalize_sauce_ocr(value)
    value = re.sub(r"^[士十主中生二+]\s*(?=\d)", "±", value)
    return re.sub(r"\s+", " ", value).strip(" |")


def _sauce_formula_amount(value: str) -> str:
    value = _sauce_value(value)
    value = re.sub(r"【\s*g\b", "kg", value, flags=re.I)
    value = re.sub(r"(?<=\d)\s*區\b", " kg", value)
    value = re.sub(r"(?<=\d)\s*LI\b", " L", value, flags=re.I)
    return value.rstrip("》")


def _sauce_section(lines: list[tuple[int, str]], start: int, end: int) -> list[tuple[int, str]]:
    return lines[max(start, 0) : max(start, end)]


def _next_sauce_values(lines: list[tuple[int, str]], index: int, *, max_lines: int = 5) -> tuple[int, list[str]]:
    page = lines[index][0]
    values: list[str] = []
    stop = re.compile(
        r"^(?:pH|D?HH?|NaCl|Bri?x|Brkx|總酸|黏度|內容量|生菌數|酵母|成品規格|使用原料|項目|基準)",
        re.I,
    )
    for _, raw in lines[index + 1 : index + 1 + max_lines]:
        line = _sauce_value(raw)
        if stop.search(line):
            break
        if re.search(r"\d|陰性|以上|以下", line):
            values.append(line)
        if len(values) >= 2:
            break
    return page, values


def _parse_sauce_pdf_text(text: str, file_name: str) -> dict:
    """Parse the scanned/text sauce-pack '配方與製程表' family."""
    lines = _sauce_lines(text)
    flat_lines = [line for _, line in lines]
    complete = "\n".join(flat_lines)
    ocr_source = "===OCR===" in text

    path = Path(file_name)
    product_name = path.stem
    name_index = next((index for index, line in enumerate(flat_lines) if "產品名稱" in line), None)
    if name_index is not None:
        inline = clean_text(re.sub(r"^.*?產品名稱\s*[:：]?", "", flat_lines[name_index]))
        candidate = inline or next((line for line in flat_lines[name_index + 1 : name_index + 4] if "產品代號" not in line), "")
        candidate = re.sub(r"^\d+(?:-\d+)?\s*", "", candidate).strip()
        if candidate:
            product_name = candidate
    product_name = _normalize_sauce_ocr(product_name).replace(".pdf", "")
    code_match = re.search(r"產品代號\s*[:：]?\s*([A-Za-z0-9_-]+)", complete, re.I)
    computer_match = re.search(r"電腦代號\s*[:：]?\s*([0-9/]{6,})", complete)
    gravity_match = re.search(r"產品比重\s*[:：]?\s*([0-9.]+)", complete)
    shelf_match = re.search(r"保存期間\s*[:：]?\s*([^|\n]+)", complete)
    version_match = re.search(r"版\s*(\d+(?:\.\d+)?)", complete)
    date_match = re.search(r"(\d{2,3}\.\d{2}\.\d{2})", complete)
    product = {
        "name": product_name,
        "code": code_match.group(1).upper() if code_match else "",
        "computerCode": computer_match.group(1).replace("/", "") if computer_match else "",
        "specificGravity": gravity_match.group(1) if gravity_match else "",
        "shelfLife": shelf_match.group(1).strip() if shelf_match else "",
        "version": version_match.group(1) if version_match else "",
        "date": date_match.group(1) if date_match else "",
        "sourceFile": path.name,
    }

    parameters: list[dict] = []
    formula_sections = [{"machine": "配方與製程表", "items": []}]
    default_classification = "REVIEW_REQUIRED" if ocr_source else "RND_PARAMETER"

    def add_parameter(
        category: str,
        section: str,
        name: str,
        value: str,
        *,
        page: int = 1,
        process_hint: str = "",
        classification: str | None = None,
        original: str = "",
    ) -> dict:
        record = {
            "id": f"rnd-{len(parameters) + 1:03d}",
            "category": category,
            "section": section,
            "name": clean_text(name),
            "value": _sauce_value(value),
            "unit": "", "lower": "", "upper": "",
            "note": "掃描 PDF OCR，請對照原頁確認" if ocr_source else "",
            "processHint": clean_text(process_hint),
            "classification": classification or default_classification,
            "source": SourceTrace(
                file=file_name, section=section, original_text=original or f"{name} {value}", page_number=page,
            ).to_dict(),
        }
        parameters.append(record)
        return record

    # Formula rows are source evidence only and never overwrite QC fields.
    for index, (page, line) in enumerate(lines):
        if not re.fullmatch(r"[0-9/]{8,11}", line):
            continue
        name = next((candidate for _, candidate in lines[index + 1 : index + 3] if re.search(r"[\u4e00-\u9fff]", candidate)), "")
        amount = next(
            (
                normalized
                for _, candidate in lines[index + 1 : index + 3]
                if re.search(r"\d", candidate)
                and re.search(r"(?:kg|Kg|L|公克|g|【g|區|LI)", candidate, re.I)
                and (normalized := _sauce_formula_amount(candidate))
            ),
            "",
        )
        if not name or not amount:
            continue
        record = add_parameter("formula", "配方與製程表 > 使用原料", name, amount, page=page, original=f"{line} {name} {amount}")
        record["materialCode"] = line.replace("/", "")
        formula_sections[0]["items"].append(record["id"])
    soft_water = next((index for index, line in enumerate(flat_lines) if line == "軟水"), None)
    if soft_water is not None:
        page, values = _next_sauce_values(lines, soft_water, max_lines=3)
        if values:
            amount = _sauce_formula_amount(values[0])
            record = add_parameter("formula", "配方與製程表 > 使用原料", "軟水", amount, page=page, original=f"軟水 {values[0]}")
            formula_sections[0]["items"].append(record["id"])

    headings = [index for index, line in enumerate(flat_lines) if re.search(r"成品規格", line)]
    in_product_start = next((index for index, line in enumerate(flat_lines) if "在產品規格" in line), 0)
    in_product_end = headings[0] if headings else len(lines)
    internal_start = headings[0] if headings else len(lines)
    customer_start = headings[1] if len(headings) > 1 else len(lines)

    item_patterns = [
        ("pH值", re.compile(r"^(?:pH|DH|DHH)$", re.I)),
        ("鹽度", re.compile(r"^NaCl", re.I)),
        ("糖度", re.compile(r"^(?:Brix|Brx|Brkx)$", re.I)),
        ("酸度", re.compile(r"^總酸", re.I)),
        ("黏度", re.compile(r"^黏度")),
        ("內容量", re.compile(r"^內容量")),
        ("總生菌數", re.compile(r"^生菌數")),
        ("黴菌、酵母菌", re.compile(r"^酵母.*黴菌")),
    ]

    def add_specs(section_lines: list[tuple[int, str]], category: str, section_name: str, allowed: set[str]) -> None:
        for index, (page, line) in enumerate(section_lines):
            definition = next(((name, pattern) for name, pattern in item_patterns if name in allowed and pattern.search(line)), None)
            if not definition:
                continue
            name, _ = definition
            inline_value = "陰性" if "陰性" in line else ""
            _, values = _next_sauce_values(section_lines, index)
            if inline_value:
                values = [inline_value]
            elif not values:
                backwards = [
                    _sauce_value(candidate)
                    for _, candidate in section_lines[max(0, index - 4) : index]
                    if re.search(r"\d|陰性|以上|以下", candidate)
                ]
                values = backwards[-2:]
            if not values:
                continue
            value = values[0]
            if len(values) > 1:
                tail = values[1]
                if re.match(r"^[±士十主中生二+]", tail):
                    value = f"{value}{_sauce_value(tail)}"
                elif tail in {"以上", "以下"}:
                    value = f"{value} {tail}"
            process_hint = "半成品檢驗" if category == "half_finished" else "成品檢驗"
            category_name = category
            if name == "內容量":
                category_name = "filling"
                process_hint = "內容量檢查"
            add_parameter(category_name, section_name, name, value, page=page, process_hint=process_hint, original=f"{line} {' '.join(values)}")

    add_specs(
        _sauce_section(lines, in_product_start, in_product_end), "half_finished",
        "配方與製程表 > 在產品規格", {"pH值", "鹽度", "糖度", "酸度", "黏度"},
    )
    add_specs(
        _sauce_section(lines, internal_start, customer_start), "finished",
        "配方與製程表 > 成品規格（美達）", {"內容量", "總生菌數", "黴菌、酵母菌"},
    )
    add_specs(
        _sauce_section(lines, customer_start, len(lines)), "finished",
        "配方與製程表 > 成品規格（客戶）", {"pH值", "鹽度", "糖度", "酸度"},
    )

    def add_regex_parameter(pattern: str, category: str, name: str, process_hint: str, formatter) -> None:
        match = re.search(pattern, complete, re.I)
        if match:
            add_parameter(
                category, "配方與製程表 > 製程工程", name, formatter(match), page=1,
                process_hint=process_hint, original=match.group(0),
            )

    add_regex_parameter(
        r"(?<!定量後)加熱至\s*(\d{2,3})\s*[℃Cc]?\s*沸", "workflow", "溫度", "蕃茄糊、特砂、食鹽溶解",
        lambda match: f"{match.group(1)}℃",
    )
    add_regex_parameter(
        r"定量後加熱至\s*(\d{2,3})\s*[℃Cc]?\s*沸", "workflow", "溫度", "加入澱粉水定量關蒸氣",
        lambda match: f"{match.group(1)}℃",
    )
    add_regex_parameter(
        r"冷卻\s+(\d{2,3})\s*[~～\-–]\s*(\d{2,3})\s*℃?", "workflow", "溫度", "調配液自然冷卻",
        lambda match: f"{match.group(1)}–{match.group(2)}℃",
    )
    add_regex_parameter(
        r"(\d{1,3})\s*mesh\s*濾網", "filling", "濾網規格", "過濾",
        lambda match: f"{match.group(1)} mesh",
    )
    add_regex_parameter(
        r"充填包裝\s+(\d{2,3})\s*[~～\-–]\s*(\d{2,3})\s*℃?", "filling", "充填溫度", "充填",
        lambda match: f"{match.group(1)}–{match.group(2)}℃",
    )
    sterilization = re.search(r"水溫\s*(\d{2,3})\s*[~～\-–]\s*(\d{2,3})\s*℃?\s*[xX×]\s*(\d+)\s*分", complete, re.I)
    if sterilization:
        add_parameter(
            "sterilization", "配方與製程表 > 製程工程", "殺菌水溫",
            f"{sterilization.group(1)}–{sterilization.group(2)}℃", process_hint="水淋式殺菌", original=sterilization.group(0),
        )
        add_parameter(
            "sterilization", "配方與製程表 > 製程工程", "殺菌時間",
            f"{sterilization.group(3)} 分鐘", process_hint="水淋式殺菌", original=sterilization.group(0),
        )

    history = []
    if product["version"] or product["date"]:
        history.append({
            "date": product["date"], "version": product["version"], "change": "原外來文件制定資料",
            "source": SourceTrace(file_name, "制定／修訂欄", f"版{product['version']} {product['date']}", page_number=1).to_dict(),
        })

    return {
        "product": product, "history": history, "machines": [], "formulaSections": formula_sections,
        "workflowBlocks": [], "parameterCount": len(parameters), "parameters": parameters,
        "parserProfile": "sauce_pack", "extractionMode": "ocr" if ocr_source else "text",
    }


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
    if _is_sauce_standard(file_name, text):
        return _parse_sauce_pdf_text(text, file_name)

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
