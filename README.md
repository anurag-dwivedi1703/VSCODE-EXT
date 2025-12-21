# VibeArchitect Agent Manager

**VibeArchitect - AI Agent Manager for VS Code.**

## Features

- **Mission Control**: A React-based webview dashboard to monitor agents.
- **VibeArchitect**: Background task runner using isolated Git Worktrees.
- **Gemini 3 Pro Integration**: AI-powered coding agents.

## Setup

1. **Install Dependencies**:
   ```bash
   npm install
   cd webview-ui && npm install
   ```

2. **Build**:
   ```bash
   # Build Webview
   cd webview-ui && npm run build
   
   # Build Extension
   npm run compile
   ```

3. **Run**:
   - Press `F5` in VS Code to launch the extension.
   - Run command: `VibeArchitect: Open Mission Control`.

## Requirements

- VS Code 1.85+
- Google GenAI API Key (Configure in Settings)

## Architecture

- **Extension**: VS Code Extension API
- **UI**: React + Vite (bundled to `webview-ui/dist`)
- **Isolation**: Git Worktrees
