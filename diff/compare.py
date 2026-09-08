from __future__ import annotations

from collections import Counter

from .normalize import align_display_value, normalize_incubation, values_equal


TARGET_MISSING_RULES = {
    "半成品檢測": "all",
    "成品開罐": "all",
    "保溫試驗": "all",
}


def _index(qc: dict, rnd: dict) -> tuple[dict, dict, dict]:
    parameters = {item["id"]: item for item in rnd["parameters"]}
    processes = {step["id"]: step for step in qc["processSteps"]}
    controls = {item["id"]: (step, item) for step in qc["processSteps"] for item in step["control_items"]}
    return parameters, processes, controls


def _default_decision(status: str) -> str:
    if status in {"SAME", "CHANGED", "LOCKED"}:
        return "USE_RND"
    if status == "MISSING_RND":
        return "KEEP_TEMPLATE"
    return "PENDING_REVIEW"


def _record_id(records: list[dict]) -> str:
    return f"diff-{len(records) + 1:03d}"


def build_diff(qc: dict, rnd: dict, mapping: dict) -> dict:
    parameters, processes, controls = _index(qc, rnd)
    records: list[dict] = []
    mapped_control_ids: set[str] = set()

    for item in mapping["mappings"]:
        kind = item["mappingKind"]
        if kind == "SOURCE_ONLY":
            continue
        parameter = parameters[item["rndParameterId"]]
        process = processes.get(item.get("targetProcessId"))
        target_control = controls.get(item.get("targetControlItemId"))
        control = None if target_control is None else target_control[1]
        template_value = ""
        if control is not None:
            template_value = control["standard"]
            mapped_control_ids.add(control["id"])
        elif kind == "PROCESS_FIELD" and process is not None:
            template_value = " / ".join(process.get("machines", []))

        raw_rnd_value = parameter["value"]
        rnd_value = align_display_value(template_value, raw_rnd_value)
        classification = parameter.get("classification", "RND_PARAMETER")
        protection = "一般" if control is None else control.get("ccp_oprp", "一般")

        if kind == "NEW_RND":
            status = "NEW_RND"
            proposed = ""
        elif kind == "REVIEW_REQUIRED" or item.get("forceReview") or classification == "REVIEW_REQUIRED":
            status = "REVIEW_REQUIRED"
            classification = "REVIEW_REQUIRED" if classification != "LOCKED" else classification
            proposed = template_value
        elif classification == "LOCKED":
            status = "LOCKED"
            proposed = rnd_value
        else:
            equal = normalize_incubation(template_value) == normalize_incubation(raw_rnd_value) if kind == "PROCESS_FIELD" else values_equal(template_value, raw_rnd_value)
            if equal:
                status = "SAME"
                proposed = template_value if kind == "PROCESS_FIELD" and process and process["name"] == "保溫試驗" else rnd_value
            elif protection in {"CCP", "OPRP"}:
                status = "REVIEW_REQUIRED"
                classification = "FIXED"
                proposed = template_value
            else:
                status = "CHANGED"
                proposed = rnd_value

        record = {
            "id": _record_id(records),
            "processId": item.get("targetProcessId"),
            "process": item.get("targetProcessName") or parameter.get("processHint") or "未對應研發參數",
            "controlItemId": item.get("targetControlItemId"),
            "controlItem": item.get("targetControlItemName") or parameter["name"],
            "templateValue": template_value,
            "rndValue": rnd_value,
            "proposedValue": proposed,
            "classification": classification,
            "status": status,
            "protectionLevel": protection,
            "source": parameter["source"],
            "templateSource": None if control is None else control.get("source"),
            "mappingReason": item["reason"],
            "mappingConfidence": item["confidence"],
            "decision": "KEEP_TEMPLATE" if kind == "PROCESS_FIELD" and process and process["name"] == "保溫試驗" else _default_decision(status),
            "editable": status == "CHANGED" and protection == "一般",
        }
        records.append(record)

    # Context-sensitive candidates that deliberately cannot be auto-applied.
    half_temperature = next((p for p in rnd["parameters"] if p["category"] == "half_finished" and p["name"] == "溫度"), None)
    if half_temperature:
        for process_name in ("冷卻", "定量調配貯存"):
            step = next((s for s in qc["processSteps"] if s["name"] == process_name and s["pagination_group"] == "page-2"), None)
            control = None if step is None else next((c for c in step["control_items"] if "溫度" in c["name"]), None)
            if step and control and control["id"] not in mapped_control_ids:
                # The unit is already part of the control-item name (for example 溫度(℃)).
                # Do not surface a review card when the numeric value is identical and the
                # only visible difference is that R&D repeats the unit in the value.
                if values_equal(control["standard"], half_temperature["value"]):
                    mapped_control_ids.add(control["id"])
                    continue
                mapped_control_ids.add(control["id"])
                records.append(
                    {
                        "id": _record_id(records),
                        "processId": step["id"],
                        "process": step["name"],
                        "controlItemId": control["id"],
                        "controlItem": control["name"],
                        "templateValue": control["standard"],
                        "rndValue": half_temperature["value"],
                        "proposedValue": control["standard"],
                        "classification": "CONDITIONAL",
                        "status": "REVIEW_REQUIRED",
                        "protectionLevel": control.get("ccp_oprp", "一般"),
                        "source": half_temperature["source"],
                        "templateSource": control.get("source"),
                        "mappingReason": "半成品檢測溫度與冷卻/貯存操作標準不同，且製程語意需要人工確認。",
                        "mappingConfidence": "AMBIGUOUS_CONTEXT",
                        "decision": "PENDING_REVIEW",
                        "editable": False,
                    }
                )

    # Only RND-addressable template items become MISSING_RND; fixed plant controls remain fixed.
    missing_candidates: list[tuple[dict, dict]] = []
    for step in qc["processSteps"]:
        if step["name"] in TARGET_MISSING_RULES:
            missing_candidates.extend((step, control) for control in step["control_items"])
        elif step["name"] == "過濾" and step["pagination_group"] == "page-2":
            missing_candidates.extend((step, control) for control in step["control_items"] if "濾網" in control["name"])
        elif step["name"] == "加熱" and step["pagination_group"] == "page-3":
            missing_candidates.extend((step, control) for control in step["control_items"] if "充填溫度" in control["name"])
        elif step["name"] == "冷卻" and step["pagination_group"] == "page-4":
            missing_candidates.extend((step, control) for control in step["control_items"])

    for step, control in missing_candidates:
        if control["id"] in mapped_control_ids:
            continue
        mapped_control_ids.add(control["id"])
        records.append(
            {
                "id": _record_id(records),
                "processId": step["id"],
                "process": step["name"],
                "controlItemId": control["id"],
                "controlItem": control["name"],
                "templateValue": control["standard"],
                "rndValue": "",
                "proposedValue": control["standard"],
                "classification": "RND_PARAMETER",
                "status": "MISSING_RND",
                "protectionLevel": control.get("ccp_oprp", "一般"),
                "source": None,
                "templateSource": control.get("source"),
                "mappingReason": "母版有此產品/製程參數，但研發文件沒有同一語意的有效數值。",
                "mappingConfidence": "NO_SOURCE",
                "decision": "KEEP_TEMPLATE",
                "editable": False,
            }
        )

    # Fixed template fields are visible in the full mapping without inflating missing counts.
    for step in qc["processSteps"]:
        for control in step["control_items"]:
            if control["id"] in mapped_control_ids:
                continue
            records.append(
                {
                    "id": _record_id(records),
                    "processId": step["id"],
                    "process": step["name"],
                    "controlItemId": control["id"],
                    "controlItem": control["name"],
                    "templateValue": control["standard"],
                    "rndValue": "",
                    "proposedValue": control["standard"],
                    "classification": "FIXED",
                    "status": "SAME",
                    "protectionLevel": control.get("ccp_oprp", "一般"),
                    "source": None,
                    "templateSource": control.get("source"),
                    "mappingReason": "廠內固定 QC 欄位，沿用母版，不要求研發文件提供。",
                    "mappingConfidence": "FIXED_TEMPLATE",
                    "decision": "KEEP_TEMPLATE",
                    "editable": False,
                }
            )

    status_counts = Counter(record["status"] for record in records)
    class_counts = Counter(record["classification"] for record in records)
    ordered_statuses = ["SAME", "CHANGED", "REVIEW_REQUIRED", "LOCKED", "MISSING_RND", "NEW_RND"]
    return {
        "summary": {status: status_counts.get(status, 0) for status in ordered_statuses},
        "classificationSummary": {name: class_counts.get(name, 0) for name in ["FIXED", "RND_PARAMETER", "CONDITIONAL", "REVIEW_REQUIRED", "LOCKED"]},
        "recordCount": len(records),
        "records": records,
    }
