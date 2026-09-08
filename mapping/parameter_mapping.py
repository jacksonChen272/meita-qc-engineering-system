from __future__ import annotations

import re


def canonical_item(value: str) -> str:
    value = value.replace("水份", "水分").replace("％", "%")
    value = value.replace("維生素 C", "維生素C").replace("pH 值", "pH").replace("pH值", "pH")
    value = value.replace("內容量-重量", "內容量").replace("淨重", "內容量")
    value = re.sub(r"\([^)]*\)", "", value)
    value = re.sub(r"[\s%％/（）()°℃._-]+", "", value).lower()
    if "brix" in value or "可溶性固形物" in value or value == "糖度":
        return "糖度"
    if "維生素c" in value:
        return "維生素c"
    if value.startswith("ph"):
        return "ph"
    if "濾網" in value:
        return "濾網大小"
    if "中心溫度" in value:
        return "中心溫度"
    if "全重" in value:
        return "全重"
    return value


def _steps(qc: dict, name: str, page: int | None = None) -> list[dict]:
    return [
        step
        for step in qc["processSteps"]
        if step["name"] == name and (page is None or step["pagination_group"] == f"page-{page}")
    ]


def _control(step: dict | None, item_name: str) -> dict | None:
    if step is None:
        return None
    canonical = canonical_item(item_name)
    exact = [item for item in step["control_items"] if canonical_item(item["name"]) == canonical]
    if exact:
        return exact[0]
    contains = [item for item in step["control_items"] if canonical in canonical_item(item["name"]) or canonical_item(item["name"]) in canonical]
    return contains[0] if len(contains) == 1 else None


def map_parameters(rnd: dict, qc: dict) -> dict:
    results: list[dict] = []

    def add(parameter: dict, step: dict | None, control: dict | None, *, confidence: str = "EXACT", reason: str, force_review: bool = False, mapping_kind: str = "CONTROL_ITEM") -> None:
        results.append(
            {
                "rndParameterId": parameter["id"],
                "rndCategory": parameter["category"],
                "rndName": parameter["name"],
                "targetProcessId": None if step is None else step["id"],
                "targetProcessName": None if step is None else step["name"],
                "targetControlItemId": None if control is None else control["id"],
                "targetControlItemName": parameter["name"] if control is None else control["name"],
                "mappingKind": mapping_kind,
                "confidence": confidence,
                "forceReview": force_review,
                "reason": reason,
            }
        )

    for parameter in rnd["parameters"]:
        category = parameter["category"]
        name = parameter["name"]
        canonical = canonical_item(name)

        if category in {"formula", "coa"}:
            results.append(
                {
                    "rndParameterId": parameter["id"],
                    "rndCategory": category,
                    "rndName": name,
                    "targetProcessId": None,
                    "targetProcessName": None,
                    "targetControlItemId": None,
                    "targetControlItemName": None,
                    "mappingKind": "SOURCE_ONLY",
                    "confidence": "NOT_APPLICABLE",
                    "forceReview": False,
                    "reason": "保留為來源資料；配方/COA 不直接覆寫 QC 欄位。",
                }
            )
            continue

        if category == "half_finished":
            step = _steps(qc, "半成品檢測")[0]
            add(parameter, step, _control(step, name), reason="同一研發章節與同名半成品管制項目。")
            continue

        if category == "finished":
            step = _steps(qc, "成品開罐")[0]
            add(parameter, step, _control(step, name), reason="同一研發章節與同名成品開罐管制項目。")
            incubation_step = _steps(qc, "保溫試驗", 6)[0]
            incubation_control = _control(incubation_step, name)
            if incubation_control is not None:
                add(parameter, incubation_step, incubation_control, reason="保溫試驗的對應檢測值沿用同一份成品規格。")
            continue

        if category == "workflow":
            step = _steps(qc, "調配液均質")[0]
            if name == "均質壓力第一段":
                add(parameter, step, _control(step, "壓力"), reason="研發作業流程明示第一段均質壓力。")
            elif name == "均質溫度":
                add(parameter, step, _control(step, "溫度"), reason="研發作業流程明示均質溫度。")
            else:
                add(parameter, step, None, confidence="UNMAPPED", reason="母版沒有第二段均質壓力欄位。", mapping_kind="NEW_RND")
            continue

        if category == "filling":
            if name == "濾網規格":
                step = _steps(qc, "過濾", 3)[0]
                add(parameter, step, _control(step, "濾網大小"), reason="充填條件的濾網規格對應充填區過濾製程。")
            elif name == "罐中心溫度":
                step = _steps(qc, "充填中心溫度檢查", 3)[0]
                add(parameter, step, _control(step, "中心溫度"), reason="同名充填中心溫度欄位。")
            elif name in {"均質壓力", "均質溫度"}:
                step = _steps(qc, "加熱均質", 3)[0]
                add(parameter, step, _control(step, "壓力" if name == "均質壓力" else "均質溫度"), reason="充填條件的均質壓力/溫度對應充填區加熱均質。")
            elif name == "填充量":
                step = _steps(qc, "內容量檢查", 4)[0]
                add(parameter, step, _control(step, "全重"), reason="研發原文明示含空罐重，只能對應母版全重，不能對應內容量。")
                liquid_step = _steps(qc, "液位檢測", 4)[0]
                add(parameter, liquid_step, _control(liquid_step, "內容量"), confidence="AMBIGUOUS", reason="母版雖註記全重，但液位打檢設定值不是靜態填充重量規格。", force_review=True)
            continue

        if category == "sterilization":
            kill_step = _steps(qc, "殺菌", 4)[0]
            if name == "昇溫時間":
                add(parameter, kill_step, _control(kill_step, "昇溫時間"), reason="同一殺菌製程的升溫時間。")
            elif name == "上釜溫度":
                add(parameter, kill_step, _control(kill_step, "上釜水溫"), confidence="INVALID_VALUE", reason="欄位可對應，但研發值為 X，沒有有效數值。", force_review=True)
            elif name == "殺菌溫度":
                add(parameter, kill_step, _control(kill_step, "溫度"), reason="同一殺菌製程的殺菌溫度。")
            elif name == "殺菌時間":
                add(parameter, kill_step, _control(kill_step, "時間"), reason="同一殺菌製程的殺菌時間。")
            elif name == "旋轉速度-殺菌":
                add(parameter, kill_step, _control(kill_step, "轉速"), reason="同一殺菌階段的旋轉速度。")
            elif name == "旋轉速度-冷卻":
                cool_step = _steps(qc, "冷卻", 4)[0]
                add(parameter, cool_step, _control(cool_step, "轉速"), confidence="CONDITIONAL", reason="母版要求依操作指示書，研發給出 8 rpm，需人工確認可否回寫。", force_review=True)
            elif name in {"旋轉速度-昇溫", "保存期限"}:
                add(parameter, kill_step, None, confidence="UNMAPPED", reason="母版沒有對應的獨立欄位。", mapping_kind="NEW_RND")
            continue

        if category == "incubation":
            step = _steps(qc, "保溫試驗", 6)[0]
            if name.startswith("保溫試驗-") and "37" in parameter["value"] and "10" in parameter["value"]:
                add(parameter, step, None, reason="母版設備欄明示保溫箱 37℃（10天）。", mapping_kind="PROCESS_FIELD")
            else:
                add(parameter, step, None, confidence="NO_EXACT_FIELD", reason="研發條件在母版沒有完整對應欄位，禁止自行增刪。", force_review=True, mapping_kind="REVIEW_REQUIRED")

    auto_mapped = [item for item in results if item["mappingKind"] in {"CONTROL_ITEM", "PROCESS_FIELD"} and item["confidence"] == "EXACT"]
    return {
        "parameterCount": len(rnd["parameters"]),
        "autoMappedCount": len(auto_mapped),
        "mappingCount": len(results),
        "mappings": results,
    }
