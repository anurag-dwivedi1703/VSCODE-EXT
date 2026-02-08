# VibeArchitect Agent Manager

**Autonomous AI Agents That Build While You Review**

VibeArchitect lets you assign missions to AI agents that work autonomously - writing code, creating files, running tests, and delivering complete solutions. You define the goal, agents execute end-to-end, and you review the results.

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎯 **Mission Control** | Dashboard to assign, monitor, and review agent missions |
| 🤖 **Autonomous Agents** | AI agents that complete tasks end-to-end without hand-holding |
| 🔄 **Refinement Mode** | Agent-driven PRD generation with intelligent clarifying questions |
| 📋 **Planning Mode** | Phased autonomous execution with review checkpoints |
| ⚡ **Fast Mode** | Single-shot task completion for straightforward missions |
| 🌐 **Browser Testing** | Agents can test web apps automatically via Playwright |
| 🔐 **Session Manager** | Persistent browser sessions for SSO/Okta workflows |
| 📁 **Smart Context** | Agents understand your codebase without manual setup |

---

## 💡 How It Works

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   YOU       │ ──▶  │   AGENTS    │ ──▶  │   REVIEW    │
│ Assign Task │      │ Work Auto   │      │  & Approve  │
└─────────────┘      └─────────────┘      └─────────────┘
```

1. **You assign a mission** - Describe what you want built
2. **Agents work autonomously** - They plan, code, test, and iterate
3. **You review the results** - Approve, request changes, or refine

---

## 🚀 Quick Start

### Step 1: Install Extension

1. Open VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
3. Type `Extensions: Install from VSIX...`
4. Select the `vibearchitect-x.x.x.vsix` file

### Step 2: Reload Window (Required!)

Press `Ctrl+Shift+P` → Type `Developer: Reload Window` → Press Enter

Press `Ctrl+Shift+P` → Type `VibeArchitect: Open Mission Control` → Press Enter 

Right Click on `Mission Control` tab whisch should have opened and click on `Move into New Window`

### Step 3: Configure AI Model

Open Settings (`Ctrl+,`) and search for `vibearchitect`:

**Option A - GitHub Copilot (Recommended):**
```
✅ Enable: Vibearchitect › Use Copilot For Claude
```
> Requires GitHub Copilot subscription

**Option B - API Keys:**
```
Vibearchitect › Claude Api Key: sk-ant-xxxxx
```

### Step 4: Assign Your First Mission

1. Open a folder in VS Code
2. Mission Control opens automatically
3. Select your workspace
4. Describe your mission and press Enter
5. Watch agents work, then review the results!

---

## 🛠️ Developer Setup (Build from Source)

If you're cloning this repository to build or develop locally:

### Quick Setup (Recommended)

**Windows:**
```cmd
setup.bat
```

**macOS/Linux:**
```bash
chmod +x setup.sh
./setup.sh
```

### Manual Setup

```bash
# 1. Install root dependencies
npm install

# 2. Install webview dependencies (CRITICAL - includes fonts!)
cd webview-ui
npm install
cd ..

# 3. Compile the extension
npm run compile

# 4. (Optional) Create VSIX package
npx vsce package --no-dependencies
```

> ⚠️ **Common Error**: If you see `@fontsource/inter` import errors, you forgot step 2!
> The webview-ui folder has its own `package.json` that must be installed separately.

---

## 📋 Configuration

### Required Settings

| Setting | Description |
|---------|-------------|
| `vibearchitect.useCopilotForClaude` | Use GitHub Copilot models (recommended) |
| `vibearchitect.claudeApiKey` | Direct Anthropic Claude API key |
| `vibearchitect.geminiApiKey` | Google Gemini API key |

### Optional Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vibearchitect.browserRecordingsPath` | `""` | Custom path for test recordings |
| `vibearchitect.browserSelfHealingRetries` | `3` | Retry attempts for browser tests |
| `vibearchitect.missionFolderRetentionDays` | `7` | Days to keep mission history |
| `vibearchitect.maxMissionFolders` | `50` | Max mission folders before cleanup |

### Settings JSON Example

```json
{
    "vibearchitect.useCopilotForClaude": true,
    "vibearchitect.missionFolderRetentionDays": 14,
    "vibearchitect.browserSelfHealingRetries": 3
}
```

---

## 🌐 Browser Automation Setup

Enable agents to automatically test your web applications.

### Install Dependencies

**Method 1 - Via UI (Recommended):**
1. Click the 🌐 button in Mission Control header
2. Click **"📦 Install Missing Dependencies"**
3. **Reload Window** when complete

**Method 2 - Via Command:**
1. Press `Ctrl+Shift+P`
2. Run `VibeArchitect: Install Browser Automation Dependencies`
3. **Reload Window** when complete

**Method 3 - Manual:**
```powershell
# Navigate to extension directory first!
cd "$env:USERPROFILE\.vscode\extensions\vibearchitect-0.0.1"
npm install playwright-core pixelmatch pngjs
```
Then **Reload Window** (`Ctrl+Shift+P` → `Developer: Reload Window`)

### Install Browser

Click 🌐 → **"📥 Download Chromium"** (or use existing Chrome/Edge)

---

## 🎮 Mission Modes

| Mode | Best For | How It Works |
|------|----------|--------------|
| **Refinement** | New features | Agent asks clarifying questions, generates PRD, then executes |
| **Planning** | Complex tasks | Agent creates phased plan, executes with approval checkpoints |
| **Fast** | Quick tasks | Agent executes immediately, delivers results for review |

### Example Missions

```
"Build a user authentication system with login, signup, and password reset"

"Create a REST API for managing products with CRUD operations"

"Add a dark mode toggle that persists user preference"

"Write comprehensive tests for the payment module"

"Refactor the legacy database layer to use modern async patterns"
```

---

## 🔧 Commands

| Command | Description |
|---------|-------------|
| `VibeArchitect: Open Mission Control` | Open the agent dashboard |
| `VibeArchitect: Install Browser Automation Dependencies` | Install Playwright packages |
| `VibeArchitect: Check Browser Dependencies Status` | Verify installation status |

---

## ❓ Troubleshooting

### Extension not loading?
→ **Reload Window**: `Ctrl+Shift+P` → `Developer: Reload Window`

### "No AI model configured" error?
→ Enable Copilot OR add API key in Settings

### Browser automation not working?
→ Run dependency installer and **Reload Window**

### "playwright-core not found"?
→ Install in extension directory (not workspace):
```powershell
cd "$env:USERPROFILE\.vscode\extensions\vibearchitect-0.0.1"
npm install playwright-core
```
Then **Reload Window**

---

## 📌 Requirements

- **VS Code**: 1.85.0 or higher
- **AI Model**: GitHub Copilot subscription OR API key
- **Browser Testing** (optional): Node.js 18+

---

## 🏗️ Architecture

- **Extension**: VS Code Extension API with TypeScript
- **UI**: React + Vite Mission Control dashboard
- **AI Models**: Claude Opus 4.5, GPT-5, Gemini via VS Code LM API
- **Browser Automation**: Playwright-core with session management
- **Context Management**: Intelligent token budgeting per model

---

**Version**: 0.0.1  
**Last Updated**: February 2026
