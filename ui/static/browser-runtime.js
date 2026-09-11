(function () {
  "use strict";

  const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v314.0.6/full/";
  const PYTHON_SOURCES = [
    "build.py",
    "diff/__init__.py", "diff/compare.py", "diff/normalize.py",
    "domain/__init__.py", "domain/control_item.py", "domain/process_step.py", "domain/product.py", "domain/source_trace.py",
    "mapping/__init__.py", "mapping/parameter_mapping.py", "mapping/process_mapping.py",
    "parsers/__init__.py", "parsers/docx_utils.py", "parsers/legacy_doc_metadata.py", "parsers/qc_template_parser.py", "parsers/rnd_docx_parser.py",
    "render/__init__.py", "render/flow_renderer.py", "render/pagination.py", "render/qc_html_renderer.py",
    "templates/__init__.py", "templates/qc_template.py",
  ];

  let readyPromise = null;
  let pyodide = null;
  let qcTemplatePromise = null;

  function safeFileName(file) {
    return String(file.name || "document.docx").replace(/[\\/]/g, "_");
  }

  function safeOpenXmlName(file, prefix) {
    const stem = safeFileName(file).replace(/\.[^.]+$/, "") || "document";
    return `${prefix ? `${prefix}-` : ""}${stem}.docx`;
  }

  async function initialize(onStatus) {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      onStatus?.("正在載入線上文件解析核心，第一次約需數秒…");
      if (typeof window.loadPyodide !== "function") throw new Error("線上解析核心載入失敗，請確認網路可連線至 CDN。");
      pyodide = await window.loadPyodide({ indexURL: PYODIDE_INDEX });
      pyodide.FS.mkdirTree("/app");
      const sources = await Promise.all(PYTHON_SOURCES.map(async source => {
        const response = await fetch(source, { cache: "no-store" });
        if (!response.ok) throw new Error(`找不到線上解析程式：${source}`);
        return [source, await response.text()];
      }));
      for (const [source, content] of sources) {
        const target = `/app/${source}`;
        pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
        pyodide.FS.writeFile(target, content, { encoding: "utf8" });
      }
      await pyodide.runPythonAsync('import sys\nif "/app" not in sys.path: sys.path.insert(0, "/app")');
      return pyodide;
    })();
    try { return await readyPromise; }
    catch (error) { readyPromise = null; throw error; }
  }

  async function writeDocument(file, prefix) {
    if (!file || !file.name.toLowerCase().endsWith(".docx")) throw new Error("外來標準文件目前只接受 .docx。");
    const path = `/tmp/${prefix ? `${prefix}-` : ""}${safeFileName(file)}`;
    pyodide.FS.writeFile(path, new Uint8Array(await file.arrayBuffer()));
    return path;
  }

  function writeOpenXmlBytes(file, prefix, bytes) {
    const path = `/tmp/${safeOpenXmlName(file, prefix)}`;
    pyodide.FS.writeFile(path, bytes);
    return path;
  }

  async function loadQcTemplate() {
    if (!qcTemplatePromise) {
      qcTemplatePromise = fetch("qc-template.json", { cache: "no-store" }).then(response => {
        if (!response.ok) throw new Error("網站缺少內建 QC 母版，請通知系統管理者。");
        return response.text();
      });
    }
    return qcTemplatePromise;
  }

  async function buildBundle(rndFile, onStatus) {
    await initialize(onStatus);
    onStatus?.("正在使用內建母版解析外來標準…");
    const qcJson = await loadQcTemplate();
    const rndPath = await writeDocument(rndFile, "");
    pyodide.globals.set("qc_json_js", qcJson);
    pyodide.globals.set("rnd_path_js", rndPath);
    const output = await pyodide.runPythonAsync(`
import json
from pathlib import Path
from build import build_bundle_from_qc
_bundle, _report = build_bundle_from_qc(json.loads(qc_json_js), Path(rnd_path_js))
json.dumps({"ok": True, "data": _bundle, "report": _report}, ensure_ascii=False)
`);
    return JSON.parse(output);
  }

  async function importStandard(file, onStatus) {
    await initialize(onStatus);
    const qcJson = await loadQcTemplate();
    const rndPath = await writeDocument(file, "");
    pyodide.globals.set("qc_json_js", qcJson);
    pyodide.globals.set("rnd_path_js", rndPath);
    const output = await pyodide.runPythonAsync(`
import json
from pathlib import Path
from build import build_bundle_from_qc
_bundle, _report = build_bundle_from_qc(json.loads(qc_json_js), Path(rnd_path_js))
json.dumps({"ok": True, "data": _bundle, "report": _report}, ensure_ascii=False)
`);
    return JSON.parse(output);
  }

  async function importLegacy(file, onStatus) {
    onStatus?.("正在解析舊版 QC 工程圖…");
    if (!file) throw new Error("請選擇舊版 QC 工程圖。");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parser = window.QcLegacyWordParser;
    if (!parser) throw new Error("Word 檔案解析元件未載入，請重新整理後再試。");
    const format = parser.detectFormat(file.name, bytes);
    if (format === "binary") {
      return { ok: true, metadata: parser.parseBinary(bytes, window.docToText) };
    }
    if (format !== "openxml") {
      throw new Error("不支援此檔案；請選擇 Word 的 .doc、.docx、.docm、.dot、.dotx 或 .dotm 文件。");
    }
    await initialize(onStatus);
    const legacyPath = writeOpenXmlBytes(file, "legacy", bytes);
    pyodide.globals.set("legacy_path_js", legacyPath);
    const output = await pyodide.runPythonAsync(`
import json
from pathlib import Path
from parsers import parse_legacy_metadata
json.dumps({"ok": True, "metadata": parse_legacy_metadata(Path(legacy_path_js))}, ensure_ascii=False)
`);
    return JSON.parse(output);
  }

  window.QcBrowserRuntime = { buildBundle, importLegacy, importStandard };
}());
