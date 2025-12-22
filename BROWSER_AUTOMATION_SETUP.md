# Browser Automation Setup Guide

The browser automation feature requires additional dependencies that are **not bundled** with the extension due to size constraints.

## Quick Setup (Windows)

Run this in PowerShell as Administrator:

```powershell
# Find and navigate to extension folder
cd "$env:USERPROFILE\.vscode\extensions"
cd (Get-ChildItem -Filter "*vibearchitect*" | Select-Object -First 1).FullName

# Install dependencies
npm install playwright-core pixelmatch pngjs

# Restart VS Code
```

## Manual Setup (All Platforms)

### Step 1: Find Extension Folder

| OS | Path |
|----|------|
| Windows | `%USERPROFILE%\.vscode\extensions\undefined_publisher.vibearchitect-0.0.1` |
| macOS | `~/.vscode/extensions/undefined_publisher.vibearchitect-0.0.1` |
| Linux | `~/.vscode/extensions/undefined_publisher.vibearchitect-0.0.1` |

### Step 2: Install Dependencies

```bash
cd <extension-folder>
npm install playwright-core pixelmatch pngjs
```

### Step 3: Restart VS Code

Close and reopen VS Code for changes to take effect.

---

## Alternative: Use Built-in Browser Preview

If you don't need advanced browser automation, you can use the **built-in browser tools**:

- `reload_browser()` - Refresh the embedded preview
- `navigate_browser(url)` - Navigate the preview to a URL

These work without any additional setup and are sufficient for most web development tasks.

---

## Verify Installation

After setup, ask your agent:
```
Launch the browser automation and take a screenshot of google.com
```

If successful, Chrome will open and a screenshot will be saved.
