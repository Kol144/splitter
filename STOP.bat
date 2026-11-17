@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  exit /b 1
)
node -e "fetch('http://127.0.0.1:4173/api/shutdown',{method:'POST'}).then(r=>r.ok?console.log('AI Music Separator Studio stopped.'):console.log('The local app returned status '+r.status)).catch(()=>console.log('AI Music Separator Studio is not running.'))"
