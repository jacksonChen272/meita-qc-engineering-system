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

from build import build_bundle
from parsers import convert_doc_to_docx, parse_legacy_metadata


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "ui" / "static"
QC_TEMPLATE = ROOT / "input" / "qc-template.docx"


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
            if suffix not in {".doc", ".docx"}:
                raise ValueError("只接受 .doc 或 .docx 文件")
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
                    source = uploaded
                    if suffix == ".doc":
                        source = Path(folder) / f"{Path(filename).stem}.docx"
                        convert_doc_to_docx(uploaded, source)
                    bundle, report = build_bundle(QC_TEMPLATE, source)
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
    if not (STATIC / "data.json").exists():
        raise SystemExit("data.json does not exist; run python build.py first")
    mimetypes.add_type("application/json", ".json")
    server = ThreadingHTTPServer((args.host, args.port), DemoHandler)
    print(f"QC Demo running at http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
