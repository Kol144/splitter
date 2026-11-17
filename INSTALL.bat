@echo off
setlocal
cd /d "%~dp0"
title AI Music Separator Studio - Installer

echo.
echo  AI MUSIC SEPARATOR STUDIO
echo  CPU-first local setup. No AI model weights are downloaded by this installer.
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is missing. Install Node.js 22.13 or newer, then run this installer again.
  echo         https://nodejs.org/en/download
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22.13 or newer is required for the built-in SQLite service.
  pause
  exit /b 1
)

if exist ".venv\Scripts\python.exe" goto python_ready

set "PYTHON_COMMAND="
where py >nul 2>&1
if not errorlevel 1 (
  py -3.11 --version >nul 2>&1
  if not errorlevel 1 set "PYTHON_COMMAND=py -3.11"
)
if defined PYTHON_COMMAND goto create_venv

if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PYTHON_COMMAND="%LOCALAPPDATA%\Programs\Python\Python311\python.exe""
if defined PYTHON_COMMAND goto create_venv

where winget >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python 3.11 x64 is missing and winget is unavailable.
  echo         Install Python 3.11 from https://www.python.org/downloads/windows/ and run this installer again.
  pause
  exit /b 1
)

echo Python 3.11 x64 is required for the PyTorch CPU build.
choice /C YN /M "Install Python 3.11 for this Windows user with winget"
if errorlevel 2 (
  echo Setup cancelled. Install Python 3.11 and run INSTALL.bat again.
  pause
  exit /b 1
)
winget install --exact --id Python.Python.3.11 --scope user --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo [ERROR] winget could not install Python. See INSTALLATION_GUIDE.md.
  pause
  exit /b 1
)
if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PYTHON_COMMAND="%LOCALAPPDATA%\Programs\Python\Python311\python.exe""
if not defined PYTHON_COMMAND (
  echo [ERROR] Python was installed but this shell cannot locate it. Close this window and run INSTALL.bat again.
  pause
  exit /b 1
)

:create_venv
echo Creating local Python environment...
%PYTHON_COMMAND% -m venv .venv
if errorlevel 1 (
  echo [ERROR] Could not create .venv.
  pause
  exit /b 1
)

:python_ready
set "PYTHON=%CD%\.venv\Scripts\python.exe"
echo Updating pip...
"%PYTHON%" -m pip install --disable-pip-version-check --upgrade pip
if errorlevel 1 goto pip_error

echo Installing the CPU-only PyTorch runtime...
"%PYTHON%" -m pip install --disable-pip-version-check --index-url https://download.pytorch.org/whl/cpu "torch==2.5.1" "torchaudio==2.5.1"
if errorlevel 1 goto pip_error

echo Installing Demucs and audio I/O dependencies...
"%PYTHON%" -m pip install --disable-pip-version-check "demucs==4.0.1" soundfile
if errorlevel 1 goto pip_error

echo Installing optional DiffQ support for MDX-Extra-Q...
"%PYTHON%" -m pip install --disable-pip-version-check "diffq==0.2.4"
if errorlevel 1 (
  echo [NOTE] MDX-Extra-Q is unavailable because DiffQ could not be compiled.
  echo        On Windows, install Microsoft C++ Build Tools, then run:
  echo        .venv\Scripts\python.exe -m pip install diffq==0.2.4
)

if not exist "data\projects" mkdir "data\projects"
if not exist "data\temp" mkdir "data\temp"
if not exist "data\exports" mkdir "data\exports"

echo.
echo Checking the installed engine...
"%PYTHON%" -c "import torch, demucs; print('PyTorch:',torch.__version__); print('Demucs:',getattr(demucs,'__version__','4.0.1')); print('CPU capability:',torch.backends.cpu.get_cpu_capability()); print('PyTorch threads:',torch.get_num_threads())"
if errorlevel 1 goto pip_error
"%PYTHON%" -c "import importlib.util as u; print('DiffQ:', 'available' if u.find_spec('diffq') else 'not available')"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$userPath=[Environment]::GetEnvironmentVariable('Path','User'); if($userPath){$env:Path += ';' + $userPath}; if((Get-Command ffmpeg -ErrorAction SilentlyContinue) -and (Get-Command ffprobe -ErrorAction SilentlyContinue)){exit 0}else{exit 1}"
if errorlevel 1 (
  echo.
  echo [NOTE] FFmpeg/ffprobe are not on PATH. Audio import works, but export, video import and technical probing need FFmpeg.
  echo        See INSTALLATION_GUIDE.md for the official download instructions.
) else (
  echo FFmpeg and ffprobe detected.
)

echo.
echo Setup completed. No model weights were downloaded.
echo Open AI Models in the app to check a model's download size and install it explicitly.
echo Run START.bat when you are ready.
pause
exit /b 0

:pip_error
echo.
echo [ERROR] Dependency setup did not complete.
echo Check your internet connection, available disk space, and Python 3.11 installation.
echo See TROUBLESHOOTING.md for recovery steps.
pause
exit /b 1
