const browserGlobals = {
  Blob: "readonly",
  DOMParser: "readonly",
  FileReader: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  console: "readonly",
  document: "readonly",
  fetch: "readonly",
  getComputedStyle: "readonly",
  navigator: "readonly",
  requestAnimationFrame: "readonly",
  setTimeout: "readonly",
  window: "readonly",
};

const nodeGlobals = {
  Buffer: "readonly",
  console: "readonly",
  process: "readonly",
  require: "readonly",
};

const commonRules = {
  "no-dupe-keys": "error",
  "no-unreachable": "error",
  "no-undef": "error",
};

export default [
  {
    files: ["ui/static/app.js", "ui/static/browser-runtime.js", "ui/static/ocr-runtime.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: browserGlobals,
    },
    rules: commonRules,
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs", "tests/**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: commonRules,
  },
];
