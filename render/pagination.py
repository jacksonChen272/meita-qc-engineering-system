from __future__ import annotations


def validate_pagination(qc: dict) -> dict:
    issues = []
    process_pages: dict[str, set[str]] = {}
    for page in qc["layout"]["pages"]:
        for row in page["rows"]:
            process_pages.setdefault(row["processStepId"], set()).add(page["id"])
    for process_id, pages in process_pages.items():
        if len(pages) > 1:
            issues.append({"processId": process_id, "pages": sorted(pages), "message": "同一 ProcessStep 跨頁"})
    return {"valid": not issues, "pageCount": len(qc["layout"]["pages"]), "issues": issues}
