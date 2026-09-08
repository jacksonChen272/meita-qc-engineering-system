from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(slots=True)
class SourceTrace:
    file: str
    section: str
    original_text: str
    page_number: int | None = None
    table_index: int | None = None
    row_index: int | None = None
    cell_index: int | None = None

    def to_dict(self) -> dict:
        data = asdict(self)
        return {key: value for key, value in data.items() if value is not None}
