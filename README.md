# 美達食品 QC 工程圖自動產生系統

系統會將兩份 Word 文件跑過以下流程：

`匯入外來標準 Word → 結構化資料 → QC ProcessStep 映射 → Normalize/Diff → 人工確認 → QC HTML 預覽`

目前提供瀏覽器列印／另存 PDF 與另存 HTML；尚未包含 Word 匯出、登入、資料庫、權限、雲端後端或多使用者管理。

## 啟動

第一次下載後，先將下列兩份本機文件放入 `input/`：

- `qc-template.docx`：QC 工程圖母版
- `rnd-standard.docx`：預設載入的外來標準

公司文件與解析後的內容已由 `.gitignore` 排除，不會上傳至 GitHub。

在 PowerShell 執行：

```powershell
cd "C:\path\to\qc-engineering-demo"
.\start-demo.ps1
```

然後開啟 <http://127.0.0.1:8876>。按 `Ctrl+C` 停止。

若要讓同一區域網路的其他電腦使用，第一次先執行 `configure-lan-firewall.ps1` 並允許 Windows 系統管理員確認，再執行 `start-demo.ps1`。啟動後畫面會同時顯示本機網址與內網網址；其他電腦使用內網網址。防火牆規則只接受本機子網路來源。

也可分開執行：

```powershell
python build.py
python server.py
```

## 驗證

```powershell
python -m unittest discover -s tests -v
python -m compileall -q .
```

`build.py` 每次都會重新解析 `input/` 內兩份 DOCX，並在本機重建：

- `debug/rnd-extracted.json`
- `debug/qc-template.json`
- `debug/mapping-result.json`
- `debug/diff-result.json`
- `ui/static/data.json`
- `build-report.json`

## 目錄責任

- `domain/`：Product、ProcessStep、ControlItem、SourceTrace
- `parsers/`：研發 DOCX 與 QC 母版 DOCX 的 OOXML 解析
- `mapping/`：製程與參數映射規則
- `diff/`：格式正規化、語意保守比較與狀態分類
- `templates/`：母版 14 欄與三大欄群定義
- `render/`：分頁驗證、流程 SVG 模型與 QC 預覽模型
- `ui/`：整合式外來標準匯入與差異確認工作區、QC HTML 預覽，以及可逐章切換／完整列印的八項功能教學
- `debug/`：可直接稽核的中間結果

QC HTML 預覽的每個分頁都會重複顯示文件名稱、類別、編號、適用範圍及工程圖記號意義。表身會在同一分頁內，將上下相鄰且內容完全相同的儲存格自動做垂直合併；空白內容不會自動合併。

主工作區可匯入研發或委託廠商提供的 `.doc`／`.docx` 外來產品標準文件。匯入後會立即重新解析規格、對應既有 QC 母版並更新差異與預覽；原本獨立的首頁與研發解析頁已收斂為工作區內的來源摘要。

預覽最前面會自動加入橫式 A4 文件首頁。可輸入品質管制標準書編號、選擇生產一／二／三課、輸入修訂內容，並匯入 `.doc` 或 `.docx` 舊版參考。匯入器同時支援新版獨立首頁格式，以及把「制訂／修訂」資料放在第一張 QC 工程圖頁首的舊格式。未匯入舊版時視為新制訂；匯入後會沿用制定日期與修訂履歷，現行版次往下延伸 0.1。版本固定 2.0、檢討週期固定 1 年，發行日期由修訂日期往後尋找第一個工作日。

列印時首頁與 7 個 QC 分頁合計 8 頁，QC 頁首與右側最後一欄都會保留。`列印` 可選實體印表機或另存 PDF，`另存新檔` 會儲存可離線開啟的 HTML。

流程編輯以 `ProcessStep` 為不可拆散的一組：一個工程名稱固定對應一個流程記號，並帶著該工程下全部 QC 資料列一起移動。預覽頁可拖曳整組換序，也可用上下按鈕調整順序，並支援新增、刪除與恢復原始流程；換序後會重新分頁與繪製流程線。

## 安全規則

- 不以相近數字判斷為相同。
- 含空罐重只映射到「全重」，不直接覆寫「內容量」。
- CCP / OPRP 變更轉成 `REVIEW_REQUIRED`。
- 母版標準值沒有單位時，建議值與預覽值不重複顯示單位；母版的 `(CCP)`／`(OPRP)` 標記永遠保留。
- 保溫試驗設備敘述沿用母版；真空度、pH 與雜質沿用同一份成品規格。
- 研發值 `X` 視為無效，不猜值。
- 特食明示不可修改的四項規格標記 `LOCKED`。
- 未確認的 `REVIEW_REQUIRED` 在預覽中維持母版值。
