from __future__ import annotations

import copy
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET


NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
}
W = "{" + NS["w"] + "}"
MC = "{" + NS["mc"] + "}"


@dataclass(slots=True)
class RawCell:
    index: int
    grid_start: int
    grid_span: int
    lines: list[str]
    text: str
    v_merge: str | None
    width: int | None

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "gridStart": self.grid_start,
            "gridSpan": self.grid_span,
            "lines": self.lines,
            "text": self.text,
            "vMerge": self.v_merge,
            "width": self.width,
        }


@dataclass(slots=True)
class RawRow:
    index: int
    cells: list[RawCell]


@dataclass(slots=True)
class RawTable:
    index: int
    grid_widths: list[int]
    rows: list[RawRow]


@dataclass(slots=True)
class BodyBlock:
    kind: str
    index: int
    text: str = ""
    lines: list[str] | None = None
    element: ET.Element | None = None


def w_attr(element: ET.Element | None, name: str) -> str | None:
    return None if element is None else element.attrib.get(W + name)


def _strip_alternate_fallbacks(root: ET.Element) -> None:
    for alternate in root.findall(".//mc:AlternateContent", NS):
        for child in list(alternate):
            if child.tag == MC + "Fallback":
                alternate.remove(child)


def element_text(element: ET.Element, paragraph_breaks: bool = False) -> str:
    chunks: list[str] = []
    superscript_nodes: set[ET.Element] = set()
    subscript_nodes: set[ET.Element] = set()
    for run in element.findall(".//w:r", NS):
        vertical = run.find("w:rPr/w:vertAlign", NS)
        value = w_attr(vertical, "val")
        if value == "superscript":
            superscript_nodes.update(run.findall(".//w:t", NS))
        elif value == "subscript":
            subscript_nodes.update(run.findall(".//w:t", NS))
    superscript_map = str.maketrans("0123456789+-=()", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾")
    subscript_map = str.maketrans("0123456789+-=()", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎")
    for node in element.iter():
        if node.tag == W + "t":
            text = node.text or ""
            if node in superscript_nodes:
                text = text.translate(superscript_map)
            elif node in subscript_nodes:
                text = text.translate(subscript_map)
            chunks.append(text)
        elif node.tag == W + "tab":
            chunks.append("\t")
        elif node.tag in (W + "br", W + "cr"):
            chunks.append("\n")
        elif paragraph_breaks and node.tag == W + "p" and chunks and not chunks[-1].endswith("\n"):
            chunks.append("\n")
    return clean_text("".join(chunks))


def clean_text(value: str) -> str:
    value = value.replace("\u3000", " ").replace("\xa0", " ")
    value = value.replace("T..W..C", "T.W.C")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    return value.strip()


def paragraph_lines(element: ET.Element) -> list[str]:
    result: list[str] = []
    for paragraph in element.findall(".//w:p", NS):
        text = element_text(paragraph)
        if text:
            result.extend(line for line in text.splitlines() if line.strip())
    return result


class DocxDocument:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        with zipfile.ZipFile(self.path) as archive:
            self.root = ET.fromstring(archive.read("word/document.xml"))
        _strip_alternate_fallbacks(self.root)
        self.body = self.root.find("w:body", NS)
        if self.body is None:
            raise ValueError(f"DOCX has no document body: {self.path}")

    def body_blocks(self) -> list[BodyBlock]:
        blocks: list[BodyBlock] = []
        paragraph_index = 0
        table_index = 0
        for child in self.body:
            if child.tag == W + "p":
                lines = paragraph_lines(child)
                blocks.append(BodyBlock("paragraph", paragraph_index, "\n".join(lines), lines, child))
                paragraph_index += 1
            elif child.tag == W + "tbl":
                blocks.append(BodyBlock("table", table_index, element=child))
                table_index += 1
        return blocks

    def tables(self) -> list[RawTable]:
        tables: list[RawTable] = []
        for table_index, table in enumerate(self.body.findall("w:tbl", NS)):
            grid = table.find("w:tblGrid", NS)
            widths = []
            if grid is not None:
                widths = [int(w_attr(cell, "w") or 0) for cell in grid.findall("w:gridCol", NS)]
            rows: list[RawRow] = []
            for row_index, row in enumerate(table.findall("w:tr", NS)):
                cells: list[RawCell] = []
                grid_start = 0
                for cell_index, cell in enumerate(row.findall("w:tc", NS)):
                    props = cell.find("w:tcPr", NS)
                    grid_span = int(w_attr(None if props is None else props.find("w:gridSpan", NS), "val") or 1)
                    v_merge_node = None if props is None else props.find("w:vMerge", NS)
                    v_merge = None if v_merge_node is None else (w_attr(v_merge_node, "val") or "continue")
                    width_node = None if props is None else props.find("w:tcW", NS)
                    width = int(w_attr(width_node, "w") or 0) if width_node is not None else None
                    lines = paragraph_lines(cell)
                    cells.append(RawCell(cell_index, grid_start, grid_span, lines, "\n".join(lines), v_merge, width))
                    grid_start += grid_span
                rows.append(RawRow(row_index, cells))
            tables.append(RawTable(table_index, widths, rows))
        return tables


def cells_for_range(row: RawRow, start: int, end: int) -> list[RawCell]:
    return [cell for cell in row.cells if cell.grid_start < end and cell.grid_start + cell.grid_span > start]


def distinct_nonempty(values: list[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        cleaned = clean_text(value)
        if cleaned and cleaned not in result and not re.fullmatch(r"-+", cleaned):
            result.append(cleaned)
    return result


def slug(value: str) -> str:
    ascii_slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if ascii_slug:
        return ascii_slug
    return "u" + "-".join(f"{ord(char):x}" for char in value if not char.isspace())
