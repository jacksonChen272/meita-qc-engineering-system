const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
  const standardPath = process.argv[2];
  const baseUrl = process.argv[3] || "http://127.0.0.1:8890/";
  if (!standardPath) throw new Error("Usage: node tests/template-manager-browser-qa.cjs <standard.docx> [baseUrl]");

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.QC_BROWSER_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => failedRequests.push(`${request.url()} ${request.failure()?.errorText || "failed"}`));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("[data-open-template-manager]").click();
  await page.waitForSelector(".template-manager-shell");
  await page.locator("[data-tm-process-name]").fill("自訂測試工程");
  await page.locator("[data-tm-process-name]").press("Tab");
  await page.locator("[data-tm-save]").click();
  await page.locator("[data-tm-status]").filter({ hasText: "已儲存" }).waitFor();

  const customName = await page.evaluate(async () => {
    const manager = await import("./template-manager.mjs");
    return manager.getCustomTemplate("nutrition")?.processSteps?.[0]?.name;
  });
  if (customName !== "自訂測試工程") throw new Error(`自訂母版未寫入 localStorage：${customName}`);

  await page.locator("[data-tm-close]").click();
  await page.waitForSelector(".online-setup-page");
  if (await page.locator(".template-custom-badge").count() !== 1) throw new Error("開始畫面沒有顯示自訂母版狀態");
  await page.locator('[data-online-template][value="nutrition"]').check();
  await page.setInputFiles("[data-online-rnd]", path.resolve(standardPath));
  await page.locator("[data-online-start]").click();
  await page.waitForSelector(".standard-import-panel", { timeout: 120000 });
  await page.locator('.topnav [data-view="preview"]').click();
  await page.waitForSelector(".qc-table");
  if (await page.getByText("自訂測試工程", { exact: true }).count() < 1) throw new Error("建立工程圖時沒有套用自訂母版");
  if (pageErrors.length) throw new Error(`瀏覽器錯誤：${pageErrors.join(" | ")}`);
  if (failedRequests.length) throw new Error(`資產載入失敗：${failedRequests.join(" | ")}`);

  console.log(JSON.stringify({ customName, customBadge: true, appliedToPreview: true, pageErrors, failedRequests }, null, 2));
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
