from __future__ import annotations


MACHINE_PROCESS_RULES = {
    "二重釜": ["溶解混合攪拌"],
    "溶糖機": ["溶解混合攪拌"],
    "溶奶機": ["溶解混合攪拌"],
    "冰沙機": ["溶解混合攪拌"],
    "冰沙機-1": ["溶解混合攪拌"],
    "溶解桶": ["溶解混合攪拌"],
    "均質機": ["調配液均質"],
    "調配桶": ["定量調配貯存", "半成品檢測"],
}


def map_processes(rnd: dict, qc: dict) -> dict:
    steps_by_name: dict[str, list[dict]] = {}
    for step in qc["processSteps"]:
        steps_by_name.setdefault(step["name"], []).append(step)

    mappings = []
    for machine in rnd.get("machines", []):
        targets = MACHINE_PROCESS_RULES.get(machine, [])
        if not targets:
            mappings.append(
                {
                    "rndMachine": machine,
                    "targetProcessIds": [],
                    "targetProcessNames": [],
                    "status": "REVIEW_REQUIRED",
                    "action": "不新增製程，等待人工判斷",
                    "reason": "研發設備名稱未出現在目前的顯式製程映射規則。",
                }
            )
            continue
        target_steps = [steps_by_name[name][0] for name in targets if steps_by_name.get(name)]
        mappings.append(
            {
                "rndMachine": machine,
                "targetProcessIds": [step["id"] for step in target_steps],
                "targetProcessNames": [step["name"] for step in target_steps],
                "status": "MAPPED" if len(target_steps) == len(targets) else "REVIEW_REQUIRED",
                "action": "併入既有 QC ProcessStep",
                "reason": "依研發作業流程中的設備/容器角色對應，不建立新 QC 製程。",
            }
        )
    return {
        "sourceMachineCount": len(rnd.get("machines", [])),
        "mappedMachineCount": sum(1 for item in mappings if item["status"] == "MAPPED"),
        "mappings": mappings,
    }
