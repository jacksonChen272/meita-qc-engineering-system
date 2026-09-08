from __future__ import annotations

from templates import QC_COLUMN_GROUPS, QC_COLUMNS

from .flow_renderer import build_flow_model
from .pagination import validate_pagination


def build_preview_model(qc: dict, diff: dict, rnd: dict | None = None) -> dict:
    proposed_by_control = {
        record["controlItemId"]: record["proposedValue"]
        for record in diff["records"]
        if record.get("controlItemId") and record["status"] in {"SAME", "CHANGED", "LOCKED"}
    }
    product = (rnd or {}).get("product", {})
    product_name = product.get("name") or "待人工確認產品"
    return {
        "documentHeader": {
            "title": f"{product_name} QC 工程圖",
            "category": "品質管制標準書",
            "documentNumber": "待人工確認",
            "scope": "生產二課",
            "symbolLegend": ["□開始", "○操作", "◇檢查", "→搬運", "▽貯存", "D 結束流程"],
        },
        "columnGroups": QC_COLUMN_GROUPS,
        "columns": [{"key": key, "label": label} for key, label in QC_COLUMNS],
        "pages": qc["layout"]["pages"],
        "proposedByControlItem": proposed_by_control,
        "flow": build_flow_model(qc),
        "pagination": validate_pagination(qc),
    }
