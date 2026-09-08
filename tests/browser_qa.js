const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const legacyFixture = process.argv[2];
  const outputDir = process.argv[3] || process.cwd();
  const expectedRevision = process.argv[4];
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.QC_BROWSER_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:8876/", { waitUntil: "networkidle" });
  await page.waitForSelector(".standard-import-panel");
  const navLabels = await page.locator(".topnav button").allTextContents();
  if (navLabels.join("|") !== "差異確認|工程圖預覽|使用教學") throw new Error(`頁面尚未整合：${navLabels.join("|")}`);
  if (await page.locator('[data-view="home"], [data-view="parsed"]').count()) throw new Error("仍顯示首頁或研發解析入口");
  await page.locator('[data-view="tutorial"]').first().click();
  await page.waitForSelector(".tutorial-page");
  if (await page.locator(".tutorial-menu-button").count() !== 8 || await page.locator(".tutorial-chapter").count() !== 8) throw new Error("使用教學不是 8 個獨立功能章節");
  if (await page.locator('.tutorial-chapter[data-active="true"]:visible').count() !== 1) throw new Error("使用教學沒有一次只顯示一個功能");
  await page.locator('[data-tutorial-page="4"]').click();
  if (!(await page.locator('.tutorial-chapter[data-active="true"]').innerText()).includes("文件首頁與舊版匯入")) throw new Error("使用教學章節切換失敗");
  await page.locator('[data-tutorial-page="7"]').click();
  const outputTutorial = await page.locator('.tutorial-chapter[data-active="true"]').innerText();
  if (!outputTutorial.includes("另存為 PDF") || !outputTutorial.includes("HTML，不是 Word")) throw new Error("輸出功能教學不完整");
  await page.locator('[data-tutorial-page="0"]').click();
  await page.screenshot({ path: path.join(outputDir, "qa-tutorial.png"), fullPage: true });
  await page.locator('[data-view="diff"]').first().click();
  const standardFixture = path.join(__dirname, "..", "input", "rnd-standard.docx");
  await page.setInputFiles("[data-standard-file]", standardFixture);
  await page.waitForFunction(() => document.querySelector(".standard-import-status")?.textContent.includes("已匯入"));
  const standardPanelText = await page.locator(".standard-import-panel").innerText();
  if (!standardPanelText.includes("82 項規格")) throw new Error("外來標準文件沒有完成重新解析");
  if (!standardPanelText.includes("力增 洗腎配方(杏仁)") || standardPanelText.includes("目前產品\nuploaded")) throw new Error("外來標準文件的產品名稱不正確");
  await page.screenshot({ path: path.join(outputDir, "qa-workspace.png") });
  await page.locator('[data-view="preview"]').first().click();
  await page.waitForSelector(".cover-sheet");
  if (await page.locator(".qc-sheet").count() !== 8) throw new Error("預覽不是 8 頁");
  if (!(await page.locator(".cover-metadata").innerText()).includes("1/8")) throw new Error("首頁頁次不是 1/8");
  const mergedCleanliness = await page.locator('td[data-field="controlItem"]').evaluateAll(nodes => nodes
    .filter(node => node.innerText.trim() === "過濾清潔度")
    .map(node => Number(node.getAttribute("rowspan") || 1)));
  if (mergedCleanliness.length !== 1 || mergedCleanliness[0] < 2) throw new Error("重複的過濾清潔度未合併");
  const seamGroups = await page.locator('td[data-field="engineeringName"]').evaluateAll(nodes => nodes
    .filter(node => node.innerText.trim() === "捲封檢查")
    .map(node => Number(node.getAttribute("rowspan") || 1)));
  if (seamGroups.length !== 1 || seamGroups[0] !== 2) throw new Error("捲封外觀與內部未合併為同一工程群組");
  const previewText = await page.locator(".sheet-scroller").innerText();
  if (previewText.includes("包裝場")) throw new Error("取樣地點仍出現包裝場");
  if (previewText.includes("成品包裝品質紀錄表") || !previewText.includes("成品包裝品質檢查表")) throw new Error("成品包裝品質檢查表名稱不正確");
  if (!previewText.includes("5批/次")) throw new Error("整箱打檢取樣數量不是 5批/次");
  if (!previewText.includes("≧70")) throw new Error("水溫管制基準不是 ≧70");
  if (!previewText.includes("02-0203-042")) throw new Error("包裝操作標準不是 02-0203-042");
  if (previewText.includes("出貨場") || !previewText.includes("出貨區")) throw new Error("出貨取樣地點不是出貨區");
  const labelPosition = await page.locator(".cover-sheet .sheet-label").evaluate(node => {
    const sheet = node.closest(".cover-sheet").getBoundingClientRect();
    const label = node.getBoundingClientRect();
    return Math.abs((label.left + label.right) / 2 - (sheet.left + sheet.right) / 2);
  });
  if (labelPosition > 2) throw new Error("頁碼沒有置中");
  const flowAlignment = await page.locator('.qc-sheet:not(.cover-sheet)').evaluateAll(sheets => sheets.flatMap(sheet => {
    const svg = sheet.querySelector('.flow-overlay');
    const flowCell = sheet.querySelector('.flow-cell');
    if (!svg || !flowCell) return [];
    const flowRect = flowCell.getBoundingClientRect();
    const scaleY = flowRect.height / Number(svg.viewBox.baseVal.height || 1);
    return [...sheet.querySelectorAll('td[data-field="engineeringName"]')].map(cell => {
      const row = cell.closest('tr');
      const node = svg.querySelector(`[data-flow-process="${row.dataset.processId}"]`);
      if (!node) return 999;
      const style = getComputedStyle(cell);
      const expected = cell.getBoundingClientRect().top - flowRect.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
      const box = node.getBBox();
      const actual = box.y + box.height / 2;
      return Math.abs(actual * scaleY - expected);
    });
  }));
  if (Math.max(...flowAlignment) > 3) throw new Error("流程記號未與工程名稱同列對齊");
  await page.fill('[data-meta-field="documentNumber"]', "02-0200-033");
  await page.fill('[data-meta-field="revisionContent"]', "自動化首頁測試");
  await page.selectOption('[data-meta-field="unit"]', { label: "生產二課" });
  if (legacyFixture) {
    await page.setInputFiles("[data-legacy-file]", legacyFixture);
    await page.waitForFunction(() => document.querySelector(".import-status")?.textContent.includes("已匯入"));
    if (expectedRevision && !(await page.locator(".metadata-summary").innerText()).includes(expectedRevision)) throw new Error(`舊版版次未延伸為 ${expectedRevision}`);
  }
  await page.locator(".cover-sheet").screenshot({ path: path.join(outputDir, "qa-cover.png") });
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const printMetrics = await page.locator(".qc-sheet").evaluateAll(sheets => sheets.map(sheet => {
    const sheetRect = sheet.getBoundingClientRect();
    const content = sheet.querySelector(".qc-table") || sheet.querySelector(".cover-approval");
    return {
      fontSize: sheet.querySelector(".qc-table") ? parseFloat(getComputedStyle(sheet.querySelector(".qc-table")).fontSize) : null,
      overflow: content.getBoundingClientRect().bottom - sheetRect.bottom,
    };
  }));
  if (printMetrics.slice(1).some(metric => Math.abs(metric.fontSize - 12) > 0.1)) throw new Error("列印內文字體不是 9pt");
  if (printMetrics.some(metric => metric.overflow > 0.5)) throw new Error("列印內容超出頁面");
  const printFlowAlignment = await page.locator('.qc-sheet:not(.cover-sheet)').evaluateAll(sheets => sheets.flatMap(sheet => {
    const svg = sheet.querySelector('.flow-overlay');
    const flowCell = sheet.querySelector('.flow-cell');
    if (!svg || !flowCell) return [];
    const flowRect = flowCell.getBoundingClientRect();
    const scaleY = flowRect.height / Number(svg.viewBox.baseVal.height || 1);
    return [...sheet.querySelectorAll('td[data-field="engineeringName"]')].map(cell => {
      const row = cell.closest('tr');
      const node = svg.querySelector(`[data-flow-process="${row.dataset.processId}"]`);
      if (!node) return 999;
      const style = getComputedStyle(cell);
      const expected = cell.getBoundingClientRect().top - flowRect.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
      const box = node.getBBox();
      return Math.abs((box.y + box.height / 2) * scaleY - expected);
    });
  }));
  if (Math.max(...printFlowAlignment) > 3) throw new Error("列印流程記號未與工程名稱同列對齊");
  await page.pdf({
    path: path.join(outputDir, "qa-preview.pdf"),
    printBackground: true,
    preferCSSPageSize: true,
  });
  if (errors.length) throw new Error(`瀏覽器錯誤：${errors.join(" | ")}`);
  console.log(JSON.stringify({ sheets: 8, importedLegacy: Boolean(legacyFixture), errors }, null, 2));
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
