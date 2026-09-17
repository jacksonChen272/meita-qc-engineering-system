(function () {
  "use strict";

  const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v314.0.6/full/";
  const PDFJS_MODULE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs";
  const PYTHON_SOURCES = [
    "build.py",
    "diff/__init__.py", "diff/compare.py", "diff/normalize.py",
    "domain/__init__.py", "domain/control_item.py", "domain/process_step.py", "domain/product.py", "domain/source_trace.py",
    "mapping/__init__.py", "mapping/parameter_mapping.py", "mapping/process_mapping.py",
    "parsers/__init__.py", "parsers/docx_utils.py", "parsers/legacy_doc_metadata.py", "parsers/qc_template_parser.py", "parsers/rnd_docx_parser.py", "parsers/rnd_pdf_parser.py",
    "render/__init__.py", "render/flow_renderer.py", "render/pagination.py", "render/qc_html_renderer.py",
    "templates/__init__.py", "templates/qc_template.py",
  ];

  let readyPromise = null;
  let pdfJsPromise = null;
  let ocrRuntimePromise = null;
  let pyodide = null;
  const qcTemplatePromises = new Map();
  const QC_TEMPLATE_FILES = {
    nutrition: "qc-template-nutrition.json",
    sauce_pack: "qc-template-sauce-pack.json",
  };

  function safeFileName(file) {
    return String(file.name || "document.docx").replace(/[\\/]/g, "_");
  }

  function safeOpenXmlName(file, prefix) {
    const stem = safeFileName(file).replace(/\.[^.]+$/, "") || "document";
    return `${prefix ? `${prefix}-` : ""}${stem}.docx`;
  }

  function isPdf(file) {
    return String(file?.name || "").toLowerCase().endsWith(".pdf") || file?.type === "application/pdf";
  }

  async function loadPdfJs() {
    if (!pdfJsPromise) {
      pdfJsPromise = import(PDFJS_MODULE).then(module => {
        module.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        return module;
      });
    }
    return pdfJsPromise;
  }

  async function loadOcrRuntime() {
    if (!ocrRuntimePromise) ocrRuntimePromise = import("./ocr-runtime.mjs");
    return ocrRuntimePromise;
  }

  function pipelineError(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.name = "QcPipelineError";
    return error;
  }

  function textLine(items) {
    const ordered = items.sort((left, right) => left.x - right.x);
    let output = "";
    let previous = null;
    for (const item of ordered) {
      const value = String(item.text || "").trim();
      if (!value) continue;
      if (previous) {
        const gap = item.x - (previous.x + previous.width);
        if (gap > Math.max(1.2, Math.min(previous.height, item.height) * 0.1)) output += " ";
      }
      output += value;
      previous = item;
    }
    return output.trim();
  }

  async function renderOcrCanvas(page) {
    const baseViewport = page.getViewport({ scale: 1 });
    const targetScale = 300 / 72;
    const maxPixels = 10000000;
    const safeScale = Math.min(targetScale, Math.sqrt(maxPixels / (baseViewport.width * baseViewport.height)));
    const viewport = page.getViewport({ scale: safeScale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;

    // The source scans use pale blue rules and stamps. Converting to a high-
    // contrast black/white page gives Traditional Chinese OCR much cleaner
    // digits, ranges and degree symbols while keeping the document local.
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < image.data.length; index += 4) {
      const gray = (image.data[index] * 0.299) + (image.data[index + 1] * 0.587) + (image.data[index + 2] * 0.114);
      const value = gray > 180 ? 255 : 0;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  async function extractPdfText(file, onStatus) {
    let pdfBytes;
    try {
      pdfBytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      throw pipelineError("PDF 讀取失敗：無法讀取所選檔案。", error);
    }

    let loadingTask = null;
    let pdf = null;
    try {
      const pdfjs = await loadPdfJs();
      loadingTask = pdfjs.getDocument({ data: pdfBytes });
      pdf = await loadingTask.promise;
    } catch (error) {
      try { await loadingTask?.destroy(); } catch { /* PDF cleanup is best-effort. */ }
      throw pipelineError("PDF 讀取失敗：檔案可能已損毀、加密或 PDF 元件無法載入。", error);
    }

    const pageRecords = [];
    let activeOcrPage = 0;
    let lastOcrPercent = -1;
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        onStatus?.(`正在擷取 PDF 第 ${pageNumber}／${pdf.numPages} 頁…`);
        let page;
        try {
          page = await pdf.getPage(pageNumber);
        } catch (error) {
          throw pipelineError(`PDF 讀取失敗：無法開啟第 ${pageNumber} 頁。`, error);
        }
        const record = { pageNumber, page, pageText: "" };
        pageRecords.push(record);
        let content;
        try {
          content = await page.getTextContent();
        } catch (error) {
          throw pipelineError(`PDF 文字擷取失敗：無法讀取第 ${pageNumber} 頁的文字層。`, error);
        }
        const rows = [];
        for (const item of content.items) {
          if (!item.str || !item.transform) continue;
          const x = Number(item.transform[4] || 0);
          const y = Number(item.transform[5] || 0);
          const height = Math.max(1, Math.abs(Number(item.height || item.transform[3] || 1)));
          let row = rows.find(candidate => Math.abs(candidate.y - y) <= Math.max(2, height * 0.22));
          if (!row) {
            row = { y, items: [] };
            rows.push(row);
          }
          row.items.push({ x, width: Number(item.width || 0), height, text: item.str });
        }
        const lines = rows.sort((left, right) => right.y - left.y).map(row => textLine(row.items)).filter(Boolean);
        record.pageText = lines.join("\n");
      }

      const ocrRuntime = await loadOcrRuntime();
      const ocrRun = await ocrRuntime.withOcrIfNeeded(
        pageRecords.map(record => record.pageText),
        () => ocrRuntime.createConfiguredWorker({
          logger(message) {
            if (message.status !== "recognizing text") return;
            const percent = Math.round(Number(message.progress || 0) * 100);
            if (percent === lastOcrPercent || (percent % 5 !== 0 && percent !== 100)) return;
            lastOcrPercent = percent;
            onStatus?.(`正在 OCR 第 ${activeOcrPage}／${pdf.numPages} 頁… ${percent}%`);
          },
        }),
        async worker => {
          const pages = [];
          for (const record of pageRecords) {
            if (!ocrRuntime.shouldUseOcr(record.pageText)) {
              pages.push(`===PAGE ${record.pageNumber}===\n${record.pageText}`);
              continue;
            }
            activeOcrPage = record.pageNumber;
            lastOcrPercent = -1;
            onStatus?.(`第 ${record.pageNumber}／${pdf.numPages} 頁是掃描影像，正在執行 OCR…`);
            let canvas = null;
            try {
              try {
                canvas = await renderOcrCanvas(record.page);
              } catch (error) {
                throw pipelineError(`PDF 轉圖片失敗：無法轉換第 ${record.pageNumber} 頁。`, error);
              }
              let result;
              try {
                result = await worker.recognize(canvas);
              } catch (error) {
                throw pipelineError(`OCR 辨識失敗：第 ${record.pageNumber} 頁辨識時發生錯誤。`, error);
              }
              const ocrText = ocrRuntime.ensureOcrText(result?.data?.text, record.pageNumber);
              pages.push(`===PAGE ${record.pageNumber}===\n===OCR===\n${ocrText}`);
            } finally {
              if (canvas) {
                canvas.width = 1;
                canvas.height = 1;
              }
            }
          }
          return pages.join("\n");
        },
      );
      if (!ocrRun.used) {
        return pageRecords.map(record => `===PAGE ${record.pageNumber}===\n${record.pageText}`).join("\n");
      }
      return ocrRun.value;
    } finally {
      for (const record of pageRecords) {
        try { record.page.cleanup(); } catch { /* Page cleanup is best-effort. */ }
      }
      try { await loadingTask?.destroy(); } catch { /* PDF cleanup is best-effort. */ }
    }
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

  async function loadQcTemplate(templateKey) {
    const safeKey = Object.prototype.hasOwnProperty.call(QC_TEMPLATE_FILES, templateKey) ? templateKey : "";
    if (!safeKey) throw new Error("請先選擇 QC 工程圖母版。");
    if (!qcTemplatePromises.has(safeKey)) {
      qcTemplatePromises.set(safeKey, fetch(QC_TEMPLATE_FILES[safeKey], { cache: "no-store" }).then(response => {
        if (!response.ok) throw new Error("網站缺少所選 QC 母版，請通知系統管理者。");
        return response.text();
      }));
    }
    return qcTemplatePromises.get(safeKey);
  }

  async function buildFromFile(rndFile, templateKey, onStatus) {
    await initialize(onStatus);
    onStatus?.("正在使用內建母版解析外來標準…");
    const qcJson = await loadQcTemplate(templateKey);
    if (isPdf(rndFile)) {
      const pdfText = await extractPdfText(rndFile, onStatus);
      pyodide.globals.set("qc_json_js", qcJson);
      pyodide.globals.set("pdf_text_js", pdfText);
      pyodide.globals.set("pdf_name_js", safeFileName(rndFile));
      try {
        const output = await pyodide.runPythonAsync(`
import json
from build import build_bundle_from_rnd
from parsers import parse_rnd_pdf_text
_rnd = parse_rnd_pdf_text(pdf_text_js, pdf_name_js)
_bundle, _report = build_bundle_from_rnd(json.loads(qc_json_js), _rnd)
json.dumps({"ok": True, "data": _bundle, "report": _report}, ensure_ascii=False)
`);
        const result = JSON.parse(output);
        if (!result.data?.rnd?.parameterCount) {
          throw new Error("找不到可解析的產品規格或製程條件。");
        }
        return result;
      } catch (error) {
        throw pipelineError(`工程圖欄位解析失敗：${error.message || "無法建立 PDF 欄位資料。"}`, error);
      }
    }
    const rndPath = await writeDocument(rndFile, "");
    pyodide.globals.set("qc_json_js", qcJson);
    pyodide.globals.set("rnd_path_js", rndPath);
    try {
      const output = await pyodide.runPythonAsync(`
import json
from pathlib import Path
from build import build_bundle_from_qc
_bundle, _report = build_bundle_from_qc(json.loads(qc_json_js), Path(rnd_path_js))
json.dumps({"ok": True, "data": _bundle, "report": _report}, ensure_ascii=False)
`);
      const result = JSON.parse(output);
      if (!result.data?.rnd?.parameterCount) {
        throw new Error("找不到可解析的產品規格或製程條件。");
      }
      return result;
    } catch (error) {
      throw pipelineError(`工程圖欄位解析失敗：${error.message || "無法建立 Word 欄位資料。"}`, error);
    }
  }

  async function buildBundle(rndFile, templateKey, onStatus) {
    return buildFromFile(rndFile, templateKey, onStatus);
  }

  async function importStandard(file, templateKey, onStatus) {
    return buildFromFile(file, templateKey, onStatus);
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
