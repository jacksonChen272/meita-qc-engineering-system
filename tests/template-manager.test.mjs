import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  getCustomTemplate,
  normalizeTemplate,
  removeCustomTemplate,
  saveCustomTemplate,
  storageKey,
  validateTemplate,
} from "../ui/static/template-manager.mjs";

const root = resolve(import.meta.dirname, "..");
const nutrition = JSON.parse(await readFile(resolve(root, "ui/static/qc-template-nutrition.json"), "utf8"));

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

test("built-in template passes editor validation and normalization", () => {
  assert.equal(validateTemplate(nutrition, "nutrition"), true);
  const normalized = normalizeTemplate(nutrition, "nutrition");
  assert.equal(normalized.processStepCount, normalized.processSteps.length);
  assert.equal(normalized.pageCount, normalized.layout.pages.length);
  assert.equal(
    normalized.controlItemCount,
    normalized.processSteps.reduce((sum, step) => sum + step.control_items.length, 0),
  );
  assert.equal(normalized.controlItemCount, nutrition.controlItemCount);
  const pageFor = new Map(normalized.layout.pages.flatMap(page => page.rows.map(row => [row.processStepId, `page-${page.pageNumber}`])));
  normalized.processSteps.forEach(step => assert.equal(step.pagination_group, pageFor.get(step.id)));
});

test("edited layout fields are synchronized back to mapping control items", () => {
  const template = structuredClone(nutrition);
  const firstRow = template.layout.pages[0].rows[0];
  firstRow.fields.controlItem.text = "自訂檢查項目";
  firstRow.fields.controlItem.lines = ["自訂檢查項目"];
  firstRow.fields.controlItem.cells = [{ lines: ["自訂檢查項目"] }];
  firstRow.fields.controlStandard.text = "自訂基準";
  firstRow.fields.controlStandard.lines = ["自訂基準"];
  firstRow._templateEditorTouched = ["controlItem", "controlStandard"];

  const normalized = normalizeTemplate(template, "nutrition");
  const step = normalized.processSteps.find(item => item.id === firstRow.processStepId);
  assert.equal(step.control_items[0].name, "自訂檢查項目");
  assert.equal(step.control_items[0].standard, "自訂基準");
});

test("custom templates persist independently and can be restored", () => {
  const storage = memoryStorage();
  const template = structuredClone(nutrition);
  template.processSteps[0].name = "自訂第一工程";
  const saved = saveCustomTemplate("nutrition", template, storage);
  assert.equal(storageKey("nutrition"), "meita-qc-template:v1:nutrition");
  assert.equal(saved.processSteps[0].name, "自訂第一工程");
  assert.equal(getCustomTemplate("nutrition", storage).processSteps[0].name, "自訂第一工程");
  assert.equal(getCustomTemplate("sauce_pack", storage), null);
  removeCustomTemplate("nutrition", storage);
  assert.equal(getCustomTemplate("nutrition", storage), null);
});

test("invalid or mismatched imports are rejected clearly", () => {
  assert.throws(() => validateTemplate({}, "nutrition"), /工程群組/);
  assert.throws(() => validateTemplate(nutrition, "sauce_pack"), /類型/);
});
