from __future__ import annotations

import argparse
import base64
import binascii
import json
import mimetypes
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from build import build_bundle_from_qc
from parsers import convert_doc_to_docx, parse_legacy_metadata


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "ui" / "static"
QC_TEMPLATES = {
    "nutrition": STATIC / "qc-template-nutrition.json",
    "sauce_pack": STATIC / "qc-template-sauce-pack.json",
}
WORD_SUFFIXES = {".doc", ".docx", ".docm", ".dot", ".dotx", ".dotm", ".wbk"}
BINARY_WORD_SUFFIXES = {".doc", ".dot", ".wbk"}


def validate_template_override(template: object, template_key: str) -> dict:
    if not isinstance(template, dict):
        raise ValueError("自訂母版必須是 JSON 物件")
    if template.get("templateProfile") != template_key:
        raise ValueError("自訂母版類型與所選母版不一致")
    process_steps = template.get("processSteps")
    pages = template.get("layout", {}).get("pages") if isinstance(template.get("layout"), dict) else None
    if not isinstance(process_steps, list) or not process_steps:
        raise ValueError("自訂母版至少需要一個工程群組")
    if not isinstance(pages, list) or not pages:
        raise ValueError("自訂母版缺少工程圖分頁資料")
    process_ids = [str(step.get("id", "")) for step in process_steps if isinstance(step, dict)]
    if len(process_ids) != len(process_steps) or any(not item for item in process_ids) or len(set(process_ids)) != len(process_ids):
        raise ValueError("自訂母版工程群組 ID 不可空白或重複")
    known_ids = set(process_ids)
    rows = [row for page in pages if isinstance(page, dict) for row in page.get("rows", []) if isinstance(row, dict)]
    if not rows or any(row.get("processStepId") not in known_ids or not isinstance(row.get("fields"), dict) for row in rows):
        raise ValueError("自訂母版含有無效的工程資料列")
    return template


class DemoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self) -> None:
        route = urlparse(self.path).path
        if route == "/api/data":
            payload = (STATIC / "data.json").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if route == "/api/health":
            payload = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def _send_json(self, status: int, data: dict) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:
        route = urlparse(self.path).path
        if route not in {"/api/import-legacy", "/api/import-standard"}:
            self._send_json(404, {"ok": False, "error": "找不到 API"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 35_000_000:
                raise ValueError("檔案內容為空或超過 25 MB")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            filename = Path(str(body.get("filename", ""))).name
            suffix = Path(filename).suffix.lower()
            if suffix not in WORD_SUFFIXES:
                raise ValueError("只接受 Word 文件")
            encoded = str(body.get("contentBase64", ""))
            content = base64.b64decode(encoded, validate=True)
            if not content or len(content) > 25_000_000:
                raise ValueError("檔案內容為空或超過 25 MB")
            with tempfile.TemporaryDirectory(prefix="qc-document-upload-") as folder:
                # Keep the original base name because product name, version and
                # date are part of the external standard's controlled filename.
                uploaded = Path(folder) / filename
                uploaded.write_bytes(content)
                if route == "/api/import-standard":
                    template_key = str(body.get("templateKey", ""))
                    template_path = QC_TEMPLATES.get(template_key)
                    if template_path is None or not template_path.exists():
                        raise ValueError("請先選擇有效的 QC 工程圖母版")
                    source = uploaded
                    if suffix in BINARY_WORD_SUFFIXES:
                        source = Path(folder) / f"{Path(filename).stem}.docx"
                        convert_doc_to_docx(uploaded, source)
                    override = body.get("templateJson")
                    qc = validate_template_override(override, template_key) if override is not None else json.loads(template_path.read_text(encoding="utf-8"))
                    bundle, report = build_bundle_from_qc(qc, source)
                    if not bundle["rnd"].get("parameterCount"):
                        raise ValueError("找不到可解析的產品規格或標準項目")
                    self._send_json(200, {"ok": True, "filename": filename, "data": bundle, "report": report})
                    return
                metadata = parse_legacy_metadata(uploaded)
            if not any((metadata["documentNumber"], metadata["establishedDate"], metadata["latestRevision"])):
                raise ValueError("找不到第一頁文件資料或修訂紀錄")
            self._send_json(200, {"ok": True, "filename": filename, "metadata": metadata})
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, binascii.Error) as error:
            self._send_json(400, {"ok": False, "error": str(error)})
        except Exception as error:
            label = "外來標準文件" if route == "/api/import-standard" else "舊版"
            self._send_json(500, {"ok": False, "error": f"{label}解析失敗：{error}"})

    def log_message(self, fmt: str, *args) -> None:
        print(f"[qc-demo] {self.address_string()} {fmt % args}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8876)
    args = parser.parse_args()
    mimetypes.add_type("application/json", ".json")
    server = ThreadingHTTPServer((args.host, args.port), DemoHandler)
    print(f"QC Demo running at http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
