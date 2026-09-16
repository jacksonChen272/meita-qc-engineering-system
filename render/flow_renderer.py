from __future__ import annotations


def build_flow_model(qc: dict) -> dict:
    branches: dict[str, list[dict]] = {
        "material": [],
        "main": [],
        "water": [],
        "packaging": [],
        "can": [],
        "lid": [],
        "carton": [],
    }
    for step in qc["processSteps"]:
        branches.setdefault(step["flow_branch"], []).append(
            {
                "processId": step["id"],
                "name": step["name"],
                "symbol": step["flow_symbol"],
                "pageGroup": step["pagination_group"],
            }
        )
    if qc.get("templateProfile") == "sauce_pack":
        joins = [
            {"from": "water", "to": "main", "at": "溶解澱粉", "label": "水處理合流"},
            {"from": "packaging", "to": "main", "at": "充填", "label": "包材支線"},
            {"from": "carton", "to": "main", "at": "裝箱", "label": "紙箱支線"},
        ]
    else:
        joins = [
            {"from": "water", "to": "main", "at": "溶解混合攪拌", "label": "水處理合流"},
            {"from": "can", "to": "main", "at": "充填中心溫度檢查", "label": "空罐支線"},
            {"from": "lid", "to": "main", "at": "封蓋", "label": "罐蓋支線"},
            {"from": "carton", "to": "main", "at": "包裝", "label": "紙箱支線"},
        ]
    return {
        "branches": branches,
        "joins": joins,
    }
