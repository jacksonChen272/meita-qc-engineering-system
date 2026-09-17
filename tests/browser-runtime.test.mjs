import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  OcrStageError,
  createConfiguredWorker,
  ensureOcrText,
  loadTesseractApi,
  shouldUseOcr,
  withManagedOcrWorker,
  withOcrIfNeeded,
} from "../ui/static/ocr-runtime.mjs";

const root = resolve(import.meta.dirname, "..");

test("installed browser build exposes createWorker through its default ESM export", async () => {
  globalThis.self = globalThis;
  const source = await readFile(resolve(root, "node_modules/tesseract.js/dist/tesseract.esm.min.js"), "utf8");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const api = await loadTesseractApi({ importer: () => import(moduleUrl), moduleUrl });
  assert.equal(typeof api.createWorker, "function");
  assert.equal(typeof api.PSM.SPARSE_TEXT, "string");
});

test("dependencies use tesseract.js and never the incompatible tesseract package", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  assert.equal(packageJson.dependencies["tesseract.js"], "7.0.0");
  assert.equal(packageJson.dependencies.tesseract, undefined);
  assert.ok(lock.packages["node_modules/tesseract.js"]);
  assert.equal(lock.packages["node_modules/tesseract"], undefined);
});

test("text PDF pages do not initialize OCR", async () => {
  let factoryCalls = 0;
  const result = await withOcrIfNeeded(
    ["這是一個具有完整可擷取文字層的產品標準 PDF，因此不應該啟動 OCR Worker。"],
    async () => {
      factoryCalls += 1;
      return { terminate: async () => {} };
    },
    async () => "unexpected",
  );
  assert.equal(result.used, false);
  assert.equal(factoryCalls, 0);
  assert.equal(shouldUseOcr("完整文字型 PDF 頁面，字數已經足夠直接解析，不需要額外辨識。"), false);
});

test("scanned PDF pages enter OCR and release the worker", async () => {
  let factoryCalls = 0;
  let terminated = 0;
  const worker = { terminate: async () => { terminated += 1; } };
  const result = await withOcrIfNeeded(
    [""],
    async () => {
      factoryCalls += 1;
      return worker;
    },
    async received => {
      assert.equal(received, worker);
      return "recognized";
    },
  );
  assert.equal(result.used, true);
  assert.equal(result.value, "recognized");
  assert.equal(factoryCalls, 1);
  assert.equal(terminated, 1);
});

test("OCR recognition errors still release the worker", async () => {
  let terminated = 0;
  const expected = new Error("recognize failed");
  await assert.rejects(
    withManagedOcrWorker(
      async () => ({ terminate: async () => { terminated += 1; } }),
      async () => { throw expected; },
    ),
    error => error === expected,
  );
  assert.equal(terminated, 1);
});

test("worker uses the tesseract.js 7 initialization API and both OCR languages", async () => {
  let createWorkerArgs = null;
  let configuredParameters = null;
  let terminated = 0;
  const worker = {
    setParameters: async parameters => { configuredParameters = parameters; },
    terminate: async () => { terminated += 1; },
  };
  const fakeModule = {
    default: {
      createWorker: async (...args) => {
        createWorkerArgs = args;
        return worker;
      },
      PSM: { SPARSE_TEXT: "11" },
      OEM: { LSTM_ONLY: 1 },
    },
  };

  await withManagedOcrWorker(
    () => createConfiguredWorker({
      importer: async () => fakeModule,
      paths: { moduleUrl: "module", workerPath: "worker", corePath: "core", langPath: "lang" },
    }),
    async received => assert.equal(received, worker),
  );

  assert.deepEqual(createWorkerArgs.slice(0, 2), [["chi_tra", "eng"], 1]);
  assert.deepEqual(createWorkerArgs[2], {
    workerPath: "worker",
    corePath: "core",
    langPath: "lang",
    logger: createWorkerArgs[2].logger,
  });
  assert.equal(configuredParameters.tessedit_pageseg_mode, "11");
  assert.equal(terminated, 1);
});

test("language initialization failures are classified and release a created worker", async () => {
  let terminated = 0;
  const worker = {
    setParameters: async () => { throw new Error("chi_tra.traineddata missing"); },
    terminate: async () => { terminated += 1; },
  };
  const fakeModule = {
    default: {
      createWorker: async () => worker,
      PSM: { SPARSE_TEXT: "11" },
      OEM: { LSTM_ONLY: 1 },
    },
  };
  await assert.rejects(
    createConfiguredWorker({
      importer: async () => fakeModule,
      paths: { moduleUrl: "mock", workerPath: "worker", corePath: "core", langPath: "lang" },
    }),
    error => error instanceof OcrStageError
      && error.stage === "OCR_LANGUAGE_LOAD"
      && error.message.startsWith("OCR 語言資料載入失敗"),
  );
  assert.equal(terminated, 1);
});

test("unrecognizable OCR output returns a clear page-specific error", () => {
  assert.throws(
    () => ensureOcrText("  ", 3),
    error => error instanceof OcrStageError
      && error.stage === "OCR_RECOGNITION"
      && error.message.includes("第 3 頁"),
  );
});
