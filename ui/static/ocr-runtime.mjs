const OCR_ASSET_PATHS = Object.freeze({
  moduleUrl: new URL("./vendor/tesseract.js/tesseract.esm.min.js", import.meta.url).href,
  workerPath: new URL("./vendor/tesseract.js/worker.min.js", import.meta.url).href,
  corePath: new URL("./vendor/tesseract.js-core/", import.meta.url).href,
  langPath: new URL("./vendor/tessdata/", import.meta.url).href.replace(/\/$/, ""),
});

export class OcrStageError extends Error {
  constructor(stage, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "OcrStageError";
    this.stage = stage;
  }
}

export function shouldUseOcr(text, minimumCharacters = 30) {
  return String(text || "").replace(/\s/g, "").length < minimumCharacters;
}

export function resolveTesseractModule(moduleNamespace) {
  const defaultExport = moduleNamespace?.default || {};
  const createWorker = moduleNamespace?.createWorker || defaultExport.createWorker;
  const PSM = moduleNamespace?.PSM || defaultExport.PSM;
  const OEM = moduleNamespace?.OEM || defaultExport.OEM;
  if (typeof createWorker !== "function") {
    throw new OcrStageError(
      "OCR_ENGINE_INIT",
      "OCR 引擎初始化失敗：已載入 tesseract.js，但找不到 createWorker API。",
    );
  }
  if (!PSM?.SPARSE_TEXT) {
    throw new OcrStageError(
      "OCR_ENGINE_INIT",
      "OCR 引擎初始化失敗：tesseract.js 缺少 PSM 設定。",
    );
  }
  return { createWorker, PSM, OEM };
}

export async function loadTesseractApi({
  importer = specifier => import(specifier),
  moduleUrl = OCR_ASSET_PATHS.moduleUrl,
} = {}) {
  try {
    return resolveTesseractModule(await importer(moduleUrl));
  } catch (error) {
    if (error instanceof OcrStageError) throw error;
    throw new OcrStageError(
      "OCR_ENGINE_INIT",
      "OCR 引擎初始化失敗：無法載入本機 tesseract.js 模組。",
      error,
    );
  }
}

function isLanguageDataError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return /traineddata|language|lang path|chi_tra|eng\.traineddata/.test(message);
}

export async function terminateOcrWorker(worker) {
  if (!worker || typeof worker.terminate !== "function") return;
  try {
    await worker.terminate();
  } catch {
    // Cleanup failure must not hide the original OCR/PDF error.
  }
}

export async function createConfiguredWorker({
  logger = () => {},
  importer,
  paths = OCR_ASSET_PATHS,
} = {}) {
  const { createWorker, PSM, OEM } = await loadTesseractApi({ importer, moduleUrl: paths.moduleUrl });
  let worker = null;
  try {
    worker = await createWorker(["chi_tra", "eng"], OEM?.LSTM_ONLY ?? 1, {
      workerPath: paths.workerPath,
      corePath: paths.corePath,
      langPath: paths.langPath,
      logger,
    });
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    return worker;
  } catch (error) {
    await terminateOcrWorker(worker);
    if (error instanceof OcrStageError) throw error;
    if (isLanguageDataError(error)) {
      throw new OcrStageError(
        "OCR_LANGUAGE_LOAD",
        "OCR 語言資料載入失敗：無法載入繁體中文／英文辨識資料。",
        error,
      );
    }
    throw new OcrStageError(
      "OCR_ENGINE_INIT",
      "OCR 引擎初始化失敗：Worker、WASM 或核心檔案無法載入。",
      error,
    );
  }
}

export async function withManagedOcrWorker(factory, operation) {
  let worker = null;
  try {
    worker = await factory();
    return await operation(worker);
  } finally {
    await terminateOcrWorker(worker);
  }
}

export async function withOcrIfNeeded(pageTexts, factory, operation) {
  if (!pageTexts.some(text => shouldUseOcr(text))) {
    return { used: false, value: null };
  }
  return { used: true, value: await withManagedOcrWorker(factory, operation) };
}

export function ensureOcrText(text, pageNumber) {
  const result = String(text || "").trim();
  if (result.replace(/\s/g, "").length < 20) {
    throw new OcrStageError(
      "OCR_RECOGNITION",
      `OCR 辨識失敗：第 ${pageNumber} 頁沒有辨識到足夠文字，請確認掃描頁清晰且方向正確。`,
    );
  }
  return result;
}

export { OCR_ASSET_PATHS };
