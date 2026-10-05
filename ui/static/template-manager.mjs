const STORAGE_PREFIX = "meita-qc-template:v1:";
const TEMPLATE_FILES = Object.freeze({
  nutrition: "qc-template-nutrition.json",
  sauce_pack: "qc-template-sauce-pack.json",
});
const FIELD_DEFINITIONS = Object.freeze([
  ["machine", "使用機具"],
  ["operationStandard", "操作標準"],
  ["controlItem", "管制項目"],
  ["controlStandard", "管制基準"],
  ["controlChart", "管制圖表"],
  ["controller", "管制人員"],
  ["correctiveOwner", "矯正負責人"],
  ["samplingLocation", "取樣地點"],
  ["samplingFrequency", "取樣頻率"],
  ["samplingQuantity", "取樣數量"],
  ["instrument", "檢測儀器"],
  ["method", "檢測方法"],
]);
const ALL_FIELDS = Object.freeze(["flowSymbol", "engineeringName", ...FIELD_DEFINITIONS.map(([key]) => key)]);
const MERGE_FIELDS = new Set(["flowSymbol", "engineeringName", "machine", "operationStandard", "controller", "correctiveOwner", "samplingLocation"]);
const SYMBOLS = Object.freeze({ start: "□ 開始", operation: "○ 操作", inspection: "◇ 檢查", storage: "▽ 貯存", end: "D 結束流程" });
const BRANCHES = Object.freeze({ main: "主流程", material: "原料線", water: "原水線", packaging: "包材線", can: "空罐線", lid: "罐蓋線", carton: "紙箱線" });
const builtInCache = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function lines(value) {
  return String(value ?? "").replaceAll("\r", "").split("\n").map(line => line.trim()).filter(Boolean);
}

function field(value = "") {
  const valueLines = lines(value);
  return { text: valueLines.join("\n"), lines: valueLines, merge: null, cells: [] };
}

function setFieldText(row, key, value, touch = true) {
  row.fields ||= {};
  row.fields[key] ||= field();
  const valueLines = lines(value);
  row.fields[key].text = valueLines.join("\n");
  row.fields[key].lines = valueLines;
  delete row.fields[key].resolvedFromMerge;
  if (key === "controlItem" && (row.fields[key].cells || []).length < 2) {
    row.fields[key].cells = [{ lines: valueLines }];
  }
  if (touch) {
    row._templateEditorTouched ||= [];
    if (!row._templateEditorTouched.includes(key)) row._templateEditorTouched.push(key);
  }
}

function rowGroups(template) {
  const result = new Map(template.processSteps.map(step => [step.id, []]));
  for (const page of template.layout.pages) {
    for (const row of page.rows) {
      if (!result.has(row.processStepId)) result.set(row.processStepId, []);
      result.get(row.processStepId).push(row);
    }
  }
  return result;
}

function createRow(step, id = `row-${Date.now()}-${Math.random().toString(16).slice(2)}`) {
  const fields = Object.fromEntries(ALL_FIELDS.map(key => [key, field()]));
  fields.engineeringName = field(step.name);
  fields.controlItem = { ...field("待設定"), cells: [{ lines: ["待設定"] }] };
  fields.controlStandard = field("待設定");
  return {
    id,
    sourceTableIndex: null,
    sourceRowIndex: null,
    processStepId: step.id,
    fields,
    controlItems: [],
  };
}

function uniqueFieldLines(rows, key) {
  return [...new Set(rows.flatMap(row => lines(row.fields?.[key]?.text)))];
}

function itemValue(valueLines, index, fallback = "") {
  if (valueLines.length === 1) return valueLines[0];
  return valueLines[index] ?? fallback;
}

function syncControlItems(row, processId, rowIndex, touchedFields = []) {
  const controlField = row.fields.controlItem || field();
  const cells = Array.isArray(controlField.cells) ? controlField.cells : [];
  const split = cells.length > 1;
  const names = split ? lines((cells[0]?.lines || []).join("\n")) : lines(controlField.text);
  const details = split ? cells.slice(1).flatMap(cell => cell.lines || []).join("\n") : "";
  const standards = lines(row.fields.controlStandard?.text);
  const charts = lines(row.fields.controlChart?.text);
  const frequencies = lines(row.fields.samplingFrequency?.text);
  const quantities = lines(row.fields.samplingQuantity?.text);
  const instruments = lines(row.fields.instrument?.text);
  const methods = lines(row.fields.method?.text);
  const previous = Array.isArray(row.controlItems) ? row.controlItems : [];
  const touched = new Set(touchedFields);
  const isNew = previous.length === 0;
  let count = previous.length;
  if (isNew) count = Math.max(names.length, standards.length, controlField.text ? 1 : 0);
  if (touched.has("controlItem")) count = Math.max(names.length, controlField.text ? 1 : 0);
  const value = (fieldKey, valueLines, index, existing, property, fallback = "") => (
    isNew || touched.has(fieldKey) ? itemValue(valueLines, index, existing[property] || fallback) : existing[property] || fallback
  );
  row.controlItems = Array.from({ length: count }, (_, index) => {
    const existing = previous[index] || {};
    return {
      id: existing.id || `${processId}-r${rowIndex + 1}-i${index + 1}`,
      name: value("controlItem", names, index, existing, "name", "—"),
      standard: value("controlStandard", standards, index, existing, "standard"),
      chart: value("controlChart", charts, index, existing, "chart"),
      sampling_frequency: value("samplingFrequency", frequencies, index, existing, "sampling_frequency"),
      sampling_quantity: value("samplingQuantity", quantities, index, existing, "sampling_quantity"),
      instrument: value("instrument", instruments, index, existing, "instrument"),
      method: value("method", methods, index, existing, "method"),
      item_details: isNew || touched.has("controlItem") ? (index === 0 ? details : "") : existing.item_details || "",
      ccp_oprp: existing.ccp_oprp || "一般",
      classification: existing.classification || "FIXED",
      editable: Boolean(existing.editable),
      review_required: Boolean(existing.review_required),
      source_item_index: index,
    };
  });
}

function applyMergeRules(rows, step) {
  rows.forEach((row, index) => {
    row.processStepId = step.id;
    setFieldText(row, "engineeringName", step.name, false);
    for (const key of MERGE_FIELDS) {
      const current = row.fields[key] ||= field();
      if (index > 0 && current.text === rows[index - 1].fields[key]?.text) {
        current.merge = "continue";
        current.lines = [];
        current.resolvedFromMerge = true;
      } else {
        current.merge = "restart";
        current.lines = lines(current.text);
        delete current.resolvedFromMerge;
      }
    }
  });
}

function reflowPages(template, groups) {
  const oldPages = template.layout.pages;
  const capacities = template._templateEditor?.pageRowCapacities || oldPages.map(page => page.rows.length || 1);
  const pageRows = [];
  let current = [];
  let pageIndex = 0;
  for (const step of template.processSteps) {
    const group = groups.get(step.id) || [];
    const capacity = capacities[Math.min(pageIndex, capacities.length - 1)] || 12;
    if (current.length && current.length + group.length > capacity) {
      pageRows.push(current);
      current = [];
      pageIndex += 1;
    }
    current.push(...group);
  }
  if (current.length || !pageRows.length) pageRows.push(current);
  template.layout.pages = pageRows.map((rows, index) => {
    const source = oldPages[Math.min(index, oldPages.length - 1)] || oldPages[0] || {};
    const pageNumber = index + 1;
    for (const row of rows) {
      const step = template.processSteps.find(candidate => candidate.id === row.processStepId);
      if (step) step.pagination_group = `page-${pageNumber}`;
    }
    return { ...source, id: `page-${pageNumber}`, pageNumber, rows };
  });
}

export function validateTemplate(template, expectedKey = "") {
  if (!template || typeof template !== "object" || Array.isArray(template)) throw new Error("母版內容不是有效的 JSON 物件。");
  if (!Array.isArray(template.processSteps) || !template.processSteps.length) throw new Error("母版至少需要一個工程群組。");
  if (!template.layout || !Array.isArray(template.layout.pages) || !template.layout.pages.length) throw new Error("母版缺少工程圖分頁資料。");
  if (expectedKey && template.templateProfile !== expectedKey) throw new Error("匯入檔的母版類型與目前選擇不一致。");
  const ids = template.processSteps.map(step => String(step.id || ""));
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error("工程群組 ID 不可空白或重複。");
  const known = new Set(ids);
  const rows = template.layout.pages.flatMap(page => Array.isArray(page.rows) ? page.rows : []);
  if (!rows.length) throw new Error("母版至少需要一列工程資料。");
  if (rows.some(row => !known.has(row.processStepId) || !row.fields)) throw new Error("母版含有找不到工程群組的資料列。");
  return true;
}

export function normalizeTemplate(input, expectedKey = "") {
  const template = clone(input);
  validateTemplate(template, expectedKey);
  template._templateEditor ||= { pageRowCapacities: template.layout.pages.map(page => page.rows.length || 1) };
  const groups = rowGroups(template);
  for (const step of template.processSteps) {
    const rows = groups.get(step.id) || [];
    if (!rows.length) rows.push(createRow(step));
    rows.forEach((row, index) => {
      for (const key of ALL_FIELDS) row.fields[key] ||= field();
      const touched = row._templateEditorTouched || [];
      if (!row.controlItems?.length || touched.some(key => ["controlItem", "controlStandard", "controlChart", "samplingFrequency", "samplingQuantity", "instrument", "method"].includes(key))) {
        syncControlItems(row, step.id, index, touched);
      }
    });
    applyMergeRules(rows, step);
    rows.forEach(row => { delete row._templateEditorTouched; });
    step.machines = uniqueFieldLines(rows, "machine");
    step.operation_standards = uniqueFieldLines(rows, "operationStandard");
    step.control_people = uniqueFieldLines(rows, "controller");
    step.corrective_owners = uniqueFieldLines(rows, "correctiveOwner");
    step.sampling_locations = uniqueFieldLines(rows, "samplingLocation");
    step.default_sampling_frequencies = uniqueFieldLines(rows, "samplingFrequency");
    step.default_sampling_quantities = uniqueFieldLines(rows, "samplingQuantity");
    step.control_items = rows.flatMap(row => row.controlItems || []);
    groups.set(step.id, rows);
  }
  reflowPages(template, groups);
  template.pageCount = template.layout.pages.length;
  template.processStepCount = template.processSteps.length;
  template.controlItemCount = template.processSteps.reduce((sum, step) => sum + step.control_items.length, 0);
  template.lastCustomizedAt = new Date().toISOString();
  validateTemplate(template, expectedKey);
  return template;
}

export function storageKey(templateKey) {
  return `${STORAGE_PREFIX}${templateKey}`;
}

export function getCustomTemplate(templateKey, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(storageKey(templateKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    validateTemplate(parsed, templateKey);
    return parsed;
  } catch {
    return null;
  }
}

export function hasCustomTemplate(templateKey, storage = globalThis.localStorage) {
  return Boolean(getCustomTemplate(templateKey, storage));
}

export function saveCustomTemplate(templateKey, template, storage = globalThis.localStorage) {
  const normalized = normalizeTemplate(template, templateKey);
  storage.setItem(storageKey(templateKey), JSON.stringify(normalized));
  return normalized;
}

export function removeCustomTemplate(templateKey, storage = globalThis.localStorage) {
  storage?.removeItem(storageKey(templateKey));
}

export async function loadBuiltInTemplate(templateKey, fetcher = globalThis.fetch) {
  const file = TEMPLATE_FILES[templateKey];
  if (!file) throw new Error("找不到指定的母版類型。");
  if (!builtInCache.has(templateKey)) {
    builtInCache.set(templateKey, Promise.resolve(fetcher(file, { cache: "no-store" })).then(async response => {
      if (!response.ok) throw new Error("無法載入系統內建母版。");
      const template = await response.json();
      validateTemplate(template, templateKey);
      return template;
    }));
  }
  return clone(await builtInCache.get(templateKey));
}

export async function getEffectiveTemplate(templateKey) {
  return clone(getCustomTemplate(templateKey) || await loadBuiltInTemplate(templateKey));
}

function downloadJson(template, fileName) {
  const blob = new Blob([`${JSON.stringify(template, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function rowTitle(row, index) {
  return lines(row.fields?.controlItem?.text)[0] || `管制列 ${index + 1}`;
}

function editorMarkup(state, definitions) {
  const template = state.draft;
  const selected = template.processSteps.find(step => step.id === state.selectedId) || template.processSteps[0];
  const groups = rowGroups(template);
  const rows = groups.get(selected.id) || [];
  const custom = hasCustomTemplate(state.key);
  const processList = template.processSteps.map((step, index) => `<button type="button" class="template-process-item ${step.id === selected.id ? "active" : ""}" data-tm-select="${esc(step.id)}"><b>${String(index + 1).padStart(2, "0")}</b><span><strong>${esc(step.name)}</strong><small>${esc(SYMBOLS[step.flow_symbol] || SYMBOLS.operation)}・${esc(BRANCHES[step.flow_branch] || BRANCHES.main)}</small></span></button>`).join("");
  const rowCards = rows.map((row, index) => {
    const control = row.fields.controlItem || field();
    const split = Array.isArray(control.cells) && control.cells.length > 1;
    const fields = FIELD_DEFINITIONS.filter(([key]) => key !== "controlItem").map(([key, label]) => `<label class="template-field"><span>${esc(label)}</span><textarea rows="2" data-tm-row-field="${key}" data-tm-row-index="${index}">${esc(row.fields[key]?.text || "")}</textarea></label>`).join("");
    const controlEditor = split
      ? `<label class="template-field"><span>管制項目左格</span><textarea rows="2" data-tm-control-cell="0" data-tm-row-index="${index}">${esc((control.cells[0]?.lines || []).join("\n"))}</textarea></label><label class="template-field"><span>管制項目右格／細項</span><textarea rows="3" data-tm-control-cell="1" data-tm-row-index="${index}">${esc(control.cells.slice(1).flatMap(cell => cell.lines || []).join("\n"))}</textarea></label>`
      : `<label class="template-field template-field-wide"><span>管制項目（一項一行）</span><textarea rows="3" data-tm-row-field="controlItem" data-tm-row-index="${index}">${esc(control.text || "")}</textarea></label>`;
    return `<details class="template-row-card" ${index === 0 ? "open" : ""}><summary><span><b>${index + 1}</b><strong>${esc(rowTitle(row, index))}</strong></span><span>${row.controlItems?.length || 0} 項</span></summary><div class="template-row-body"><div class="template-row-actions"><label><input type="checkbox" data-tm-split-row="${index}" ${split ? "checked" : ""}> 管制項目分成左右兩格</label><span></span><button type="button" data-tm-move-row="up" data-tm-row-index="${index}" ${index === 0 ? "disabled" : ""}>↑ 上移</button><button type="button" data-tm-move-row="down" data-tm-row-index="${index}" ${index === rows.length - 1 ? "disabled" : ""}>↓ 下移</button><button type="button" class="danger-link" data-tm-delete-row="${index}" ${rows.length === 1 ? "disabled" : ""}>刪除此列</button></div><div class="template-field-grid">${controlEditor}${fields}</div></div></details>`;
  }).join("");
  return `<div class="template-manager-shell">
    <header class="template-manager-top"><div><p class="eyebrow">TEMPLATE MANAGER</p><h1>QC 母版管理</h1><p>修改後儲存在這台電腦的瀏覽器；下一次建立工程圖時自動套用。</p></div><button class="btn" type="button" data-tm-close>返回系統</button></header>
    <section class="template-manager-notice"><strong>安全設計</strong><span>內建母版永遠保留。請先匯出 JSON 備份；若修改結果不正確，可一鍵還原。</span></section>
    <section class="template-manager-toolbar"><label><span>正在編輯</span><select data-tm-template>${Object.entries(definitions).map(([key, value]) => `<option value="${esc(key)}" ${key === state.key ? "selected" : ""}>${esc(value.label)}</option>`).join("")}</select></label><div class="template-version-state ${custom ? "custom" : ""}"><b>${custom ? "目前使用自訂母版" : "目前使用系統內建母版"}</b><small>${template.processStepCount || template.processSteps.length} 個工程・${template.controlItemCount || 0} 個管制項目・${template.pageCount || template.layout.pages.length} 頁</small></div><span class="template-manager-status" data-tm-status>${esc(state.status || (state.dirty ? "尚未儲存" : "已載入"))}</span></section>
    <div class="template-manager-workspace"><aside class="template-process-panel"><div class="template-panel-title"><div><strong>工程群組</strong><small>工程名、記號與資料列整組管理</small></div><button type="button" data-tm-add-process>＋ 新增</button></div><div class="template-process-list">${processList}</div><div class="template-process-order"><button type="button" data-tm-move-process="up">↑ 上移工程</button><button type="button" data-tm-move-process="down">↓ 下移工程</button><button type="button" class="danger-link" data-tm-delete-process>刪除工程</button></div></aside>
      <main class="template-editor-panel"><div class="template-editor-heading"><div><p>目前工程</p><h2>${esc(selected.name)}</h2></div><button class="btn btn-small" type="button" data-tm-add-row>＋ 增加管制列</button></div><div class="template-process-fields"><label><span>工程名稱</span><input type="text" value="${esc(selected.name)}" data-tm-process-name></label><label><span>流程記號</span><select data-tm-process-symbol>${Object.entries(SYMBOLS).map(([key, label]) => `<option value="${key}" ${selected.flow_symbol === key ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label><label><span>流程支線</span><select data-tm-process-branch>${Object.entries(BRANCHES).map(([key, label]) => `<option value="${key}" ${selected.flow_branch === key ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label></div><p class="template-editor-help">同一管制列內，多個項目請一項一行；管制基準、儀器及方法也依相同行數對齊。工程內上下相同的欄位會在儲存時自動合併。</p><div class="template-row-list">${rowCards}</div></main></div>
    <footer class="template-manager-actions"><div><button class="btn btn-accent" type="button" data-tm-save>儲存並套用母版</button><button class="btn" type="button" data-tm-export>匯出 JSON 備份</button><label class="btn template-import-button">匯入 JSON<input type="file" accept=".json,application/json" data-tm-import></label></div><button class="btn danger-outline" type="button" data-tm-restore>還原系統內建母版</button></footer>
  </div>`;
}

function replaceRows(template, processId, replacement) {
  const groups = rowGroups(template);
  groups.set(processId, replacement);
  reflowPages(template, groups);
}

export async function openTemplateManager({ container, definitions, initialKey = "nutrition", onClose }) {
  const state = { key: initialKey, draft: await getEffectiveTemplate(initialKey), selectedId: "", dirty: false, status: "" };
  state.selectedId = state.draft.processSteps[0].id;

  const markDirty = message => {
    state.dirty = true;
    state.status = message || "尚未儲存";
    const status = container.querySelector("[data-tm-status]");
    if (status) status.textContent = state.status;
  };

  const render = () => {
    container.innerHTML = editorMarkup(state, definitions);
    bind();
  };

  const selectedStep = () => state.draft.processSteps.find(step => step.id === state.selectedId) || state.draft.processSteps[0];

  const bind = () => {
    container.querySelector("[data-tm-close]").addEventListener("click", () => {
      if (state.dirty && !confirm("尚有未儲存的母版修改，確定要離開嗎？")) return;
      onClose?.();
    });
    container.querySelector("[data-tm-template]").addEventListener("change", async event => {
      if (state.dirty && !confirm("切換母版會放棄尚未儲存的修改，確定繼續嗎？")) { event.target.value = state.key; return; }
      state.key = event.target.value;
      state.draft = await getEffectiveTemplate(state.key);
      state.selectedId = state.draft.processSteps[0].id;
      state.dirty = false;
      state.status = "已切換母版";
      render();
    });
    container.querySelectorAll("[data-tm-select]").forEach(button => button.addEventListener("click", () => { state.selectedId = button.dataset.tmSelect; render(); }));
    container.querySelector("[data-tm-process-name]").addEventListener("change", event => {
      const name = event.target.value.trim();
      if (!name) { event.target.value = selectedStep().name; return; }
      selectedStep().name = name;
      markDirty("工程名稱已修改，尚未儲存");
    });
    container.querySelector("[data-tm-process-symbol]").addEventListener("change", event => { selectedStep().flow_symbol = event.target.value; markDirty(); });
    container.querySelector("[data-tm-process-branch]").addEventListener("change", event => { selectedStep().flow_branch = event.target.value; markDirty(); });
    container.querySelectorAll("[data-tm-row-field]").forEach(input => input.addEventListener("change", () => {
      const rows = rowGroups(state.draft).get(state.selectedId);
      setFieldText(rows[Number(input.dataset.tmRowIndex)], input.dataset.tmRowField, input.value);
      markDirty("管制欄位已修改，尚未儲存");
    }));
    container.querySelectorAll("[data-tm-control-cell]").forEach(input => input.addEventListener("change", () => {
      const rows = rowGroups(state.draft).get(state.selectedId);
      const row = rows[Number(input.dataset.tmRowIndex)];
      const control = row.fields.controlItem;
      const index = Number(input.dataset.tmControlCell);
      control.cells ||= [{ lines: [] }, { lines: [] }];
      control.cells[index] = { lines: lines(input.value) };
      control.text = control.cells.flatMap(cell => cell.lines || []).join("\n");
      control.lines = lines(control.text);
      row._templateEditorTouched ||= [];
      if (!row._templateEditorTouched.includes("controlItem")) row._templateEditorTouched.push("controlItem");
      markDirty("管制項目分格已修改，尚未儲存");
    }));
    container.querySelectorAll("[data-tm-split-row]").forEach(input => input.addEventListener("change", () => {
      const rows = rowGroups(state.draft).get(state.selectedId);
      const control = rows[Number(input.dataset.tmSplitRow)].fields.controlItem;
      const currentLines = lines(control.text);
      control.cells = input.checked ? [{ lines: currentLines.slice(0, 1) }, { lines: currentLines.slice(1) }] : [{ lines: currentLines }];
      const row = rows[Number(input.dataset.tmSplitRow)];
      row._templateEditorTouched ||= [];
      if (!row._templateEditorTouched.includes("controlItem")) row._templateEditorTouched.push("controlItem");
      markDirty();
      render();
    }));
    container.querySelectorAll("[data-tm-move-row]").forEach(button => button.addEventListener("click", () => {
      const rows = rowGroups(state.draft).get(state.selectedId);
      const index = Number(button.dataset.tmRowIndex);
      const target = button.dataset.tmMoveRow === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= rows.length) return;
      [rows[index], rows[target]] = [rows[target], rows[index]];
      replaceRows(state.draft, state.selectedId, rows);
      markDirty("管制列順序已修改，尚未儲存");
      render();
    }));
    container.querySelectorAll("[data-tm-delete-row]").forEach(button => button.addEventListener("click", () => {
      const rows = rowGroups(state.draft).get(state.selectedId);
      rows.splice(Number(button.dataset.tmDeleteRow), 1);
      replaceRows(state.draft, state.selectedId, rows);
      markDirty("管制列已刪除，尚未儲存");
      render();
    }));
    container.querySelector("[data-tm-add-row]").addEventListener("click", () => {
      const step = selectedStep();
      const rows = rowGroups(state.draft).get(step.id);
      rows.push(createRow(step));
      replaceRows(state.draft, step.id, rows);
      markDirty("已新增管制列，尚未儲存");
      render();
    });
    container.querySelector("[data-tm-add-process]").addEventListener("click", () => {
      const number = Date.now();
      const step = { id: `custom-process-${number}`, name: "新增工程", machines: [], operation_standards: [], flow_symbol: "operation", flow_branch: "main", control_people: [], corrective_owners: [], sampling_locations: [], default_sampling_frequencies: [], default_sampling_quantities: [], pagination_group: "", control_items: [] };
      state.draft.processSteps.push(step);
      const groups = rowGroups(state.draft);
      groups.set(step.id, [createRow(step)]);
      reflowPages(state.draft, groups);
      state.selectedId = step.id;
      markDirty("已新增工程，尚未儲存");
      render();
    });
    container.querySelectorAll("[data-tm-move-process]").forEach(button => button.addEventListener("click", () => {
      const index = state.draft.processSteps.findIndex(step => step.id === state.selectedId);
      const target = button.dataset.tmMoveProcess === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= state.draft.processSteps.length) return;
      [state.draft.processSteps[index], state.draft.processSteps[target]] = [state.draft.processSteps[target], state.draft.processSteps[index]];
      reflowPages(state.draft, rowGroups(state.draft));
      markDirty("工程順序已修改，尚未儲存");
      render();
    }));
    container.querySelector("[data-tm-delete-process]").addEventListener("click", () => {
      if (state.draft.processSteps.length === 1 || !confirm(`確定刪除「${selectedStep().name}」及其所有管制列嗎？`)) return;
      state.draft.processSteps = state.draft.processSteps.filter(step => step.id !== state.selectedId);
      for (const page of state.draft.layout.pages) page.rows = page.rows.filter(row => row.processStepId !== state.selectedId);
      state.selectedId = state.draft.processSteps[0].id;
      reflowPages(state.draft, rowGroups(state.draft));
      markDirty("工程已刪除，尚未儲存");
      render();
    });
    container.querySelector("[data-tm-save]").addEventListener("click", () => {
      try {
        state.draft = saveCustomTemplate(state.key, state.draft);
        state.dirty = false;
        state.status = "已儲存；下一次解析會套用此母版";
        window.dispatchEvent(new CustomEvent("qc-template-updated", { detail: { templateKey: state.key } }));
        render();
      } catch (error) {
        state.status = `儲存失敗：${error.message}`;
        render();
      }
    });
    container.querySelector("[data-tm-export]").addEventListener("click", () => {
      const normalized = normalizeTemplate(state.draft, state.key);
      downloadJson(normalized, `${definitions[state.key].label}.json`);
      state.status = "已下載母版 JSON 備份";
      const status = container.querySelector("[data-tm-status]");
      if (status) status.textContent = state.status;
    });
    container.querySelector("[data-tm-import]").addEventListener("change", async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const imported = JSON.parse(await file.text());
        const key = imported.templateProfile;
        if (!definitions[key]) throw new Error("匯入檔不是系統支援的母版類型。");
        state.key = key;
        state.draft = normalizeTemplate(imported, key);
        state.selectedId = state.draft.processSteps[0].id;
        state.dirty = true;
        state.status = `已匯入 ${file.name}，請按「儲存並套用母版」`;
        render();
      } catch (error) {
        state.status = `匯入失敗：${error.message}`;
        render();
      }
    });
    container.querySelector("[data-tm-restore]").addEventListener("click", async () => {
      if (!confirm(`確定移除「${definitions[state.key].label}」的自訂內容並還原系統內建版本嗎？`)) return;
      removeCustomTemplate(state.key);
      state.draft = await loadBuiltInTemplate(state.key);
      state.selectedId = state.draft.processSteps[0].id;
      state.dirty = false;
      state.status = "已還原系統內建母版";
      window.dispatchEvent(new CustomEvent("qc-template-updated", { detail: { templateKey: state.key } }));
      render();
    });
  };

  render();
}

export { BRANCHES, FIELD_DEFINITIONS, STORAGE_PREFIX, SYMBOLS, TEMPLATE_FILES };
