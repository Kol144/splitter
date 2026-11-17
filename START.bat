@echo off
setlocal
cd /d "%~dp0"
title AI Music Separator Studio

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Run INSTALL.bat first.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $userPath=[Environment]::GetEnvironmentVariable('Path','User'); if($userPath){$env:Path += ';' + $userPath}; $uri='http://127.0.0.1:4173/api/health'; try { $null=Invoke-RestMethod $uri -TimeoutSec 10; $running=$true } catch { $running=$false }; if(-not $running){ $node=(Get-Command node.exe).Source; $p=Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru; $ok=$false; for($i=0;$i -lt 30;$i++){ Start-Sleep -Milliseconds 500; try { $null=Invoke-RestMethod $uri -TimeoutSec 10; $ok=$true; break } catch {} }; if(-not $ok){ throw 'The local server did not become ready. Run node server.mjs in a terminal to inspect the error.' } }; Start-Process 'http://127.0.0.1:4173'"
if errorlevel 1 (
  echo [ERROR] Could not start the local app. Check Node.js and port 4173.
  pause
  exit /b 1
)
echo Opened AI Music Separator Studio at http://127.0.0.1:4173
