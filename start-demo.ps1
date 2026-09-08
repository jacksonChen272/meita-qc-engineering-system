$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$python = $null
$candidate = Get-Command python.exe -ErrorAction SilentlyContinue
if ($candidate) { $python = $candidate.Source }

if (-not $python) {
    throw "找不到 Python 3。請安裝 Python 3.11+，再執行 python build.py 與 python server.py。"
}

Push-Location $root
try {
    & $python "$root\build.py"
    if ($LASTEXITCODE -ne 0) { throw "資料 Build 失敗。" }
    $lanIp = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
        Select-Object -First 1 -ExpandProperty IPv4Address |
        Select-Object -ExpandProperty IPAddress
    Write-Host ""
    Write-Host "本機網址: http://127.0.0.1:8876" -ForegroundColor Cyan
    if ($lanIp) { Write-Host "內網網址: http://${lanIp}:8876" -ForegroundColor Green }
    Write-Host "按 Ctrl+C 停止。" -ForegroundColor DarkGray
    & $python "$root\server.py" --host 0.0.0.0 --port 8876
}
finally {
    Pop-Location
}
