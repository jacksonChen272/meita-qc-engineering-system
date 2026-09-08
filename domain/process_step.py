from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .control_item import ControlItem
from .source_trace import SourceTrace


@dataclass(slots=True)
class ProcessStep:
    id: str
    name: str
    machines: list[str] = field(default_factory=list)
    operation_standards: list[str] = field(default_factory=list)
    flow_symbol: str = "operation"
    flow_branch: str = "main"
    control_people: list[str] = field(default_factory=list)
    corrective_owners: list[str] = field(default_factory=list)
    sampling_locations: list[str] = field(default_factory=list)
    default_sampling_frequencies: list[str] = field(default_factory=list)
    default_sampling_quantities: list[str] = field(default_factory=list)
    pagination_group: str = "page-1"
    qc_template_source: SourceTrace | None = None
    source_rows: list[dict] = field(default_factory=list)
    control_items: list[ControlItem] = field(default_factory=list)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["control_items"] = [item.to_dict() for item in self.control_items]
        if self.qc_template_source is not None:
            data["qc_template_source"] = self.qc_template_source.to_dict()
        return data
