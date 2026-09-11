"use strict";

const assert = require("assert");
const fs = require("fs");
const parser = require("../ui/static/legacy-word-parser.js");
const docToText = require("../ui/static/vendor/doc-to-text.js");

const sample = [
  "文件編號\t02-0200-033\t版本\t2.0\t制定日期\t105.06.17",
  "文件名稱\t測試產品QC工程圖\t頁次\t1/7\t權責單位\t生 產 二 課",
  "修訂日期\t現行版次\t修訂內容摘要\t發行日期",
  "2025.09.03\t2.3\t新增殺菌條件\t2025.09.04",
  "2026.01.28\t2.4\t產品名稱修改\t2026.01.29",
  "核准\t審核\t會審\t初審\t制訂",
].join("\n");

const sampleMetadata = parser.metadataFromText(sample);
assert.equal(sampleMetadata.documentNumber, "02-0200-033");
assert.equal(sampleMetadata.establishedDate, "105.06.17");
assert.equal(sampleMetadata.unit, "生產二課");
assert.equal(sampleMetadata.latestRevision, "2.4");
assert.equal(sampleMetadata.revisionHistory.length, 2);

assert.equal(parser.detectFormat("old.doc", Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), "binary");
assert.equal(parser.detectFormat("new.docm", Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), "openxml");

const fixture = process.argv[2];
if (fixture) {
  const metadata = parser.parseBinary(fs.readFileSync(fixture), docToText);
  assert(metadata.documentNumber, "實際 .doc 未解析出文件編號");
  assert(metadata.establishedDate, "實際 .doc 未解析出制定日期");
  assert(metadata.latestRevision, "實際 .doc 未解析出最新版次");
  console.log(JSON.stringify({ ok: true, fixture, metadata }, null, 2));
} else {
  console.log(JSON.stringify({ ok: true, synthetic: true }, null, 2));
}
