from __future__ import annotations

import re
import unicodedata


_PROTECTION_RE = re.compile(r"\((?:CCP|OPRP)\)", re.IGNORECASE)
_DISPLAY_UNIT_RE = re.compile(
    r"(?ix)"
    r"\s*(?:"
    r"mg\s*/\s*100\s*g|cm\s*hg|mesh|bar|rpm|cps|ml|mm|kg|"
    r"°\s*c|℃|%|％|分鐘|秒鐘|公克|毫升|公斤|min(?:ute)?s?|sec(?:ond)?s?|分|秒|"
    r"(?<=\d)\s*g\b"
    r")"
)


def protection_marker(value: str | None) -> str:
    match = _PROTECTION_RE.search(str(value or ""))
    return "" if match is None else f"({match.group(0)[1:-1].upper()})"


def has_explicit_unit(value: str | None) -> bool:
    return bool(_DISPLAY_UNIT_RE.search(str(value or "")))


def strip_display_units(value: str | None) -> str:
    """Remove units from a displayed R&D value without changing its numbers."""
    text = str(value or "").strip()
    text = _DISPLAY_UNIT_RE.sub("", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s+([,，、;；/])", r"\1", text)
    return text.strip()


def align_display_value(template_value: str | None, rnd_value: str | None) -> str:
    """Follow the master: a unitless master value yields a unitless proposal."""
    value = str(rnd_value or "").strip()
    if value and template_value and not has_explicit_unit(template_value):
        value = strip_display_units(value)
    marker = protection_marker(template_value)
    if marker and not protection_marker(value):
        value = f"{value}{marker}" if value else marker
    return value


def normalize_value(value: str | None) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value)).lower().strip()
    text = text.translate(str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹", "0123456789"))
    text = text.replace("度c", "°c").replace("℃", "°c")
    text = text.replace("公克", "g").replace("毫升", "ml")
    text = re.sub(r"(?<=\d)\s*(?:~|～|至|—|–)\s*(?=\d)", "-", text)
    text = re.sub(r"\s*±\s*", "±", text)
    text = re.sub(r"\b分鐘\b|分(?=$|[^鐘])", "min", text)
    text = re.sub(r"\b秒鐘\b|秒", "sec", text)
    text = re.sub(r"\s+", "", text)
    text = text.replace("％", "%")
    text = re.sub(r"\((?:ccp|oprp)\)", "", text)
    text = re.sub(r"[（(]?含空罐重[）)]?", "", text)
    text = text.replace("≧", ">=").replace("≥", ">=").replace("≦", "<=").replace("≤", "<=")
    text = text.replace("↑", ">=")
    text = re.sub(r"mg/100g|cmhg|mesh|bar|rpm|cps|ml|mm|kg|°c|(?<=\d)c(?=$|[^a-z])|%|min|sec|(?<=\d)g(?=$|[^a-z])", "", text)
    text = text.strip("()（）")
    return text


def values_equal(left: str | None, right: str | None) -> bool:
    return normalize_value(left) == normalize_value(right)


def normalize_incubation(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lower()
    text = text.replace("℃", "°c").replace("度c", "°c")
    text = re.sub(r"\s+", "", text)
    match = re.search(r"(\d+(?:\.\d+)?)°?c.*?(\d+)(?:天|day)", text)
    if match:
        return f"{match.group(1)}c/{match.group(2)}d"
    return normalize_value(value)
