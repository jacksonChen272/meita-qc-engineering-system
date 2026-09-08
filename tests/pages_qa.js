const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const baseUrl = process.argv[2] || "http://127.0.0.1:8890/";
  const outputDir = process.argv[3] || process.cwd();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.QC_BROWSER_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".online-setup-page", { timeout: 30000 });
  if (await page.locator("[data-online-qc]").count()) throw new Error("線上版仍要求使用者重複匯入 QC 母版");
  if (!(await page.locator(".online-setup-hero").innerText()).includes("QC 母版已內建")) throw new Error("線上版沒有顯示內建母版");
  await page.screenshot({ path: path.join(outputDir, "qa-online-setup.png") });
  await page.setInputFiles("[data-online-rnd]", path.join(__dirname, "..", "input", "rnd-standard.docx"));
  await page.locator("[data-online-start]").click();
  await page.waitForSelector(".standard-import-panel", { timeout: 180000 });
  const panel = await page.locator(".standard-import-panel").innerText();
  if (!panel.includes("82 項規格") || !panel.includes("檔案未上傳")) throw new Error("線上版沒有完成瀏覽器內解析");
  await page.locator('[data-view="preview"]').first().click();
  await page.waitForSelector(".cover-sheet");
  if (await page.locator(".qc-sheet").count() !== 8) throw new Error("線上版預覽不是 8 頁");
  await page.screenshot({ path: path.join(outputDir, "qa-github-pages.png") });
  if (errors.length) throw new Error(`瀏覽器錯誤：${errors.join(" | ")}`);
  console.log(JSON.stringify({ embeddedTemplate: true, onlineSetup: true, parsed: true, sheets: 8, errors }, null, 2));
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
