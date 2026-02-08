#!/bin/bash
echo "=========================================="
echo "   VibeArchitect Extension Setup Assistant"
echo "=========================================="
echo ""

echo "[1/4] Installing Root Dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "[ERROR] Failed to install root dependencies."
    exit 1
fi
echo "[OK] Root dependencies installed."
echo ""

echo "[2/4] Installing Webview Dependencies..."
cd webview-ui
npm install
if [ $? -ne 0 ]; then
    echo "[ERROR] Failed to install webview dependencies."
    cd ..
    exit 1
fi
echo "[OK] Webview dependencies installed (including @fontsource/inter)."
echo ""

echo "[3/4] Building Webview UI..."
npm run build
if [ $? -ne 0 ]; then
    echo "[ERROR] Failed to build webview."
    cd ..
    exit 1
fi
echo "[OK] Webview built."
cd ..
echo ""

echo "[4/4] Compiling Extension..."
npm run compile
if [ $? -ne 0 ]; then
    echo "[ERROR] Failed to compile extension."
    exit 1
fi
echo "[OK] Extension compiled."
echo ""

echo "=========================================="
echo "        SETUP COMPLETE! 🚀"
echo "=========================================="
echo "You can now press F5 in VS Code to run the extension."
echo "Or run 'npx vsce package --no-dependencies' to create a VSIX."
