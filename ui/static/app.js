(function () {
  "use strict";

  const STATUS_LABELS = {
    SAME: "相同",
    CHANGED: "變更",
    REVIEW_REQUIRED: "需要確認",
    MISSING_RND: "研發缺少",
    NEW_RND: "新增參數",
    LOCKED: "鎖定規格",
  };
  const CATEGORY_LABELS = {
    formula: "配方表",
    workflow: "作業流程",
    filling: "充填條件",
    sterilization: "殺菌包裝條件",
    half_finished: "半成品規格",
    finished: "成品規格",
    incubation: "保溫與微生物",
    coa: "COA 開立",
  };
  const LEGACY_WORD_ACCEPT = ".doc,.docx,.docm,.dot,.dotx,.dotm,.wbk,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-word.document.macroEnabled.12,application/vnd.openxmlformats-officedocument.wordprocessingml.template,application/vnd.ms-word.template.macroEnabled.12";

  const state = {
    data: null,
    view: "diff",
    filter: "ALL",
    decisions: {},
    manualEditing: null,
    processOrder: [],
    customProcesses: {},
    draggingProcessId: null,
    nextProcessNumber: 1,
    editorOpen: false,
    metadataOpen: true,
    documentMeta: null,
    standardImport: null,
    tutorialPage: 0,
    onlineMode: false,
  };
  const app = document.getElementById("app");
  let globalListenersBound = false;

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function statusClass(status) { return String(status || "").toLowerCase(); }

  const DAY_OFFS_2026 = new Set([
    "2026-01-01",
    "2026-02-14", "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22",
    "2026-02-27", "2026-02-28", "2026-03-01",
    "2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06",
    "2026-05-01", "2026-05-02", "2026-05-03",
    "2026-06-19", "2026-06-20", "2026-06-21",
    "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28",
    "2026-10-09", "2026-10-10", "2026-10-11",
    "2026-10-24", "2026-10-25", "2026-10-26",
    "2026-12-25", "2026-12-26", "2026-12-27",
  ]);

  function isoDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function displayDate(date) { return isoDate(date).replaceAll("-", "."); }

  function nextBusinessDay(date) {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    while ([0, 6].includes(result.getDay()) || DAY_OFFS_2026.has(isoDate(result))) result.setDate(result.getDate() + 1);
    return displayDate(result);
  }

  function incrementRevision(value) {
    const match = String(value || "").trim().match(/^(\d+)\.(\d+)$/);
    if (!match) return "2.0";
    let major = Number(match[1]);
    let minor = Number(match[2]) + 1;
    if (minor >= 10) { major += 1; minor = 0; }
    return `${major}.${minor}`;
  }

  function initDocumentMeta() {
    const today = new Date();
    return {
      documentNumber: "",
      unit: state.data?.preview?.documentHeader?.scope || "生產二課",
      version: "2.0",
      establishedDate: displayDate(today),
      revisionDate: displayDate(today),
      issueDate: nextBusinessDay(today),
      currentRevision: "2.0",
      revisionContent: "新制訂",
      previousRevisions: [],
      importedFileName: "",
      importMessage: "未匯入舊版，本次視為新制訂。",
      importError: false,
    };
  }

  function preserveProtectionMarker(value, templateValue) {
    const marker = String(templateValue || "").match(/\((?:CCP|OPRP)\)/i)?.[0]?.toUpperCase();
    const text = String(value || "");
    return marker && !/\((?:CCP|OPRP)\)/i.test(text) ? `${text}${marker}` : text;
  }

  function setView(view) {
    state.view = view;
    state.manualEditing = null;
    window.scrollTo({ top: 0, behavior: "smooth" });
    render();
  }

  function topbar() {
    const nav = [
      ["diff", "差異確認"], ["preview", "工程圖預覽"], ["tutorial", "使用教學"],
    ];
    return `<header class="topbar">
      <div class="brand"><div class="brand-mark">QC</div><div><strong>美達食品 QC 工程圖</strong><small>外來標準比對與工程圖產生</small></div></div>
      <nav class="topnav" aria-label="主要導覽">${nav.map(([key, label]) => `<button class="${state.view === key ? "active" : ""}" data-view="${key}">${label}</button>`).join("")}</nav>
    </header>`;
  }

  function statusCards() {
    const summary = state.data.diff.summary;
    return `<div class="status-grid">${Object.keys(STATUS_LABELS).map(status => `<div class="status-card ${statusClass(status)}"><span class="count">${summary[status] || 0}</span><span class="label">${STATUS_LABELS[status]}</span></div>`).join("")}</div>`;
  }

  function homeView() {
    const { product, parameterCount } = state.data.rnd;
    const qc = state.data.qc;
    const mapping = state.data.mapping.parameters;
    return `<main class="page">
      <div class="hero-grid">
        <section class="hero-card">
          <p class="eyebrow">Word → 結構化資料 → Mapping → Diff</p>
          <h1>QC 工程圖<br>新產品建立</h1>
          <p class="lede">以既有 QC 工程圖為結構權威，解析研發規格、顯示逐項差異，人工確認後產生沿用母版欄位與分頁規則的 HTML 預覽。</p>
          <div class="hero-actions"><button class="btn btn-primary" data-view="parsed">查看研發解析結果</button><button class="btn btn-accent" data-view="diff">查看 QC 差異</button><button class="btn" data-view="preview">預覽 QC 工程圖</button></div>
          <div class="confidence-strip"><span class="pulse"></span>兩份 Word 均已實際解析；所有研發值保留章節、原文與表格列位置。</div>
        </section>
        <aside class="hero-card meta-card">
          <p class="eyebrow">Current product</p>
          <div class="meta-list">
            <div class="meta-item"><span>產品</span><strong>${esc(product.name)}</strong></div>
            <div class="meta-item"><span>研發版本</span><strong>${esc(product.version)}</strong></div>
            <div class="meta-item"><span>研發日期</span><strong>${esc(product.date)}</strong></div>
            <div class="meta-item"><span>來源檔案</span><strong>${esc(product.sourceFile)}</strong></div>
          </div>
        </aside>
      </div>
      <div class="section-head"><div><h2>本次資料映射</h2><p>${qc.processStepCount} 個 ProcessStep、${qc.controlItemCount} 個 ControlItem、${parameterCount} 個研發參數、${mapping.autoMappedCount} 個精確自動映射。</p></div></div>
      ${statusCards()}
    </main>`;
  }

  function parsedView() {
    const rnd = state.data.rnd;
    const grouped = Object.groupBy ? Object.groupBy(rnd.parameters, p => p.category) : rnd.parameters.reduce((acc, p) => ((acc[p.category] ||= []).push(p), acc), {});
    return `<main class="page">
      <p class="eyebrow">R&amp;D document parser</p><div class="section-head"><div><h1>研發解析結果</h1><p>原始 Word 被拆成產品、設備/作業流程及具 SourceTrace 的參數。</p></div></div>
      <div class="parse-kpis"><div class="panel kpi"><strong>${rnd.parameterCount}</strong><span>研發參數</span></div><div class="panel kpi"><strong>${rnd.machines.length}</strong><span>作業設備</span></div><div class="panel kpi"><strong>${rnd.workflowBlocks.length}</strong><span>流程文字區塊</span></div><div class="panel kpi"><strong>${rnd.history.length}</strong><span>版本履歷</span></div></div>
      <section class="panel"><h2>作業流程設備</h2><div class="machine-chips">${rnd.machines.map(m => `<span class="machine-chip">${esc(m)}</span>`).join("")}</div></section>
      <div class="section-head"><div><h2>作業流程原文</h2><p>完整保存；只把可可靠對應的參數送入 Diff。</p></div></div>
      <div class="workflow-grid">${rnd.workflowBlocks.map(block => `<article class="workflow-card"><h3>【${esc(block.machine)}】</h3><p>${esc(block.text)}</p><details class="source-details"><summary>SourceTrace</summary><pre>${esc(block.source.section)}\n${esc(block.source.original_text)}</pre></details></article>`).join("")}</div>
      <div class="section-head"><div><h2>參數清單</h2><p>配方與 COA 保留為來源資料，不直接覆寫 QC。</p></div></div>
      ${Object.entries(grouped).map(([category, items], index) => `<details class="parameter-panel" ${index === 2 || category === "half_finished" || category === "finished" ? "open" : ""}><summary><span>${CATEGORY_LABELS[category] || esc(category)}</span><span>${items.length} 項</span></summary><table class="parameter-table"><thead><tr><th>參數</th><th>值</th><th>分類</th><th>來源章節</th></tr></thead><tbody>${items.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.value)}</td><td><span class="badge classification">${esc(p.classification)}</span></td><td>${esc(p.source.section)}</td></tr>`).join("")}</tbody></table></details>`).join("")}
    </main>`;
  }

  function activeDecision(record) { return state.decisions[record.id] || { choice: record.decision, value: record.proposedValue }; }

  function actionButtons(record) {
    const decision = activeDecision(record);
    if (record.status === "LOCKED") return `<div class="decision-note">🔒 特食鎖定規格，預設採用研發值；本版不提供解除鎖定。</div>`;
    if (record.status === "SAME") return `<div class="decision-note">值相同，沿用確認結果。</div>`;
    if (record.status === "MISSING_RND") return `<div class="decision-note">研發文件未提供同語意值，暫時保留母版。</div>`;
    const needsChoice = record.status === "REVIEW_REQUIRED" || record.status === "NEW_RND";
    const buttons = `<button class="btn btn-small ${decision.choice === "USE_RND" ? "btn-accent" : ""}" data-decision="USE_RND" data-id="${record.id}">採用研發值</button><button class="btn btn-small ${decision.choice === "KEEP_TEMPLATE" ? "btn-primary" : ""}" data-decision="KEEP_TEMPLATE" data-id="${record.id}">保留母版</button><button class="btn btn-small" data-decision="MANUAL" data-id="${record.id}">人工輸入</button>`;
    const manual = state.manualEditing === record.id ? `<input class="manual-input" data-manual-input="${record.id}" value="${esc(decision.choice === "MANUAL" ? decision.value : "")}" placeholder="輸入確認後的管制基準" autofocus />` : "";
    return `${needsChoice ? `<div class="decision-note">此項禁止自動通過，必須人工選擇。</div>` : ""}${buttons}${manual}`;
  }

  function sourceDetails(record) {
    if (!record.source) return `<div class="item-sub">來源：研發文件未提供</div>`;
    return `<details class="source-details"><summary>查看來源</summary><pre>${esc(record.source.file)}\n${esc(record.source.section)}\n\n${esc(record.source.original_text)}</pre></details>`;
  }

  function diffRow(record) {
    const decision = activeDecision(record);
    const proposed = decision.choice === "KEEP_TEMPLATE" ? record.templateValue : preserveProtectionMarker(decision.value, record.templateValue);
    return `<article class="diff-row">
      <div><div class="item-name">${record.status === "LOCKED" ? "🔒 " : ""}${esc(record.controlItem)}</div><div class="badges"><span class="badge ${statusClass(record.status)}">${STATUS_LABELS[record.status]}</span><span class="badge classification">${esc(record.classification)}</span>${record.protectionLevel !== "一般" ? `<span class="badge protected">${esc(record.protectionLevel)} 保護</span>` : ""}</div><div class="item-sub">${esc(record.mappingReason)}</div></div>
      <div><div class="value-grid"><div class="value-box"><span>母版</span><strong>${esc(record.templateValue || "—")}</strong></div><div class="value-box"><span>研發</span><strong>${esc(record.rndValue || "—")}</strong></div><div class="value-box"><span>目前建議</span><strong>${esc(proposed || "—")}</strong></div></div>${sourceDetails(record)}</div>
      <div class="actions">${actionButtons(record)}</div>
    </article>`;
  }

  function standardImportPanel() {
    const rnd = state.data.rnd;
    const product = rnd.product || {};
    const upload = state.standardImport || {};
    const formats = state.onlineMode ? ".docx" : "各版本 Word";
    return `<section class="standard-import-panel">
      <div class="standard-import-copy">
        <p class="eyebrow">外來文件</p>
        <h2>匯入外來標準文件</h2>
        <p>選擇研發或委託廠商提供的產品標準 Word；系統會重新解析、比對 QC 母版並更新下方差異。${state.onlineMode ? "檔案只在目前瀏覽器中處理，不會上傳至 GitHub。" : ""}</p>
      </div>
      <label class="standard-file-field">
        <span>${upload.loading ? "解析中，請稍候…" : `選擇標準文件（${formats}）`}</span>
        <input type="file" accept="${state.onlineMode ? ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" : LEGACY_WORD_ACCEPT}" data-standard-file ${upload.loading ? "disabled" : ""}>
      </label>
      <div class="source-facts">
        <div><span>目前產品</span><strong>${esc(product.name || "待匯入")}</strong></div>
        <div><span>標準文件</span><strong>${esc(upload.fileName || product.sourceFile || "尚未載入")}</strong></div>
        <div><span>解析結果</span><strong>${rnd.parameterCount} 項規格・${rnd.machines.length} 項設備</strong></div>
        <div><span>QC 母版</span><strong>${esc(state.data.qc.sourceFile)}</strong></div>
      </div>
      <p class="standard-import-status ${upload.error ? "error" : ""}">${esc(upload.message || "")}</p>
      <details class="parsed-summary"><summary>查看解析摘要</summary><div><span>研發版本：<strong>${esc(product.version || "—")}</strong></span><span>研發日期：<strong>${esc(product.date || "—")}</strong></span><span>流程文字：<strong>${rnd.workflowBlocks.length} 段</strong></span><span>版本履歷：<strong>${rnd.history.length} 筆</strong></span></div></details>
    </section>`;
  }

  function diffView() {
    const all = state.data.diff.records;
    const filtered = state.filter === "ALL" ? all : all.filter(record => record.status === state.filter);
    const processOrder = new Map(state.data.qc.processSteps.map((p, i) => [p.id, i]));
    const grouped = filtered.reduce((acc, record) => ((acc[record.process] ||= []).push(record), acc), {});
    const entries = Object.entries(grouped).sort((a, b) => {
      const ai = Math.min(...a[1].map(r => processOrder.get(r.processId) ?? 9999));
      const bi = Math.min(...b[1].map(r => processOrder.get(r.processId) ?? 9999));
      return ai - bi;
    });
    const reviewRecords = all.filter(r => ["REVIEW_REQUIRED", "NEW_RND"].includes(r.status));
    const resolved = reviewRecords.filter(r => !["PENDING_REVIEW", undefined].includes(activeDecision(r).choice)).length;
    const filterButtons = [["ALL", "全部"], ["CHANGED", "只看變更"], ["REVIEW_REQUIRED", "需要確認"], ["LOCKED", "鎖定"], ["SAME", "相同"], ["MISSING_RND", "研發缺少"], ["NEW_RND", "新增參數"]];
    return `<main class="page">
      <div class="section-head workspace-heading"><div><p class="eyebrow">QC 工程圖工作區</p><h1>匯入、確認、預覽</h1><p>先匯入外來標準文件，再確認差異；CCP／OPRP 及無效值不會自動通過。</p></div><button class="btn btn-accent" data-view="preview">預覽 QC 工程圖</button></div>
      ${standardImportPanel()}
      <div class="section-head compact-section-head"><div><h2>QC 差異與人工確認</h2><p>解析摘要與差異統計已整合在同一頁，不必另外切換首頁或研發解析。</p></div></div>
      ${statusCards()}
      <div class="toolbar"><div class="filters">${filterButtons.map(([key, label]) => `<button class="filter-btn ${state.filter === key ? "active" : ""}" data-filter="${key}">${label}</button>`).join("")}</div><div class="review-progress">人工確認 ${resolved} / ${reviewRecords.length}</div></div>
      <div class="process-list">${entries.length ? entries.map(([process, records]) => `<details class="process-card" ${records.some(r => r.status !== "SAME" || r.classification !== "FIXED") ? "open" : ""}><summary class="process-summary"><div><h3>${esc(process)}</h3><p>${records.length} 個欄位</p></div><div class="summary-badges">${[...new Set(records.map(r => r.status))].map(status => `<span class="badge ${statusClass(status)}">${STATUS_LABELS[status]}</span>`).join("")}</div></summary><div class="process-body">${records.map(diffRow).join("")}</div></details>`).join("") : `<div class="empty-state">目前篩選條件沒有資料。</div>`}</div>
    </main>`;
  }

  function decisionValue(record) {
    const decision = activeDecision(record);
    if (decision.choice === "KEEP_TEMPLATE" || decision.choice === "PENDING_REVIEW") return record.templateValue;
    return preserveProtectionMarker(decision.value || record.rndValue || record.templateValue, record.templateValue);
  }

  const SYMBOL_LABELS = { start: "□ 開始", operation: "○ 操作", inspection: "◇ 檢查", storage: "▽ 貯存", end: "D 結束流程" };
  const BRANCH_LABELS = {
    material: "原料線",
    main: "主流程",
    water: "原水線",
    can: "空罐線",
    lid: "罐蓋線",
    carton: "紙箱線",
  };

  function editableStepMap() {
    return new Map([
      ...state.data.qc.processSteps.map(step => [step.id, step]),
      ...Object.values(state.customProcesses).map(step => [step.id, step]),
    ]);
  }

  function pageFlowSvg(page) {
    return `<svg class="flow-overlay" data-flow-page="${esc(page.id)}" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="每個工程名稱各有一個流程記號"></svg>`;
  }

  function flowSymbolMarkup(step, x, y) {
    const title = `<title>${esc(step.name)}｜${esc(SYMBOL_LABELS[step.flow_symbol] || "操作")}</title>`;
    let shape;
    if (step.flow_symbol === "start") shape = `<rect class="flow-node" x="${x - 6}" y="${y - 6}" width="12" height="12" />`;
    else if (step.flow_symbol === "inspection") shape = `<polygon class="flow-node" points="${x},${y - 7} ${x + 7},${y} ${x},${y + 7} ${x - 7},${y}" />`;
    else if (step.flow_symbol === "storage") shape = `<polygon class="flow-node" points="${x - 7},${y - 6} ${x + 7},${y - 6} ${x},${y + 7}" />`;
    else if (step.flow_symbol === "end") shape = `<path class="flow-node" d="M ${x - 7} ${y - 7} L ${x} ${y - 7} A 7 7 0 0 1 ${x} ${y + 7} L ${x - 7} ${y + 7} Z" />`;
    else shape = `<circle class="flow-node" cx="${x}" cy="${y}" r="6" />`;
    return `<g class="flow-process-node" data-flow-process="${esc(step.id)}">${title}${shape}</g>`;
  }

  function alignFlowOverlays() {
    if (state.view !== "preview") return;
    const stepById = editableStepMap();
    const orderedSteps = state.processOrder.map(id => stepById.get(id)).filter(Boolean);
    const orderIndex = new Map(orderedSteps.map((step, index) => [step.id, index]));
    const laneX = { material: 18, main: 18, water: 36, can: 56, lid: 76, carton: 94 };
    const joinTargets = {
      water: "溶解混合攪拌",
      can: "充填中心溫度檢查",
      lid: "封蓋",
      carton: "包裝",
    };
    document.querySelectorAll(".qc-sheet").forEach(sheet => {
      const svg = sheet.querySelector(".flow-overlay");
      const flowCell = sheet.querySelector(".flow-cell");
      if (!svg || !flowCell) return;
      const flowRect = flowCell.getBoundingClientRect();
      const rows = [...sheet.querySelectorAll(".qc-table tbody tr[data-process-id]")];
      const ids = [...new Set(rows.map(row => row.dataset.processId))];
      const nodes = ids.map(id => {
        const processRows = rows.filter(row => row.dataset.processId === id);
        const first = processRows[0].getBoundingClientRect();
        const engineeringCell = processRows[0].querySelector('[data-field="engineeringName"]');
        const engineeringRect = engineeringCell?.getBoundingClientRect();
        const engineeringStyle = engineeringCell ? getComputedStyle(engineeringCell) : null;
        const lineHeight = engineeringStyle ? Number.parseFloat(engineeringStyle.lineHeight) : 0;
        const paddingTop = engineeringStyle ? Number.parseFloat(engineeringStyle.paddingTop) : 0;
        const step = stepById.get(id);
        return step ? {
          step,
          index: orderIndex.get(step.id),
          x: laneX[step.flow_branch] || laneX.main,
          // Merged engineering-name cells are top-aligned. Anchor the symbol to
          // the first text line rather than to the vertical centre of the
          // complete multi-row process group.
          y: engineeringRect
            ? engineeringRect.top - flowRect.top + paddingTop + (lineHeight || first.height) / 2
            : first.top - flowRect.top + first.height / 2,
        } : null;
      }).filter(Boolean);
      const height = Math.max(1, flowRect.height);
      svg.setAttribute("viewBox", `0 0 100 ${height}`);
      const pageStart = Math.min(...nodes.map(node => node.index));
      const pageEnd = Math.max(...nodes.map(node => node.index));
      const nodeById = new Map(nodes.map(node => [node.step.id, node]));
      const paths = [];

      const spine = orderedSteps.filter(step => ["material", "main"].includes(step.flow_branch));
      if (spine.length) {
        const firstIndex = orderIndex.get(spine[0].id);
        const lastIndex = orderIndex.get(spine.at(-1).id);
        if (pageStart <= lastIndex && pageEnd >= firstIndex) {
          const local = nodes.filter(node => ["material", "main"].includes(node.step.flow_branch));
          const startY = firstIndex < pageStart ? 0 : (local[0]?.y ?? 0);
          const endY = lastIndex > pageEnd ? height : (local.at(-1)?.y ?? height);
          paths.push(`<path class="flow-line flow-spine" data-flow-line="main" d="M ${laneX.main} ${startY} L ${laneX.main} ${endY}" />`);
        }
      }

      Object.entries(joinTargets).forEach(([branch, targetName]) => {
        const branchSteps = orderedSteps.filter(step => step.flow_branch === branch);
        const target = orderedSteps.find(step => step.name === targetName);
        if (!branchSteps.length) return;
        const firstIndex = orderIndex.get(branchSteps[0].id);
        const targetIndex = target ? orderIndex.get(target.id) : orderIndex.get(branchSteps.at(-1).id);
        if (pageStart > targetIndex || pageEnd < firstIndex) return;
        const localBranch = nodes.filter(node => node.step.flow_branch === branch);
        const targetNode = target ? nodeById.get(target.id) : null;
        const startY = firstIndex < pageStart ? 0 : (localBranch[0]?.y ?? 0);
        const endY = targetIndex > pageEnd ? height : (targetNode?.y ?? localBranch.at(-1)?.y ?? height);
        paths.push(`<path class="flow-line flow-branch" data-flow-line="${esc(branch)}" d="M ${laneX[branch]} ${startY} L ${laneX[branch]} ${endY}" />`);
        if (targetNode) {
          paths.push(`<path class="flow-line flow-join" data-flow-join="${esc(branch)}" d="M ${laneX[branch]} ${targetNode.y} L ${laneX.main} ${targetNode.y}" />`);
        }
      });
      svg.innerHTML = `${paths.join("")}${nodes.map(node => flowSymbolMarkup(node.step, node.x, node.y)).join("")}`;
    });
  }

  function fieldSignature(row, field) {
    const payload = row.fields[field];
    const lines = field === "controlStandard" ? proposedStandardLines(row) : payload.lines;
    return (lines || []).map(line => String(line).trim()).join("\n").trim();
  }

  function mergeRowspans(rows, field) {
    const spans = new Map();
    const hidden = new Set();
    if (field === "flowSymbol") {
      if (rows.length) spans.set(0, rows.length);
      for (let i = 1; i < rows.length; i++) hidden.add(i);
      return { spans, hidden };
    }
    for (let i = 0; i < rows.length; i++) {
      const merge = rows[i].fields[field].merge;
      if (merge === "continue") {
        hidden.add(i);
        continue;
      }
      if (merge === "restart") {
        let span = 1;
        while (i + span < rows.length && rows[i + span].fields[field].merge === "continue") {
          hidden.add(i + span);
          span++;
        }
        spans.set(i, span);
        i += span - 1;
        continue;
      }
      const signature = fieldSignature(rows[i], field);
      if (!signature) continue;
      let span = 1;
      while (
        i + span < rows.length &&
        rows[i + span].fields[field].merge == null &&
        fieldSignature(rows[i + span], field) === signature &&
        (field !== "engineeringName" || rows[i + span].processStepId === rows[i].processStepId)
      ) {
        hidden.add(i + span);
        span++;
      }
      if (span > 1) spans.set(i, span);
      i += span - 1;
    }
    return { spans, hidden };
  }

  function proposedStandardLines(row) {
    const lines = [...row.fields.controlStandard.lines];
    // A single control standard can occupy several source lines, for example
    // "不可有" followed by "(OPRP)". Replace the whole logical value so the
    // protection marker is retained exactly once instead of being appended to
    // the old continuation line.
    if (row.controlItems.length === 1) {
      const record = state.data.diff.records.find(item => item.controlItemId === row.controlItems[0].id);
      const value = record ? decisionValue(record) : "";
      if (value) return String(value).split(/\r?\n/);
    }
    for (const control of row.controlItems) {
      const record = state.data.diff.records.find(item => item.controlItemId === control.id);
      if (!record) continue;
      const value = decisionValue(record);
      if (control.source_item_index < lines.length && value) lines[control.source_item_index] = value;
    }
    return lines;
  }

  function cellHtml(row, field, rowIndex, rowspans, page) {
    const payload = row.fields[field];
    if (rowspans[field].hidden.has(rowIndex)) return "";
    const span = rowspans[field].spans.get(rowIndex) || 1;
    let lines = field === "controlStandard" ? proposedStandardLines(row) : payload.lines;
    let content = `<div class="cell-lines">${(lines.length ? lines : [""]).map(line => `<div>${esc(line)}</div>`).join("")}</div>`;
    if (field === "flowSymbol") content = pageFlowSvg(page);
    return `<td data-field="${esc(field)}" class="${field === "flowSymbol" ? "flow-cell" : ""}" ${span > 1 ? `rowspan="${span}"` : ""}>${content}</td>`;
  }

  function controlItemParts(row) {
    const cells = row.fields.controlItem.cells || [];
    if (cells.length <= 1) return { shape: "single", single: row.fields.controlItem.lines || [] };
    return {
      shape: "split",
      category: cells[0].lines || [],
      detail: cells.slice(1).flatMap(cell => cell.lines || []),
    };
  }

  function mergeControlItemPart(rows, part, shape) {
    const spans = new Map();
    const hidden = new Set();
    const specs = rows.map(controlItemParts);
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      if (spec.shape !== shape) continue;
      const signature = (spec[part] || []).map(line => String(line).trim()).join("\n").trim();
      if (!signature) continue;
      let span = 1;
      while (i + span < specs.length) {
        const next = specs[i + span];
        const nextSignature = (next[part] || []).map(line => String(line).trim()).join("\n").trim();
        if (next.shape !== shape || nextSignature !== signature) break;
        hidden.add(i + span);
        span++;
      }
      if (span > 1) spans.set(i, span);
      i += span - 1;
    }
    return { spans, hidden };
  }

  function controlItemRowspans(rows) {
    return {
      single: mergeControlItemPart(rows, "single", "single"),
      category: mergeControlItemPart(rows, "category", "split"),
      detail: mergeControlItemPart(rows, "detail", "split"),
    };
  }

  function controlItemCells(row, rowIndex, rowspans) {
    const parts = controlItemParts(row);
    const renderLines = lines => `<div class="cell-lines">${(lines?.length ? lines : [""]).map(line => `<div>${esc(line)}</div>`).join("")}</div>`;
    if (parts.shape === "single") {
      if (rowspans.single.hidden.has(rowIndex)) return "";
      const span = rowspans.single.spans.get(rowIndex) || 1;
      return `<td data-field="controlItem" colspan="2" ${span > 1 ? `rowspan="${span}"` : ""}>${renderLines(parts.single)}</td>`;
    }
    let html = "";
    if (!rowspans.category.hidden.has(rowIndex)) {
      const span = rowspans.category.spans.get(rowIndex) || 1;
      html += `<td data-field="controlItemCategory" class="control-item-category" ${span > 1 ? `rowspan="${span}"` : ""}>${renderLines(parts.category)}</td>`;
    }
    if (!rowspans.detail.hidden.has(rowIndex)) {
      const span = rowspans.detail.spans.get(rowIndex) || 1;
      html += `<td data-field="controlItemDetail" class="control-item-detail" ${span > 1 ? `rowspan="${span}"` : ""}>${renderLines(parts.detail)}</td>`;
    }
    return html;
  }

  function metadataEditor() {
    const meta = state.documentMeta;
    return `<details class="document-editor" data-metadata-editor ${state.metadataOpen ? "open" : ""}>
      <summary><span><strong>文件第一頁資料</strong><small>文件編號、單位與修訂內容會同步到第一頁及每一頁 QC 頁首</small></span><span>${meta.importedFileName ? "已參考舊版" : "新制訂"}</span></summary>
      <div class="document-editor-body">
        <div class="metadata-grid">
          <label><span>品質管制標準書編號</span><input type="text" data-meta-field="documentNumber" value="${esc(meta.documentNumber)}" placeholder="例如 02-0200-033"></label>
          <label><span>權責／適用單位</span><select data-meta-field="unit">${["生產一課", "生產二課", "生產三課"].map(unit => `<option ${unit === meta.unit ? "selected" : ""}>${unit}</option>`).join("")}</select></label>
          <label class="revision-content-field"><span>本次修訂內容摘要</span><input type="text" data-meta-field="revisionContent" value="${esc(meta.revisionContent)}" placeholder="請輸入本次修訂內容"></label>
          <label class="legacy-file-field"><span>匯入舊版（選填，支援各版本 Word）</span><input type="file" accept="${LEGACY_WORD_ACCEPT}" data-legacy-file></label>
        </div>
        <div class="metadata-summary">
          <span>版本 <strong>2.0</strong></span><span>制定日期 <strong>${esc(meta.establishedDate)}</strong></span><span>本次版次 <strong>${esc(meta.currentRevision)}</strong></span><span>修訂日期 <strong>${esc(meta.revisionDate)}</strong></span><span>發行日期 <strong>${esc(meta.issueDate)}</strong></span><span>檢討週期 <strong>1 年</strong></span>
        </div>
        <p class="import-status ${meta.importError ? "error" : ""}">${esc(meta.importMessage)}</p>
      </div>
    </details>`;
  }

  function revisionRows() {
    const meta = state.documentMeta;
    const current = {
      revisionDate: meta.revisionDate,
      revision: meta.currentRevision,
      content: meta.revisionContent,
      issueDate: meta.issueDate,
    };
    const history = [...(meta.previousRevisions || [])].reverse();
    const rows = [current, ...history].slice(0, 5);
    while (rows.length < 5) rows.push({ revisionDate: "", revision: "", content: "", issueDate: "" });
    return rows;
  }

  function coverSheet(totalPages) {
    const meta = state.documentMeta;
    const documentName = state.data.preview.documentHeader.title;
    const rows = revisionRows();
    return `<section class="qc-sheet cover-sheet">
      <h1>美達食品工業股份有限公司　土庫工廠</h1>
      <table class="cover-metadata"><colgroup><col style="width:11.5%"><col style="width:40%"><col style="width:8.5%"><col style="width:11.5%"><col style="width:11.5%"><col style="width:17%"></colgroup><tbody>
        <tr><th>文件編號</th><td>${esc(meta.documentNumber || "待輸入")}</td><th>版本</th><td>2.0</td><th>制定日期</th><td>${esc(meta.establishedDate)}</td></tr>
        <tr><th>文件名稱</th><td>${esc(documentName)}</td><th>頁次</th><td>1/${totalPages}</td><th>權責單位</th><td class="cover-emphasis">${esc(meta.unit)}</td></tr>
        <tr><th>適用範圍</th><td colspan="3" class="cover-emphasis">${esc(meta.unit)}</td><th>檢討週期</th><td class="cover-emphasis">1 年</td></tr>
      </tbody></table>
      <table class="cover-revision"><colgroup><col style="width:11%"><col style="width:12%"><col style="width:58%"><col style="width:19%"></colgroup><thead><tr><th colspan="4" class="revision-title">修　訂　紀　錄</th></tr><tr><th>修訂日期</th><th>現行版次</th><th>修　訂　內　容　摘　要</th><th>發行日期</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.revisionDate)}</td><td>${esc(row.revision)}</td><td class="revision-copy">${esc(row.content)}</td><td>${esc(row.issueDate)}</td></tr>`).join("")}</tbody></table>
      <table class="cover-approval"><thead><tr><th>核　准</th><th>審　核</th><th>會　審</th><th>初　審</th><th>制　訂</th></tr></thead><tbody><tr><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>
      <div class="sheet-label">1</div>
    </section>`;
  }

  function documentHeader() {
    const header = state.data.preview.documentHeader;
    return `<table class="qc-document-header" aria-label="QC 文件頁首">
      <colgroup><col style="width:57%"><col style="width:11%"><col style="width:20%"><col style="width:5%"><col style="width:7%"></colgroup>
      <tbody>
        <tr><th class="doc-title" rowspan="3">${esc(header.title)}</th><th>類　別</th><td>${esc(header.category)}</td><th>編號</th><td>${esc(state.documentMeta.documentNumber || "待輸入")}</td></tr>
        <tr><th>適用範圍</th><td colspan="3">${esc(state.documentMeta.unit)}</td></tr>
        <tr><th>工程圖記號意義</th><td class="symbol-meaning" colspan="3">${header.symbolLegend.map(esc).join("　")}</td></tr>
      </tbody>
    </table>`;
  }

  async function savePreviewAsHtml() {
    const sheets = document.querySelector(".sheet-scroller");
    if (!sheets) return;
    const css = await fetch("styles.css", { cache: "no-store" }).then(response => response.text());
    const documentTitle = state.data.preview.documentHeader.title;
    const fileName = `${documentTitle.replace(/[\\/:*?"<>|]+/g, "-")}.html`;
    const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(documentTitle)}</title><style>${css}\nbody{padding:20px}.sheet-scroller{overflow:visible}.qc-sheet{margin-bottom:24px}</style></head><body>${sheets.outerHTML}</body></html>`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: "HTML 文件", accept: { "text/html": [".html"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
      reader.onerror = () => reject(reader.error || new Error("檔案讀取失敗"));
      reader.readAsDataURL(file);
    });
  }

  async function importLegacyFile(file) {
    if (!file) return;
    state.documentMeta.importMessage = `正在解析 ${file.name}…`;
    state.documentMeta.importError = false;
    render();
    try {
      let result;
      if (state.onlineMode) {
        result = await window.QcBrowserRuntime.importLegacy(file, message => {
          state.documentMeta.importMessage = message;
          render();
        });
      } else {
        const contentBase64 = await readFileAsBase64(file);
        const response = await fetch("/api/import-legacy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentBase64 }),
        });
        result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      }
      const old = result.metadata;
      if (!old || ![old.documentNumber, old.establishedDate, old.latestRevision].some(Boolean)) {
        throw new Error("找不到第一頁文件資料或修訂紀錄，請確認選擇的是舊版 QC 工程圖。");
      }
      const allowedUnits = ["生產一課", "生產二課", "生產三課"];
      state.documentMeta.documentNumber = old.documentNumber || state.documentMeta.documentNumber;
      state.documentMeta.establishedDate = old.establishedDate || state.documentMeta.establishedDate;
      if (allowedUnits.includes(old.unit)) state.documentMeta.unit = old.unit;
      state.documentMeta.previousRevisions = old.revisionHistory || [];
      state.documentMeta.currentRevision = incrementRevision(old.latestRevision);
      state.documentMeta.revisionContent = "";
      state.documentMeta.importedFileName = file.name;
      state.documentMeta.importMessage = old.latestRevision
        ? `已匯入 ${file.name}；沿用制定日期，現行版次由 ${old.latestRevision} 延伸為 ${state.documentMeta.currentRevision}。`
        : `已匯入 ${file.name}；已帶入可辨識的舊版文件資料。`;
      state.documentMeta.importError = false;
    } catch (error) {
      state.documentMeta.importMessage = `匯入失敗：${error.message}`;
      state.documentMeta.importError = true;
    }
    state.metadataOpen = true;
    render();
  }

  async function importStandardFile(file) {
    if (!file) return;
    state.standardImport = { fileName: file.name, message: `正在解析 ${file.name}…`, error: false, loading: true };
    render();
    try {
      let result;
      if (state.onlineMode) {
        result = await window.QcBrowserRuntime.importStandard(file, message => {
          state.standardImport.message = message;
          render();
        });
      } else {
        const contentBase64 = await readFileAsBase64(file);
        const response = await fetch("/api/import-standard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentBase64 }),
        });
        result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      }
      state.data = result.data;
      state.decisions = {};
      state.manualEditing = null;
      state.filter = "ALL";
      state.processOrder = result.data.qc.processSteps.map(step => step.id);
      state.customProcesses = {};
      state.documentMeta = initDocumentMeta();
      state.standardImport = {
        fileName: file.name,
        message: `已匯入 ${file.name}；完成 ${result.report.rndParameters} 項規格解析與 ${result.report.autoMapped} 項自動對應。`,
        error: false,
        loading: false,
      };
    } catch (error) {
      state.standardImport = { fileName: file.name, message: `匯入失敗：${error.message}`, error: true, loading: false };
    }
    state.view = "diff";
    render();
  }

  function originalProcessGroups() {
    const groups = new Map();
    state.data.preview.pages.flatMap(page => page.rows).forEach(row => {
      if (!groups.has(row.processStepId)) groups.set(row.processStepId, []);
      groups.get(row.processStepId).push(row);
    });
    return groups;
  }

  function customProcessRow(step) {
    const fields = Object.fromEntries(state.data.preview.columns.map(column => [column.key, { text: "", lines: [], merge: null, cells: [] }]));
    fields.engineeringName = { text: step.name, lines: [step.name], merge: null, cells: [] };
    fields.controlItem = { text: "待設定", lines: ["待設定"], merge: null, cells: [] };
    fields.controlStandard = { text: "待設定", lines: ["待設定"], merge: null, cells: [] };
    return { sourceTableIndex: null, sourceRowIndex: null, processStepId: step.id, fields, controlItems: [] };
  }

  function editablePages() {
    const basePages = state.data.preview.pages;
    const capacities = basePages.map(page => page.rows.length);
    const groups = originalProcessGroups();
    Object.values(state.customProcesses).forEach(step => groups.set(step.id, [customProcessRow(step)]));
    const orderedGroups = state.processOrder.filter(id => groups.has(id)).map(id => groups.get(id));
    const pageRows = [];
    let current = [];
    let pageIndex = 0;
    let capacity = capacities[0] || 12;
    for (const group of orderedGroups) {
      if (current.length && current.length + group.length > capacity) {
        pageRows.push(current);
        current = [];
        pageIndex++;
        capacity = capacities[pageIndex] || 12;
      }
      current.push(...group);
    }
    if (current.length || !pageRows.length) pageRows.push(current);
    return pageRows.map((rows, index) => {
      const base = basePages[Math.min(index, basePages.length - 1)];
      return { ...base, id: `editable-page-${index + 1}`, pageNumber: index + 1, rows };
    });
  }

  function processEditor() {
    const steps = editableStepMap();
    const items = state.processOrder.map((id, index) => {
      const step = steps.get(id);
      if (!step) return "";
      return `<div class="process-group-item" draggable="true" data-process-group="${esc(id)}">
        <span class="drag-handle" aria-hidden="true">⋮⋮</span>
        <span class="process-sequence">${index + 1}</span>
        <span class="process-symbol">${esc(SYMBOL_LABELS[step.flow_symbol] || SYMBOL_LABELS.operation)}</span>
        <strong>${esc(step.name)}</strong>
        <span class="branch-chip">${esc(BRANCH_LABELS[step.flow_branch] || BRANCH_LABELS.main)}</span>
        <button class="move-process" type="button" data-move-process="up" aria-label="上移 ${esc(step.name)}" title="上移">↑</button>
        <button class="move-process" type="button" data-move-process="down" aria-label="下移 ${esc(step.name)}" title="下移">↓</button>
        <button class="remove-process" type="button" data-remove-process="${esc(id)}" aria-label="刪除 ${esc(step.name)}">刪除</button>
      </div>`;
    }).join("");
    return `<details class="flow-editor" data-flow-editor ${state.editorOpen ? "open" : ""}>
      <summary><span><strong>流程群組編輯</strong><small>一個工程名稱＝一個流程記號＝一個可拖移群組</small></span><span>${state.processOrder.length} 組</span></summary>
      <div class="flow-editor-body">
        <div class="editor-note">拖曳整組即可改變順序；刪除與新增只改目前預覽，重新整理即可回復母版。</div>
        <div class="process-group-list">${items}</div>
        <div class="add-process-form">
          <input type="text" data-new-process-name placeholder="新增工程名稱" aria-label="新增工程名稱">
          <select data-new-process-symbol aria-label="流程記號"><option value="operation">○ 操作</option><option value="inspection">◇ 檢查</option><option value="storage">▽ 貯存</option><option value="start">□ 開始</option><option value="end">D 結束流程</option></select>
          <select data-new-process-branch aria-label="流程支線"><option value="main">主流程</option><option value="material">原料線</option><option value="water">原水線</option><option value="can">空罐線</option><option value="lid">罐蓋線</option><option value="carton">紙箱線</option></select>
          <button class="btn btn-accent" type="button" data-add-process>增加工程</button>
          <button class="btn" type="button" data-reset-processes>還原母版順序</button>
        </div>
      </div>
    </details>`;
  }

  function qcSheet(page) {
    const columns = state.data.preview.columns;
    const groups = state.data.preview.columnGroups;
    const expandedWidths = page.columnWidths.flatMap((width, index) => index === 4 ? [width * 0.175, width * 0.825] : [width]);
    const total = expandedWidths.reduce((a, b) => a + b, 0);
    const colgroup = expandedWidths.map(width => `<col style="width:${(width / total * 100).toFixed(4)}%">`).join("");
    const rowspans = Object.fromEntries(columns.map(column => [column.key, mergeRowspans(page.rows, column.key)]));
    const controlRowspans = controlItemRowspans(page.rows);
    const groupHeaders = groups.map((group, index) => `<th colspan="${group.span + (index === 1 ? 1 : 0)}">${esc(group.label)}</th>`).join("");
    const columnHeaders = columns.map(column => `<th ${column.key === "controlItem" ? 'colspan="2"' : ""}>${esc(column.label)}</th>`).join("");
    const body = page.rows.map((row, rowIndex) => `<tr data-process-id="${esc(row.processStepId)}">${columns.map(column => column.key === "controlItem" ? controlItemCells(row, rowIndex, controlRowspans) : cellHtml(row, column.key, rowIndex, rowspans, page)).join("")}</tr>`).join("");
    return `<section class="qc-sheet">${documentHeader()}<table class="qc-table"><colgroup>${colgroup}</colgroup><thead><tr class="group-head">${groupHeaders}</tr><tr class="column-head">${columnHeaders}</tr></thead><tbody>${body}</tbody></table><div class="sheet-label">${page.pageNumber}</div></section>`;
  }

  function previewView() {
    const preview = state.data.preview;
    const pages = editablePages();
    const totalPages = pages.length + 1;
    const qcPages = pages.map((page, index) => qcSheet({ ...page, pageNumber: index + 2 })).join("");
    return `<main class="page preview-page"><div class="preview-toolbar"><div><p class="eyebrow">QC template preview</p><h1>QC 工程圖 HTML 預覽</h1><p class="preview-note">共 ${totalPages} 頁（文件首頁 1 頁、QC 工程圖 ${pages.length} 頁）；管制項目依母版顯示單格或雙格，每個流程記號對準一個工程名稱。</p></div><div class="preview-actions"><button class="btn btn-accent" type="button" data-print-preview>列印</button><button class="btn" type="button" data-save-preview>另存新檔</button><button class="btn btn-primary" data-view="diff">返回差異確認</button></div></div>${metadataEditor()}${processEditor()}<div class="flow-legend"><span><i></i>主線保持垂直，支線只在指定工程合流</span><span>□ 開始</span><span>○ 操作</span><span>◇ 檢查</span><span>▽ 貯存</span><span>D 結束流程</span><span>獨立進料：原料／原水／空罐／罐蓋／紙箱</span></div><div class="sheet-scroller">${coverSheet(totalPages)}${qcPages}</div></main>`;
  }

  function tutorialDemo(kind) {
    const demos = {
      overview: `<div class="demo-overview"><div><b>1</b><span>匯入標準</span></div><i>→</i><div><b>2</b><span>確認差異</span></div><i>→</i><div><b>3</b><span>調整預覽</span></div><i>→</i><div><b>4</b><span>輸出檔案</span></div></div>`,
      standard: `<div class="demo-upload"><div class="demo-word">W</div><div><small>外來標準文件</small><strong>選擇標準文件（.doc／.docx）</strong><span>力增 洗腎配方(杏仁).docx</span></div><button type="button">選擇檔案</button></div><div class="demo-success">✓ 已匯入文件；完成規格解析與自動對應。</div>`,
      filters: `<div class="demo-statuses"><span><b>12</b>變更</span><span><b>4</b>需要確認</span><span><b>4</b>鎖定</span><span><b>8</b>研發缺少</span></div><div class="demo-filters"><b>全部</b><span>只看變更</span><span>需要確認</span><span>鎖定</span></div>`,
      decision: `<div class="demo-values"><div><small>母版</small><b>13～20</b></div><div><small>研發</small><b>13–20°C</b></div><div><small>目前建議</small><b>13～20</b></div></div><div class="demo-decisions"><button>採用研發值</button><button class="selected">保留母版</button><button>人工輸入</button></div>`,
      metadata: `<div class="demo-form"><label>品質管制標準書編號<strong>02-0200-033</strong></label><label>權責／適用單位<strong>生產二課⌄</strong></label><label>修訂內容<strong>依外來標準修訂</strong></label><label>舊版 QC 工程圖<strong>選擇舊版檔案…</strong></label></div><div class="demo-success">✓ 沿用制定日期，現行版次由 2.0 延伸為 2.1。</div>`,
      process: `<div class="demo-processes"><div><i>⋮⋮</i><b>01</b><span>□</span><strong>原料儲放</strong><em>原料線</em><button>↑</button><button>↓</button></div><div><i>⋮⋮</i><b>02</b><span>◇</span><strong>原料檢驗</strong><em>主流程</em><button>↑</button><button>↓</button></div><div><i>⋮⋮</i><b>03</b><span>○</span><strong>溶解混合攪拌</strong><em>主流程</em><button>↑</button><button>↓</button></div></div>`,
      preview: `<div class="demo-sheet"><div class="demo-sheet-title">產品名稱 QC 工程圖</div><div class="demo-sheet-head"><span>流程記號</span><span>工程名稱</span><span>管制項目</span><span>管制基準</span></div><div class="demo-sheet-row"><span>│<br>○<br>│</span><b>溶解混合<br>攪拌</b><span>溫度<br>時間</span><span>≧70<br>依標準</span></div><small>2</small></div>`,
      output: `<div class="demo-output"><button class="print">列印</button><button>另存新檔</button></div><div class="demo-output-options"><div><b>印表機／PDF</b><span>A4 橫式，依頁次輸出</span></div><div><b>HTML 新檔</b><span>可離線開啟與再次列印</span></div></div>`,
    };
    return `<div class="tutorial-demo" aria-hidden="true">${demos[kind] || demos.overview}</div>`;
  }

  function tutorialView() {
    const chapters = [
      {
        menu: "操作總覽", title: "系統操作總覽", location: "開始使用前先看這一章", demo: "overview", target: "diff", targetLabel: "開始製作",
        intro: "這套系統以既有 QC 母版為格式與欄位依據，再把外來標準中的產品規格帶入比對。使用者負責確認差異，系統負責重組流程、分頁及產生工程圖。",
        steps: ["先匯入外來標準 Word。", "逐項確認系統找出的 QC 差異。", "到工程圖預覽填寫首頁、調整流程。", "檢查完成後列印、另存 PDF 或 HTML。"],
        system: ["不會只因數字相近就判定相同。", "CCP／OPRP 與鎖定項目會保留保護規則。", "相鄰且內容相同的儲存格會依母版規則合併。"],
        check: "開始前請準備外來標準文件；若有同產品舊版 QC 工程圖，也一併準備。",
      },
      {
        menu: "外來標準", title: "匯入外來標準文件", location: "差異確認 → 匯入外來標準文件", demo: "standard", target: "diff", targetLabel: "前往匯入",
        intro: "外來標準是研發或委託廠商提供的產品標準。匯入後，系統會重新辨識產品、規格、設備與流程文字，並與 QC 母版進行對應。",
        steps: ["按「選擇標準文件」。", "選擇 .doc 或 .docx 檔案。", "等待解析完成，不要關閉或重新整理頁面。", "核對目前產品、檔名、規格數量及設備數量。"],
        system: ["每次重新匯入會重建差異結果與工程圖預覽。", "先前尚未儲存的人工選擇與流程調整會重設。", "此處不要匯入舊版 QC 工程圖。"],
        check: "看到綠色「已匯入」訊息，而且解析結果不是 0 項，才代表匯入完成。",
      },
      {
        menu: "差異篩選", title: "差異分類與篩選", location: "差異確認 → QC 差異與人工確認", demo: "filters", target: "diff", targetLabel: "查看差異",
        intro: "統計卡會把每個管制項目分成相同、變更、需要確認、研發缺少、新增參數及鎖定規格。篩選按鈕可讓畫面只留下目前要處理的類型。",
        steps: ["先看「需要確認」與「新增參數」。", "再看「變更」，確認系統建議是否合理。", "查看「研發缺少」，確認是否應沿用母版。", "最後使用「全部」檢查完整工程順序。"],
        system: ["相同：內容正規化後一致。", "需要確認：禁止自動通過，必須人工選擇。", "鎖定：依產品保護規則保留，不提供任意解除。"],
        check: "篩選只改變畫面顯示，不會刪除或改動其他項目。",
      },
      {
        menu: "人工確認", title: "人工確認與來源追溯", location: "差異確認 → 展開工程名稱", demo: "decision", target: "diff", targetLabel: "開始確認",
        intro: "每一項會並列顯示母版、研發及目前建議。使用者可決定採用研發值、保留母版或人工輸入，也可展開「查看來源」核對原始文件位置。",
        steps: ["比較母版、研發與目前建議三個欄位。", "有疑問時展開「查看來源」。", "選擇採用研發值、保留母版或人工輸入。", "人工輸入後離開欄位，確認目前建議已更新。"],
        system: ["母版沒有單位時，建議值不會自行加上單位。", "母版中的 (CCP)／(OPRP) 標記會保留下來。", "未完成確認的項目在預覽中暫時沿用母版。"],
        check: "工具列右側的「人工確認」完成數應等於需要人工處理的總數。",
      },
      {
        menu: "首頁／舊版", title: "文件首頁與舊版匯入", location: "工程圖預覽 → 文件首頁資料", demo: "metadata", target: "preview", targetLabel: "編輯首頁",
        intro: "這裡控制第一頁文件資料。標準書編號與修訂內容由使用者輸入，權責單位與適用範圍共用生產課別；舊版 QC 工程圖只用來延續文件履歷。",
        steps: ["輸入品質管制標準書編號。", "選擇生產一課、二課或三課。", "輸入本次修訂內容。", "若有舊版 QC 工程圖，可直接選擇舊式 .doc、新版 .docx 或其他 Word 格式匯入。", "核對制定、修訂、發行日期及現行版次。"],
        system: ["版本欄固定為 2.0，檢討週期固定 1 年。", "有舊版時沿用制定日期，現行版次增加 0.1。", "發行日期為修訂日期後第一個工作日。"],
        check: "沒有舊版時保持「新制訂」；有舊版時應看到舊版檔名與版次延伸訊息。",
      },
      {
        menu: "流程編輯", title: "流程群組編輯", location: "工程圖預覽 → 流程群組編輯", demo: "process", target: "preview", targetLabel: "調整流程",
        intro: "工程名稱、流程記號與該工程下的所有 QC 資料列是一個不可拆散的群組。調整順序時會整組移動，工程圖也會重新分頁及繪製流程線。",
        steps: ["拖曳左側把手移動整組，或按 ↑／↓ 微調。", "新增工程時輸入名稱並選擇記號與流程支線。", "按刪除移除不需要的工程。", "要放棄調整時按「還原母版順序」。"],
        system: ["一個工程名稱固定對應一個流程記號。", "原料、原水、空罐、罐蓋、紙箱可使用獨立進料線。", "其他主流程保持直線，只在指定工程合流。"],
        check: "完成後檢查每個記號是否與工程名稱同一排，以及支線是否連到正確工程。",
      },
      {
        menu: "預覽檢查", title: "工程圖預覽與檢查", location: "工程圖預覽 → 各頁工程圖", demo: "preview", target: "preview", targetLabel: "開啟預覽",
        intro: "預覽會顯示文件首頁及全部 QC 工程圖頁面。所有確認結果、流程順序、分頁、合併儲存格與流程線都會反映在這裡。",
        steps: ["先核對首頁的文件名稱、編號、日期、課別與總頁數。", "逐頁查看工程名稱及流程記號。", "核對管制項目、基準、圖表、管制人員與矯正負責人。", "再檢查取樣地點、數量、頻率及檢測方法。"],
        system: ["每頁都會重複文件頁首。", "上下相同且符合規則的儲存格會垂直合併。", "列印時 QC 表格使用 9 號字，頁碼位於下方中央。"],
        check: "右側最後一欄不可被裁切，頁碼要連續，流程記號不可偏離對應工程名稱。",
      },
      {
        menu: "列印／儲存", title: "列印、PDF 與另存新檔", location: "工程圖預覽 → 右上角按鈕", demo: "output", target: "preview", targetLabel: "前往輸出",
        intro: "工程圖確認完成後可直接列印，也可透過瀏覽器列印視窗另存 PDF；「另存新檔」則會產生包含目前工程圖內容的 HTML 檔。",
        steps: ["先按「列印」開啟列印預覽。", "核對紙張為 A4、橫向、總頁數正確且沒有裁切。", "選擇實體印表機，或目的地選擇另存為 PDF。", "需要保留可再次開啟的版本時，回到畫面按「另存新檔」。"],
        system: ["另存新檔的格式是 HTML，不是 Word。", "HTML 可離線開啟並再次列印。", "重新整理會回到初始內容，請先完成儲存。"],
        check: "輸出前再次確認首頁頁次與實際總頁數一致，且每一頁都是 A4 橫式。",
      },
    ];
    state.tutorialPage = Math.min(Math.max(state.tutorialPage, 0), chapters.length - 1);
    const menu = chapters.map((chapter, index) => `<button class="tutorial-menu-button ${index === state.tutorialPage ? "active" : ""}" type="button" data-tutorial-page="${index}"><b>${String(index + 1).padStart(2, "0")}</b><span><strong>${esc(chapter.menu)}</strong><small>${esc(chapter.title)}</small></span></button>`).join("");
    const pages = chapters.map((chapter, index) => `<section class="tutorial-chapter" data-active="${index === state.tutorialPage}" data-tutorial-chapter="${index}">
      <div class="tutorial-chapter-heading"><div><p class="eyebrow">功能 ${String(index + 1).padStart(2, "0")}／${String(chapters.length).padStart(2, "0")}</p><h1>${esc(chapter.title)}</h1><p class="tutorial-location">${esc(chapter.location)}</p></div>${chapter.target ? `<button class="btn btn-accent" type="button" data-view="${chapter.target}">${esc(chapter.targetLabel)}</button>` : ""}</div>
      <p class="tutorial-intro">${esc(chapter.intro)}</p>
      ${tutorialDemo(chapter.demo)}
      <div class="tutorial-detail-grid"><section><h2>怎麼操作</h2><ol>${chapter.steps.map(step => `<li>${esc(step)}</li>`).join("")}</ol></section><section><h2>系統會怎麼處理</h2><ul>${chapter.system.map(item => `<li>${esc(item)}</li>`).join("")}</ul></section></div>
      <div class="tutorial-check"><span>完成判斷</span><p>${esc(chapter.check)}</p></div>
      <div class="tutorial-pager"><button class="btn" type="button" data-tutorial-prev ${index === 0 ? "disabled" : ""}>← 上一個功能</button><span>${index + 1} / ${chapters.length}</span><button class="btn btn-primary" type="button" data-tutorial-next ${index === chapters.length - 1 ? "disabled" : ""}>下一個功能 →</button></div>
    </section>`).join("");
    return `<main class="page tutorial-page">
      <section class="tutorial-hero"><div><p class="eyebrow">使用教學</p><h1>QC 工程圖功能手冊</h1><p class="lede">從左側選擇功能，右側會逐頁說明用途、操作方法及完成判斷。</p></div><div class="tutorial-actions"><button class="btn btn-primary" type="button" data-view="diff">開始製作</button><button class="btn" type="button" data-print-tutorial>列印完整教學</button></div></section>
      <div class="tutorial-workspace"><aside class="tutorial-menu"><div class="tutorial-menu-title"><strong>功能目錄</strong><small>共 ${chapters.length} 個功能</small></div>${menu}</aside><div class="tutorial-content">${pages}</div></div>
    </main>`;
  }

  function render() {
    if (!state.data) return;
    const views = { diff: diffView, preview: previewView, tutorial: tutorialView };
    app.innerHTML = topbar() + (views[state.view] || diffView)();
    bindEvents();
    if (state.view === "preview") requestAnimationFrame(alignFlowOverlays);
  }

  function bindEvents() {
    document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
    document.querySelectorAll("[data-tutorial-page]").forEach(button => button.addEventListener("click", () => {
      state.tutorialPage = Number(button.dataset.tutorialPage);
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }));
    const tutorialPrev = document.querySelector("[data-tutorial-prev]:not([disabled])");
    if (tutorialPrev) tutorialPrev.addEventListener("click", () => { state.tutorialPage -= 1; render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
    const tutorialNext = document.querySelector("[data-tutorial-next]:not([disabled])");
    if (tutorialNext) tutorialNext.addEventListener("click", () => { state.tutorialPage += 1; render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
    const printPreview = document.querySelector("[data-print-preview]");
    if (printPreview) printPreview.addEventListener("click", () => window.print());
    const printTutorial = document.querySelector("[data-print-tutorial]");
    if (printTutorial) printTutorial.addEventListener("click", () => window.print());
    const savePreview = document.querySelector("[data-save-preview]");
    if (savePreview) savePreview.addEventListener("click", async () => {
      savePreview.disabled = true;
      const label = savePreview.textContent;
      savePreview.textContent = "準備檔案…";
      try { await savePreviewAsHtml(); }
      finally { savePreview.disabled = false; savePreview.textContent = label; }
    });
    document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => { state.filter = button.dataset.filter; render(); }));
    document.querySelectorAll("[data-decision]").forEach(button => button.addEventListener("click", () => {
      const record = state.data.diff.records.find(item => item.id === button.dataset.id);
      const choice = button.dataset.decision;
      if (choice === "MANUAL") {
        state.manualEditing = record.id;
        state.decisions[record.id] = { choice: "MANUAL", value: activeDecision(record).choice === "MANUAL" ? activeDecision(record).value : "" };
      } else {
        state.manualEditing = null;
        state.decisions[record.id] = { choice, value: choice === "USE_RND" ? record.rndValue : record.templateValue };
      }
      render();
    }));
    document.querySelectorAll("[data-manual-input]").forEach(input => {
      input.focus();
      input.addEventListener("input", () => { state.decisions[input.dataset.manualInput] = { choice: "MANUAL", value: input.value }; });
      input.addEventListener("change", render);
    });
    const editor = document.querySelector("[data-flow-editor]");
    if (editor) editor.addEventListener("toggle", () => { state.editorOpen = editor.open; });
    const metadataEditorElement = document.querySelector("[data-metadata-editor]");
    if (metadataEditorElement) metadataEditorElement.addEventListener("toggle", () => { state.metadataOpen = metadataEditorElement.open; });
    document.querySelectorAll("[data-meta-field]").forEach(input => {
      input.addEventListener("input", () => { state.documentMeta[input.dataset.metaField] = input.value; });
      input.addEventListener("change", () => { state.documentMeta[input.dataset.metaField] = input.value; render(); });
    });
    const legacyFile = document.querySelector("[data-legacy-file]");
    if (legacyFile) legacyFile.addEventListener("change", () => importLegacyFile(legacyFile.files?.[0]));
    const standardFile = document.querySelector("[data-standard-file]");
    if (standardFile) standardFile.addEventListener("change", () => importStandardFile(standardFile.files?.[0]));
    document.querySelectorAll("[data-process-group]").forEach(item => {
      item.addEventListener("dragstart", event => {
        state.draggingProcessId = item.dataset.processGroup;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", state.draggingProcessId);
        item.classList.add("dragging");
      });
      item.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; item.classList.add("drag-target"); });
      item.addEventListener("dragleave", () => item.classList.remove("drag-target"));
      item.addEventListener("drop", event => {
        event.preventDefault();
        const sourceId = state.draggingProcessId || event.dataTransfer.getData("text/plain");
        const targetId = item.dataset.processGroup;
        if (!sourceId || sourceId === targetId) return;
        const sourceIndex = state.processOrder.indexOf(sourceId);
        if (sourceIndex < 0) return;
        state.processOrder.splice(sourceIndex, 1);
        const targetIndex = state.processOrder.indexOf(targetId);
        state.processOrder.splice(targetIndex, 0, sourceId);
        state.draggingProcessId = null;
        state.editorOpen = true;
        render();
      });
      item.addEventListener("dragend", () => { state.draggingProcessId = null; item.classList.remove("dragging"); document.querySelectorAll(".drag-target").forEach(node => node.classList.remove("drag-target")); });
    });
    document.querySelectorAll("[data-remove-process]").forEach(button => button.addEventListener("click", () => {
      state.processOrder = state.processOrder.filter(id => id !== button.dataset.removeProcess);
      state.editorOpen = true;
      render();
    }));
    document.querySelectorAll("[data-move-process]").forEach(button => button.addEventListener("click", () => {
      const item = button.closest("[data-process-group]");
      const index = state.processOrder.indexOf(item.dataset.processGroup);
      const targetIndex = button.dataset.moveProcess === "up" ? index - 1 : index + 1;
      if (index < 0 || targetIndex < 0 || targetIndex >= state.processOrder.length) return;
      [state.processOrder[index], state.processOrder[targetIndex]] = [state.processOrder[targetIndex], state.processOrder[index]];
      state.editorOpen = true;
      render();
    }));
    const addProcess = document.querySelector("[data-add-process]");
    if (addProcess) addProcess.addEventListener("click", () => {
      const nameInput = document.querySelector("[data-new-process-name]");
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const id = `custom-process-${state.nextProcessNumber++}`;
      state.customProcesses[id] = {
        id,
        name,
        flow_symbol: document.querySelector("[data-new-process-symbol]").value,
        flow_branch: document.querySelector("[data-new-process-branch]").value,
      };
      state.processOrder.push(id);
      state.editorOpen = true;
      render();
    });
    const resetProcesses = document.querySelector("[data-reset-processes]");
    if (resetProcesses) resetProcesses.addEventListener("click", () => {
      state.processOrder = state.data.qc.processSteps.map(step => step.id);
      state.customProcesses = {};
      state.editorOpen = true;
      render();
    });
  }

  function initializeData(data, options = {}) {
    state.data = data;
    state.onlineMode = Boolean(options.onlineMode);
    state.documentMeta = initDocumentMeta();
    state.standardImport = {
      fileName: options.fileName || data.rnd.product.sourceFile,
      message: options.message || "已載入目前的外來標準文件。",
      error: false,
      loading: false,
    };
    state.processOrder = data.qc.processSteps.map(step => step.id);
    if (!globalListenersBound) {
      window.addEventListener("resize", () => requestAnimationFrame(alignFlowOverlays));
      window.addEventListener("beforeprint", alignFlowOverlays);
      window.addEventListener("afterprint", () => requestAnimationFrame(alignFlowOverlays));
      globalListenersBound = true;
    }
    render();
  }

  function onlineSetupView() {
    return `<header class="topbar"><div class="brand"><div class="brand-mark">QC</div><div><strong>美達食品 QC 工程圖</strong><small>GitHub 線上版・瀏覽器內文件解析</small></div></div></header>
      <main class="page online-setup-page">
        <section class="online-setup-hero"><p class="eyebrow">ONLINE SETUP</p><h1>開始建立 QC 工程圖</h1><p>QC 母版已內建完成。請匯入外來標準；若有同產品的舊版 QC 工程圖，也可一起匯入以延續文件編號、制定日期、版次與修訂履歷。</p></section>
        <section class="online-setup-panel">
          <div class="online-file-grid">
            <label class="online-file-card required"><span class="online-file-number">1</span><div><h2>外來標準文件 <em>必要</em></h2><p>研發或委託廠商提供的產品標準</p><strong data-online-rnd-name>尚未選擇檔案</strong></div><input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" data-online-rnd></label>
            <label class="online-file-card"><span class="online-file-number">2</span><div><h2>舊版 QC 工程圖 <em>選填</em></h2><p>支援舊式 .doc、新版 .docx、巨集文件與 Word 範本</p><strong data-online-legacy-name>沒有舊版可不選</strong></div><input type="file" accept="${LEGACY_WORD_ACCEPT}" data-online-legacy></label>
          </div>
          <button class="btn btn-accent online-start-button" type="button" data-online-start disabled>開始解析並建立工程圖</button>
          <p class="online-setup-status" data-online-status>外來標準請使用 .docx；舊版 QC 可直接選擇各版本 Word 文件。</p>
        </section>
        <div class="online-privacy-note"><strong>檔案隱私：</strong>文件只會進入此分頁的暫存記憶體，關閉或重新整理後即清除。網站載入解析核心時需要網路連線。</div>
      </main>`;
  }

  function showOnlineSetup() {
    app.innerHTML = onlineSetupView();
    const rndInput = document.querySelector("[data-online-rnd]");
    const legacyInput = document.querySelector("[data-online-legacy]");
    const startButton = document.querySelector("[data-online-start]");
    const status = document.querySelector("[data-online-status]");
    const updateSelection = () => {
      document.querySelector("[data-online-rnd-name]").textContent = rndInput.files?.[0]?.name || "尚未選擇檔案";
      document.querySelector("[data-online-legacy-name]").textContent = legacyInput.files?.[0]?.name || "沒有舊版可不選";
      startButton.disabled = !rndInput.files?.[0];
    };
    rndInput.addEventListener("change", updateSelection);
    legacyInput.addEventListener("change", updateSelection);
    startButton.addEventListener("click", async () => {
      const rndFile = rndInput.files?.[0];
      const legacyFile = legacyInput.files?.[0];
      if (!rndFile) return;
      startButton.disabled = true;
      status.classList.remove("error");
      try {
        const result = await window.QcBrowserRuntime.buildBundle(rndFile, message => { status.textContent = message; });
        if (!result.ok || !result.data?.rnd?.parameterCount) throw new Error("找不到可解析的產品規格或標準項目");
        initializeData(result.data, {
          onlineMode: true,
          fileName: rndFile.name,
          message: `已在瀏覽器完成 ${result.report.rndParameters} 項規格解析與 ${result.report.autoMapped} 項自動對應；檔案未上傳。`,
        });
        if (legacyFile) await importLegacyFile(legacyFile);
      } catch (error) {
        status.textContent = `解析失敗：${error.message}`;
        status.classList.add("error");
        startButton.disabled = false;
      }
    });
  }

  async function loadInitialData() {
    const isGitHubPages = window.location.hostname.toLowerCase().endsWith("github.io");
    if (isGitHubPages) { showOnlineSetup(); return; }
    try {
      const apiResponse = await fetch("/api/data");
      if (!apiResponse.ok) throw new Error(`HTTP ${apiResponse.status}`);
      initializeData(await apiResponse.json());
    } catch (apiError) {
      try {
        const staticResponse = await fetch("data.json");
        if (!staticResponse.ok) throw new Error(`HTTP ${staticResponse.status}`);
        initializeData(await staticResponse.json());
      } catch (staticError) {
        showOnlineSetup();
      }
    }
  }

  loadInitialData();
}());
