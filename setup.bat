@echo off
echo ==========================================
echo    VibeArchitect Extension Setup Assistant
echo ==========================================
echo.

echo [1/4] Installing Root Dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install root dependencies.
    pause
    exit /b %errorlevel%
)
echo [OK] Root dependencies installed.
echo.

echo [2/4] Installing Webview Dependencies...
cd webview-ui
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install webview dependencies.
    cd ..
    pause
    exit /b %errorlevel%
)
echo [OK] Webview dependencies installed (including @fontsource/inter).
echo.

echo [3/4] Building Webview UI...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Failed to build webview.
    cd ..
    pause
    exit /b %errorlevel%
)
echo [OK] Webview built.
cd ..
echo.

echo [4/4] Compiling Extension...
call npm run compile
if %errorlevel% neq 0 (
    echo [ERROR] Failed to compile extension.
    pause
    exit /b %errorlevel%
)
echo [OK] Extension compiled.
echo.

echo ==========================================
echo        SETUP COMPLETE! 🚀
echo ==========================================
echo You can now press F5 in VS Code to run the extension.
pause
