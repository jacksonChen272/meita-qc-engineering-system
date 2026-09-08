from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .process_step import ProcessStep


@dataclass(slots=True)
class Product:
    name: str
    code: str
    version: str
    date: str
    source_file: str
    process_steps: list[ProcessStep] = field(default_factory=list)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["process_steps"] = [step.to_dict() for step in self.process_steps]
        return data
