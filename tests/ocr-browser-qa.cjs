const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
  const pdfPath = process.argv[2];
  const baseUrl = process.argv[3] || "http://127.0.0.1:8890/";
  if (!pdfPath) throw new Error("Usage: node tests/ocr-browser-qa.cjs <scanned.pdf> [baseUrl]");

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.QC_BROWSER_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const pageErrors = [];
  const failedRequests = [];
  const requestedUrls = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => requestedUrls.push(request.url()));
  page.on("requestfailed", request => failedRequests.push(`${request.url()} ${request.failure()?.errorText || "failed"}`));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector(".online-setup-page");
  await page.locator('[data-online-template][value="sauce_pack"]').check();
  await page.setInputFiles("[data-online-rnd]", path.resolve(pdfPath));
  await page.locator("[data-online-start]").click();
  await page.waitForSelector(".standard-import-panel", { timeout: 180000 });

  const status = await page.locator(".standard-import-status").innerText();
  const match = status.match(/完成\s+(\d+)\s+項規格解析與\s+(\d+)\s+項自動對應/);
  if (!match) throw new Error(`掃描 PDF 沒有完成工程圖解析：${status}`);
  if (Number(match[1]) < 15 || Number(match[2]) < 10) throw new Error(`OCR／欄位對應數量異常：${status}`);
  if (pageErrors.length) throw new Error(`瀏覽器錯誤：${pageErrors.join(" | ")}`);
  if (failedRequests.length) throw new Error(`資產載入失敗：${failedRequests.join(" | ")}`);

  const tesseractRequests = requestedUrls.filter(url => /tesseract|tessdata|traineddata/i.test(url));
  if (!tesseractRequests.some(url => url.includes("/vendor/tesseract.js/worker.min.js"))) {
    throw new Error("未從 production site 載入 Tesseract worker");
  }
  if (!tesseractRequests.some(url => url.includes("/vendor/tesseract.js-core/"))) {
    throw new Error("未從 production site 載入 Tesseract core/WASM");
  }
  if (!tesseractRequests.some(url => url.includes("/vendor/tessdata/chi_tra.traineddata.gz"))) {
    throw new Error("未從 production site 載入 chi_tra 語言資料");
  }
  if (!tesseractRequests.some(url => url.includes("/vendor/tessdata/eng.traineddata.gz"))) {
    throw new Error("未從 production site 載入 eng 語言資料");
  }
  if (tesseractRequests.some(url => /cdn\.jsdelivr\.net\/npm\/tesseract/i.test(url))) {
    throw new Error("OCR 仍從 Tesseract CDN 載入，而不是 production site");
  }

  console.log(JSON.stringify({
    status,
    parsedParameters: Number(match[1]),
    mappedParameters: Number(match[2]),
    localOcrAssets: tesseractRequests.length,
    pageErrors,
    failedRequests,
  }, null, 2));
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
