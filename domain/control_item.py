from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .source_trace import SourceTrace


@dataclass(slots=True)
class ControlItem:
    id: str
    name: str
    standard: str
    chart: str = ""
    sampling_frequency: str = ""
    sampling_quantity: str = ""
    instrument: str = ""
    method: str = ""
    item_details: str = ""
    ccp_oprp: str = "一般"
    classification: str = "FIXED"
    editable: bool = False
    review_required: bool = False
    source: SourceTrace | None = None
    source_table_index: int | None = None
    source_row_index: int | None = None
    source_item_index: int = 0

    def to_dict(self) -> dict:
        data = asdict(self)
        if self.source is not None:
            data["source"] = self.source.to_dict()
        return data
