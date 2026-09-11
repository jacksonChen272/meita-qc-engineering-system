(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QcLegacyWordParser = api;
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const OPEN_XML_EXTENSIONS = new Set([".docx", ".docm", ".dotx", ".dotm"]);
  const BINARY_EXTENSIONS = new Set([".doc", ".dot", ".wbk"]);
  const KNOWN_LABELS = new Set([
    "文件編號", "編號", "版本", "制定日期", "制訂日期", "文件名稱", "頁次",
    "權責單位", "適用範圍", "檢討週期", "修訂日期", "現行版次", "發行日期",
  ]);

  function extension(name) {
    const match = String(name || "").toLowerCase().match(/\.[^.]+$/);
    return match ? match[0] : "";
  }

  function startsWith(bytes, signature) {
    return signature.every((value, index) => bytes[index] === value);
  }

  function detectFormat(name, input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    if (bytes.length >= 8 && startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "binary";
    if (bytes.length >= 4 && startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "openxml";
    const suffix = extension(name);
    if (BINARY_EXTENSIONS.has(suffix)) return "binary";
    if (OPEN_XML_EXTENSIONS.has(suffix)) return "openxml";
    return "unsupported";
  }

  function clean(value) {
    return String(value || "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/\u3000|\u00a0/g, " ")
      .replace(/[ \f\v]+/g, " ")
      .trim();
  }

  function key(value) {
    return clean(value).replace(/\s+/g, "");
  }

  function displayDate(value) {
    const text = clean(value);
    const match = text.match(/(\d{2,4})\s*(?:年|[.\/-])\s*(\d{1,2})\s*(?:月|[.\/-])\s*(\d{1,2})\s*日?/);
    if (!match) return text;
    return `${match[1]}.${String(Number(match[2])).padStart(2, "0")}.${String(Number(match[3])).padStart(2, "0")}`;
  }

  function displayUnit(value) {
    const compact = key(value);
    return ["生產一課", "生產二課", "生產三課"].includes(compact) ? compact : clean(value);
  }

  function rowsFromText(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(line => line.split("\t").map(clean));
  }

  function nextCellValue(rows, labels) {
    const targets = new Set(labels.map(key));
    for (const cells of rows) {
      for (let index = 0; index < cells.length; index += 1) {
        if (!targets.has(key(cells[index]))) continue;
        for (let candidate = index + 1; candidate < cells.length; candidate += 1) {
          const value = clean(cells[candidate]);
          if (!value) continue;
          if (KNOWN_LABELS.has(key(value))) break;
          return value;
        }
      }
    }
    return "";
  }

  function revisionTuple(value) {
    const match = clean(value).match(/^(\d+)(?:\.(\d+))?$/);
    return match ? [Number(match[1]), Number(match[2] || 0)] : null;
  }

  function compareRevisions(left, right) {
    const a = revisionTuple(left) || [-1, -1];
    const b = revisionTuple(right) || [-1, -1];
    return a[0] - b[0] || a[1] - b[1];
  }

  function looksLikeDate(value) {
    return /\d{2,4}\s*(?:年|[.\/-])\s*\d{1,2}\s*(?:月|[.\/-])\s*\d{1,2}/.test(clean(value));
  }

  function revisionHistoryFromRows(rows) {
    const headerIndex = rows.findIndex(cells => {
      const labels = new Set(cells.map(key));
      return labels.has("修訂日期") && labels.has("現行版次") && labels.has("發行日期");
    });
    if (headerIndex < 0) return [];

    const history = [];
    for (const cells of rows.slice(headerIndex + 1)) {
      const values = cells.map(clean).filter(Boolean);
      if (!values.length) continue;
      if (values.some(value => ["核准", "審核", "會審", "初審", "制訂", "制定"].includes(key(value)))) break;
      const revisionIndex = values.findIndex(value => revisionTuple(value));
      if (revisionIndex < 1 || !looksLikeDate(values[revisionIndex - 1])) continue;
      let issueIndex = -1;
      for (let index = values.length - 1; index > revisionIndex; index -= 1) {
        if (looksLikeDate(values[index])) { issueIndex = index; break; }
      }
      const contentEnd = issueIndex > revisionIndex ? issueIndex : values.length;
      history.push({
        revisionDate: displayDate(values[revisionIndex - 1]),
        revision: clean(values[revisionIndex]),
        content: clean(values.slice(revisionIndex + 1, contentEnd).join(" ")),
        issueDate: issueIndex > revisionIndex ? displayDate(values[issueIndex]) : "",
      });
    }
    return history;
  }

  function fallbackTitle(rows) {
    for (const cells of rows) {
      for (const value of cells) {
        const compact = key(value);
        if (compact.includes("QC工程圖") && !compact.includes("工程圖記號定義")) return clean(value);
      }
    }
    return "";
  }

  function metadataFromText(text) {
    const rows = rowsFromText(text);
    const metadata = {
      documentNumber: nextCellValue(rows, ["文件編號"]) || nextCellValue(rows, ["編號"]),
      documentName: nextCellValue(rows, ["文件名稱"]) || fallbackTitle(rows),
      establishedDate: displayDate(nextCellValue(rows, ["制定日期", "制訂日期", "制定", "制訂"])),
      unit: displayUnit(nextCellValue(rows, ["權責單位", "適用範圍"])),
      pageText: nextCellValue(rows, ["頁次"]),
      revisionHistory: revisionHistoryFromRows(rows),
      latestRevision: "",
    };

    const revisions = metadata.revisionHistory.map(item => item.revision).filter(value => revisionTuple(value));
    if (revisions.length) {
      metadata.latestRevision = revisions.sort(compareRevisions).at(-1);
    } else {
      const revisionText = nextCellValue(rows, ["修訂"]);
      const match = clean(revisionText).match(/第\s*(\d+)\s*次修訂\s*[：:]?\s*(.*)/);
      if (match) {
        metadata.latestRevision = `${Number(match[1])}.0`;
        metadata.revisionHistory.push({
          revisionDate: displayDate(match[2]),
          revision: metadata.latestRevision,
          content: `舊版第${Number(match[1])}次修訂`,
          issueDate: "",
        });
      }
    }
    return metadata;
  }

  function parseBinary(input, extractor) {
    if (typeof extractor !== "function") throw new Error("舊式 Word 解析元件未載入，請重新整理後再試。");
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    const text = extractor(bytes);
    if (!text) throw new Error("此舊式 Word 檔無法讀取；若檔案有密碼、已損毀或早於 Word 97，請先用 Word 另存為 .docx。");
    const metadata = metadataFromText(text);
    if (!metadata.documentNumber && !metadata.establishedDate && !metadata.revisionHistory.length) {
      throw new Error("找不到舊版文件資料或修訂紀錄，請確認選擇的是 QC 工程圖。");
    }
    return metadata;
  }

  return { detectFormat, metadataFromText, parseBinary };
}));
