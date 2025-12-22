# 🚀 VibeArchitect Setup Guide

Follow these steps to set up the **VibeArchitect** extension on a new computer.

## Prerequisites
1.  **VS Code**: Install from [code.visualstudio.com](https://code.visualstudio.com/).
2.  **Node.js**: Install Node.js (v18+) from [nodejs.org](https://nodejs.org/).
3.  **Git**: Ensure Git is installed and configured.

## Step 1: Clone the Repository
Open your terminal (Command Prompt or PowerShell) and run:
```bash
git clone https://github.com/anurag-dwivedi1703/VSCODE-EXT.git
cd VSCODE-EXT
```

## Step 2: Install Dependencies
This project has two parts: the Extension (backend) and the Webview (frontend). You need to install dependencies for **both**.

```bash
# 1. Install Extension dependencies
npm install

# 2. Install Webview dependencies
cd webview-ui
npm install
cd ..
```

## Step 3: API Key Configuration
You need a Google Gemini API Key.
1.  Get a key from [Google AI Studio](https://aistudio.google.com/).
2.  Open VS Code in the project folder (`code .`).
3.  Go to **File > Preferences > Settings** (`Ctrl+,`).
4.  Search for `VibeArchitect`.
5.  Enter your key in **VibeArchitect: Gemini Api Key**.
    *   *Note: Since you are in development mode, you might need to add this to `.vscode/settings.json` or just set it when debugging.*

## Step 4: Build and Run
1.  **Build the UI**:
    ```bash
    cd webview-ui
    npm run build
    cd ..
    ```
2.  **Launch Extension**:
    *   Press **F5** in VS Code.
    *   This opens a new "Extension Development Host" window.

## Step 5: Verify
1.  In the new window, press `Ctrl+Shift+P`.
2.  Type `VibeArchitect: Open Mission Control`.
3.  The dashboard should appear!

## Step 6: Browser Automation Setup (Optional)
For AI-powered UI testing with Playwright:

**For Development (running from source):**
```bash
# Browser automation deps are included in npm install
npm run install-browsers  # Downloads Chromium for Playwright
```

**For Installed Extension (.vsix):**
After installing the .vsix, run these commands:
```powershell
# Windows PowerShell
cd "$env:USERPROFILE\.vscode\extensions"
cd (Get-ChildItem -Filter "*vibearchitect*" | Select-Object -First 1).FullName
npm install playwright-core pixelmatch pngjs
```

Then restart VS Code completely.

**Verify it works:** Ask your agent:
> "Create a login page and verify it with browser_verify_ui"

The agent should launch Chrome, take screenshots, and use AI vision to verify.

## Troubleshooting
*   **Blank Screen?** Ensure you ran `npm run build` in `webview-ui`.
*   **"Gemini Error"?** Check your API Key in settings.
*   **Browser automation fails?** Run `npm install playwright-core` in extension folder.
*   **"Cannot read properties of undefined (reading 'launch')"?** Fully restart VS Code after installing deps.

