import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "site");
if (dirname(output) !== root || !output.endsWith("site")) {
  throw new Error(`Refusing to replace unexpected build directory: ${output}`);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const staticFiles = [
  "index.html",
  "app.js",
  "styles.css",
  "browser-runtime.js",
  "ocr-runtime.mjs",
  "legacy-word-parser.js",
  "qc-template-nutrition.json",
  "qc-template-sauce-pack.json",
];
for (const file of staticFiles) {
  await copyFile(join(root, "ui", "static", file), join(output, file));
}

await cp(join(root, "ui", "static", "vendor"), join(output, "vendor"), { recursive: true });
await copyFile(join(root, "build.py"), join(output, "build.py"));
for (const directory of ["diff", "domain", "mapping", "parsers", "render", "templates"]) {
  await cp(join(root, directory), join(output, directory), { recursive: true });
}

const tesseractDist = join(root, "node_modules", "tesseract.js", "dist");
const tesseractTarget = join(output, "vendor", "tesseract.js");
await mkdir(tesseractTarget, { recursive: true });
for (const file of [
  "tesseract.esm.min.js",
  "tesseract.esm.min.js.map",
  "worker.min.js",
  "worker.min.js.LICENSE.txt",
]) {
  await copyFile(join(tesseractDist, file), join(tesseractTarget, file));
}
await copyFile(
  join(root, "node_modules", "tesseract.js", "LICENSE.md"),
  join(tesseractTarget, "LICENSE.md"),
);

await cp(
  join(root, "node_modules", "tesseract.js-core"),
  join(output, "vendor", "tesseract.js-core"),
  { recursive: true },
);

const tessdataTarget = join(output, "vendor", "tessdata");
await mkdir(tessdataTarget, { recursive: true });
for (const language of ["chi_tra", "eng"]) {
  await copyFile(
    join(root, "node_modules", "@tesseract.js-data", language, "4.0.0_best_int", `${language}.traineddata.gz`),
    join(tessdataTarget, `${language}.traineddata.gz`),
  );
}

await writeFile(join(output, ".nojekyll"), "", "utf8");
console.log(`Production site built at ${output}`);
