# VibeArchitect Setup Guide v2.0

Complete setup instructions for the VibeArchitect AI Agent Manager Extension.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Installing the Extension](#2-installing-the-extension)
3. [Configuring AI Models](#3-configuring-ai-models)
4. [Browser Automation Setup](#4-browser-automation-setup-optional)
5. [Extension Settings](#5-extension-settings)
6. [Verifying Installation](#6-verifying-installation)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Prerequisites

### System Requirements

- **VS Code**: Version 1.85.0 or higher
- **Node.js**: Version 18.x or higher (for browser automation)
- **npm**: Version 9.x or higher
- **Operating System**: Windows 10/11, macOS 10.15+, or Linux (Ubuntu 20.04+)

### Optional Requirements

- **GitHub Copilot Subscription**: Required if using Copilot-integrated Claude models
- **Chrome/Edge/Firefox**: For browser automation (or Chromium will be auto-downloaded)

---

## 2. Installing the Extension

### Step 2.1: Install from VSIX File

1. Open VS Code
2. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS) to open Command Palette
3. Type `Extensions: Install from VSIX...` and select it
4. Browse to and select the `vibearchitect-0.0.1.vsix` file
5. Click **Install**

### Step 2.2: Reload VS Code (REQUIRED)

After installation, you **MUST** reload VS Code:

1. Press `Ctrl+Shift+P` / `Cmd+Shift+P`
2. Type `Developer: Reload Window`
3. Press Enter

> **Important**: The extension will not work properly until you reload the window!

### Step 2.3: Verify Installation

After reloading, you should see:
- A notification: "VibeArchitect Agent Manager Active! 🚀"
- The Mission Control panel should auto-open

If it doesn't auto-open:
1. Press `Ctrl+Shift+P` / `Cmd+Shift+P`
2. Type `VibeArchitect: Open Mission Control`
3. Press Enter

---

## 3. Configuring AI Models

VibeArchitect supports multiple AI models. You need to configure at least ONE of the following options.

### Option A: GitHub Copilot (Recommended - Easiest)

If you have a **GitHub Copilot subscription**, this is the easiest setup:

1. Install the **GitHub Copilot** extension from VS Code marketplace
2. Install the **GitHub Copilot Chat** extension
3. Sign in to GitHub when prompted
4. Open VS Code Settings:
   - Press `Ctrl+,` (Windows/Linux) or `Cmd+,` (macOS)
   - Or go to File → Preferences → Settings
5. Search for `vibearchitect`
6. Enable **"Use Copilot For Claude"**:
   ```
   ✅ Vibearchitect: Use Copilot For Claude
   ```

> **Note**: This uses your existing Copilot subscription - no additional API keys needed!

### Option B: Direct Claude API Key

If you have an Anthropic API key:

1. Get your API key from [console.anthropic.com](https://console.anthropic.com)
2. Open VS Code Settings (`Ctrl+,` / `Cmd+,`)
3. Search for `vibearchitect`
4. Enter your key in **"Claude Api Key"**:
   ```
   Vibearchitect: Claude Api Key: sk-ant-api03-xxxxxxxxxxxxx
   ```

### Option C: Google Gemini API Key

To use Google's Gemini models:

1. Get your API key from [makersuite.google.com](https://makersuite.google.com/app/apikey)
2. Open VS Code Settings (`Ctrl+,` / `Cmd+,`)
3. Search for `vibearchitect`
4. Enter your key in **"Gemini Api Key"**:
   ```
   Vibearchitect: Gemini Api Key: AIzaSyxxxxxxxxxxxxxxxxxx
   ```

### Settings File Method (Alternative)

You can also edit `settings.json` directly:

1. Press `Ctrl+Shift+P` / `Cmd+Shift+P`
2. Type `Preferences: Open User Settings (JSON)`
3. Add the following (choose your preferred option):

```json
{
    // Option A: Use Copilot (recommended)
    "vibearchitect.useCopilotForClaude": true,

    // Option B: Direct Claude API
    "vibearchitect.claudeApiKey": "sk-ant-api03-your-key-here",

    // Option C: Gemini API
    "vibearchitect.geminiApiKey": "AIzaSy-your-key-here"
}
```

4. **Save the file** (`Ctrl+S` / `Cmd+S`)
5. **NO RELOAD REQUIRED** - Settings take effect immediately

---

## 4. Browser Automation Setup (Optional)

Browser automation allows VibeArchitect to test web applications automatically. This is **optional** - skip this section if you don't need browser testing.

### Step 4.1: Install Browser Dependencies

There are three ways to install the required packages. **Methods A and B are recommended** as they automatically install to the correct location (extension directory).

#### Method A: Via VS Code UI (Recommended)

1. In the VibeArchitect panel, click the **🌐 (Browser Setup)** button in the header
2. The Browser Setup Wizard will show dependency status
3. If dependencies are missing, click **"📦 Install Missing Dependencies"**
4. Wait for installation to complete (1-2 minutes)
5. A notification will confirm successful installation
6. **RELOAD VS CODE WINDOW** when prompted

> Packages are automatically installed to the extension's directory.

#### Method B: Via Command Palette (Recommended)

1. Press `Ctrl+Shift+P` / `Cmd+Shift+P`
2. Type `VibeArchitect: Install Browser Automation Dependencies`
3. Press Enter
4. Wait for installation to complete
5. **RELOAD VS CODE WINDOW** (`Developer: Reload Window`)

> Packages are automatically installed to the extension's directory.

#### Method C: Via Terminal (Manual)

> **Important**: Dependencies must be installed in the **extension's directory**, not your workspace!

1. Find your extension directory:
   - **Windows**: `%USERPROFILE%\.vscode\extensions\vibearchitect-0.0.1`
   - **macOS/Linux**: `~/.vscode/extensions/vibearchitect-0.0.1`

2. Open a terminal and navigate to the extension directory:

   **Windows (PowerShell)**:
   ```powershell
   cd "$env:USERPROFILE\.vscode\extensions\vibearchitect-0.0.1"
   npm install playwright-core pixelmatch pngjs
   ```

   **macOS/Linux**:
   ```bash
   cd ~/.vscode/extensions/vibearchitect-0.0.1
   npm install playwright-core pixelmatch pngjs
   ```

3. **RELOAD VS CODE WINDOW** (Required):
   - `Ctrl+Shift+P` / `Cmd+Shift+P` → `Developer: Reload Window`

> **Why the extension directory?** The extension loads these packages from its own `node_modules` folder, not from your workspace. Installing in the wrong location won't work.

### Step 4.2: Install Browser (Chromium)

After installing dependencies, you need a browser. You have two options:

#### Option A: Use Existing Browser

If you have Chrome, Edge, or Firefox installed, VibeArchitect will auto-detect them.

1. Click the **🌐 (Browser Setup)** button
2. Your installed browsers will be listed
3. Select your preferred browser
4. Click **"Use [Browser Name]"**

#### Option B: Download Chromium

If no browser is detected, or you want a dedicated test browser:

1. Click the **🌐 (Browser Setup)** button
2. Click **"📥 Download Chromium"**
3. Wait for download (may take several minutes depending on internet speed)
4. Once complete, Chromium will be auto-selected

### Step 4.3: Verify Browser Setup

1. Click **🌐 (Browser Setup)** button
2. You should see:
   - ✅ Dependencies installed (green checkmarks)
   - At least one browser listed
3. If everything is green, browser automation is ready!

### Step 4.4: Reload Window (REQUIRED)

After installing browser dependencies, you **MUST** reload VS Code:

1. Press `Ctrl+Shift+P` / `Cmd+Shift+P`
2. Type `Developer: Reload Window`
3. Press Enter

> **Important**: Dependencies are installed in the extension's directory. VS Code must reload to recognize the newly installed packages. Without reloading, you'll get "module not found" errors.

---

## 5. Extension Settings

### All Available Settings

Open VS Code Settings (`Ctrl+,` / `Cmd+,`) and search for `vibearchitect`:

| Setting | Default | Description |
|---------|---------|-------------|
| `vibearchitect.useCopilotForClaude` | `false` | Use GitHub Copilot for Claude models |
| `vibearchitect.claudeApiKey` | `""` | Direct Anthropic Claude API key |
| `vibearchitect.geminiApiKey` | `""` | Google Gemini API key |
| `vibearchitect.browserRecordingsPath` | `""` | Custom path for test recordings |
| `vibearchitect.browserSelfHealingRetries` | `3` | Retry attempts for UI tests |
| `vibearchitect.missionFolderRetentionDays` | `7` | Days to keep old mission folders |
| `vibearchitect.maxMissionFolders` | `50` | Max mission folders before cleanup |
| `vibearchitect.enableMissionFolderSymlink` | `true` | Create 'current' symlink |

### Recommended Settings Configuration

For most users, we recommend these settings in `settings.json`:

```json
{
    // AI Model Configuration (choose one)
    "vibearchitect.useCopilotForClaude": true,

    // Browser Automation (optional)
    "vibearchitect.browserSelfHealingRetries": 3,
    
    // Mission Management
    "vibearchitect.missionFolderRetentionDays": 14,
    "vibearchitect.maxMissionFolders": 100
}
```

---

## 6. Verifying Installation

### Quick Verification Checklist

Run through this checklist to ensure everything is working:

#### ✅ Extension Loaded
- [ ] "VibeArchitect Agent Manager Active! 🚀" notification appeared
- [ ] Mission Control panel is visible

#### ✅ AI Models Configured
- [ ] At least one AI model is configured (Copilot, Claude, or Gemini)
- [ ] Test: Create a new mission with a simple prompt like "Hello"

#### ✅ Browser Automation (if needed)
- [ ] Click 🌐 button - shows green checkmarks for dependencies
- [ ] At least one browser is detected or Chromium downloaded

### Full Test Run

1. **Open a workspace** (File → Open Folder)
2. In Mission Control, select your workspace from the dropdown
3. Click **"+ New Mission"**
4. Enter a simple prompt: `Create a hello world HTML file`
5. Select a model (Claude Opus 4.5 recommended)
6. Click **Send** or press Enter
7. Watch the AI agent work!

---

## 7. Troubleshooting

### Common Issues and Solutions

#### Issue: "VibeArchitect" not appearing in Command Palette

**Solution**: Reload VS Code window
1. `Ctrl+Shift+P` → `Developer: Reload Window`

#### Issue: "No AI model configured" error

**Solution**: Configure at least one model
1. Go to Settings (`Ctrl+,`)
2. Search `vibearchitect`
3. Set either `useCopilotForClaude: true` OR enter an API key

#### Issue: Browser automation not working

**Solution**: Install dependencies and reload
1. `Ctrl+Shift+P` → `VibeArchitect: Install Browser Automation Dependencies`
2. Wait for installation
3. `Ctrl+Shift+P` → `Developer: Reload Window`
4. Try again

#### Issue: Chromium download fails

**Solution**: Manual installation
```bash
# In VS Code terminal
npx playwright install chromium
```

#### Issue: "playwright-core not found" error

**Solution**: Install in the correct location and reload

The package must be installed in the **extension's directory**, not your workspace:

**Windows (PowerShell)**:
```powershell
cd "$env:USERPROFILE\.vscode\extensions\vibearchitect-0.0.1"
npm install playwright-core
```

**macOS/Linux**:
```bash
cd ~/.vscode/extensions/vibearchitect-0.0.1
npm install playwright-core
```

Then **RELOAD VS CODE WINDOW** (`Ctrl+Shift+P` → `Developer: Reload Window`).

#### Issue: Session/cookies not persisting in browser automation

**Solution**: Use Session Manager
1. Click 🔐 (Session Manager) button
2. Clear expired sessions
3. Re-authenticate and save new session

#### Issue: Extension not activating

**Solution**: Check VS Code version
1. Help → About → Check version is 1.85.0+
2. Update VS Code if needed
3. Reinstall extension

### Getting Help

If you encounter issues not covered here:

1. **Check the Output Panel**: 
   - View → Output
   - Select "VibeArchitect" from dropdown
   - Look for error messages

2. **Check Developer Console**:
   - Help → Toggle Developer Tools
   - Look for red error messages

3. **Report Issues**:
   - Note the error message
   - Note your VS Code version and OS
   - Include steps to reproduce

---

## Quick Reference Card

### Keyboard Shortcuts

| Action | Windows/Linux | macOS |
|--------|---------------|-------|
| Open Command Palette | `Ctrl+Shift+P` | `Cmd+Shift+P` |
| Open Settings | `Ctrl+,` | `Cmd+,` |
| Reload Window | Command: `Developer: Reload Window` | Same |
| Open Terminal | `Ctrl+`` ` | `Cmd+`` ` |

### Commands Available

| Command | Description |
|---------|-------------|
| `VibeArchitect: Open Mission Control` | Open the main panel |
| `VibeArchitect: Install Browser Automation Dependencies` | Install playwright-core, etc. |
| `VibeArchitect: Check Browser Dependencies Status` | Verify dependencies |

### UI Buttons in Mission Control

| Button | Location | Description |
|--------|----------|-------------|
| 🌐 | Header | Browser Setup Wizard |
| 🔐 | Header | Session Manager |
| + | Workspace header | New Mission |
| + | Workspaces section | Add Workspace |

---

## Summary: Quick Start Checklist

```
1. [ ] Install VSIX file
2. [ ] RELOAD VS CODE WINDOW (Ctrl+Shift+P → Developer: Reload Window)
3. [ ] Configure AI Model:
       [ ] Enable "useCopilotForClaude" (if you have Copilot)
       OR
       [ ] Enter claudeApiKey or geminiApiKey
4. [ ] (Optional) Install Browser Dependencies:
       [ ] Click 🌐 → Install Missing Dependencies
           (Installs to extension directory automatically)
       [ ] RELOAD VS CODE WINDOW (REQUIRED after dependency install!)
       [ ] Download Chromium or select existing browser
5. [ ] Test: Create a simple mission
```

> **Note**: The dependency installation happens in the extension's folder 
> (`~/.vscode/extensions/vibearchitect-0.0.1/`), NOT your workspace.
> This is why a Window Reload is required after installation.

---

**Version**: 2.0  
**Last Updated**: February 2026  
**Extension Version**: 0.0.1
