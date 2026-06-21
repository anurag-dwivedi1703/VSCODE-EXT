# VibeArchitect Agent Manager

**Autonomous AI Agents That Build While You Review**

VibeArchitect lets you assign missions to AI agents that work autonomously — writing code, creating files, running tests, and delivering complete solutions. You define the goal, agents execute end-to-end, and you review the results.

---

## ✨ Key Features

### 🎯 Mission Control Dashboard
A full-featured three-pane dashboard (Workspaces & Missions | Task Logs & Chat | Browser Preview & Context) for assigning, monitoring, and reviewing agent missions with live progress updates, typewriter-style AI responses, and inline diff viewing.

### 🤖 Multi-Model AI Support
Run agents on **5 different AI backends** with hot-swap model switching mid-task:

| Model | Access Method |
|-------|---------------|
| **Claude Opus 4.5** | Direct Anthropic API key |
| **Claude** (via Copilot) | GitHub Copilot subscription |
| **GPT** (via Copilot) | GitHub Copilot subscription |
| **Gemini 3 Pro / Flash** | Direct Google GenAI API key |
| **Gemini** (via Copilot) | GitHub Copilot subscription |

### 🔄 Refinement Mode
Agent-driven PRD (Product Requirements Document) generation through a multi-stage, persona-based conversation flow:
- **Analyst Persona** — asks intelligent clarifying questions via an interactive questionnaire UI
- **Architect Persona** — designs technical approach and generates a structured PRD
- **Smart Context Builder** — scans your codebase, scores file relevance, and builds token-aware context
- **Context Skeletonizer** — creates code skeletons (signatures, class outlines) to maximize context within token limits
- User approves or requests changes to the PRD before implementation begins

### 📋 Phased Execution (Planning Mode)
A 5-component guard-rail system that prevents context exhaustion on complex tasks:
- **Complexity Analyzer** — scores requirements (0–100) across scope, risk, and domain dimensions
- **Phase Generator** — intelligently splits work using feature-based, layer-based, or incremental strategies
- **Phase Executor** — orchestrates sequential execution with approval checkpoints between phases
- **Context Monitor** — real-time token budget tracking with healthy → warning → critical → exhausted alerts
- **Phase State Manager** — persists state to disk for recovery and continuation

### ⚡ Fast Mode
Single-shot task execution for straightforward missions — the agent jumps straight to coding without a planning phase.

### 📜 Workspace Constitution (Spec-Kit)
Auto-generated "Agent Bible" for each workspace — a structured set of rules the AI must follow:
- **Auto-scans** your project to detect architecture, dependencies, lint rules, and risks
- **Corporate Guidelines** — toggle OWASP security, SOLID maintainability, performance, testing, and accessibility rules
- **Constitution Review Modal** — users approve, edit, and customize rules before the agent starts
- **Drift Detection** — detects when your codebase has diverged from the constitution
- **Rule Enforcement** — validates agent actions against constitution rules in real-time

### 🌐 Browser Automation & Testing
Playwright-powered browser control for automated UI testing:
- Launch, navigate, screenshot, click, type, wait, evaluate, and close browser sessions
- **Video Recording** — full session recordings saved as artifacts
- **Self-Healing UI Verification** — uses Gemini Vision to semantically verify screenshots against expected UI, retrying on failure (configurable 1–10 attempts)
- **Visual Comparison** — pixel-level screenshot diffing via pixelmatch for regression detection
- **Network Interception** — captures and logs network requests during automation
- **Page Load Validation** — validates content rendering and checks for page errors
- **Browser Setup Wizard** — guided dependency installation UI

### 🔐 Session Manager & Login Checkpoints
- Persistent browser sessions for SSO/Okta/enterprise auth workflows
- **Login Checkpoint** — when a login page is detected, automation pauses and prompts the user to authenticate manually, then resumes seamlessly

### 📁 Smart Context & Codebase Understanding
- **Context Harvester** — gathers relevant workspace context including file tree, recent changes, and high-leverage files
- **Dependency Analyzer** — identifies critical packages, detects circular imports, and checks for vulnerabilities
- **Token Budget System** — priority-based chunk management with intelligent, language-specific truncation (TypeScript, Python)
- **Truncation Recovery** — detects truncated AI responses and automatically continues generation (up to 5 recursive attempts)

### 🛡️ Security Features
- **Secret Detection** — scans for 14+ patterns (API keys, passwords, tokens, JWTs, private keys) before file writes
- **PII Detection** — flags SSNs, credit cards, emails, phone numbers, and IP addresses
- **.env File Handling** — auto-creates `.env.example` with placeholders and updates `.gitignore`
- **Path Traversal Protection** — validates all file paths stay within the workspace root
- **High-Risk Command Gating** — dangerous commands (`rm -rf`, `DROP TABLE`, `git push --force`, `sudo`) require explicit user approval
- **File Locking** — prevents concurrent file modifications across parallel agents

### ⏪ Checkpoints & Revert
- **Shadow Repository** — invisible Git repo for workspace checkpointing after each tool call
- **Revert Manager** — one-click revert to any checkpoint with full diff inspection
- **Mission Archiving** — completed mission artifacts are archived for future reference

### 🔧 Advanced Diff Engine
A multi-strategy diff system for reliable code editing:
- **Search/Replace Parser** — parses SEARCH/REPLACE blocks from AI responses
- **Diff Matcher** — exact, whitespace-normalized, line-hint (`@@ 120-135 @@`), and fuzzy matching
- **Diff Aggregator** — batches multiple diffs to the same file for atomic application
- **Diff Recovery** — diagnoses and auto-recovers from failed diff operations
- **IDE Diff Applier** — uses VS Code's native diff API for applying changes
- **Diff Preview & Logger** — previews changes before application with full audit logging

### 📎 Attachment Support
Process user-provided attachments (images, documents) for AI context, including OCR and document summarization.

### 🗂️ Mission Folder Management
- Per-mission isolated artifact folders (`.vibearchitect/missions/<taskId>/`) to prevent context bleeding
- Configurable retention (default: 7 days) and max folder limits (default: 50)
- Thread-safe symlink operations with active folder tracking

---

## 💡 How It Works

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   YOU       │ ──▶  │   AGENTS    │ ──▶  │   REVIEW    │
│ Assign Task │      │ Work Auto   │      │  & Approve  │
└─────────────┘      └─────────────┘      └─────────────┘
```

1. **You assign a mission** — Describe what you want built
2. **Constitution generated** — Agent scans your codebase and generates rules (user reviews/approves)
3. **Agents work autonomously** — They plan, code, test, and iterate within constitution guardrails
4. **You review the results** — Approve, request changes, or refine

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

Right-click on the `Mission Control` tab which should have opened and click on `Move into New Window`

### Step 3: Configure AI Model

Open Settings (`Ctrl+,`) and search for `vibearchitect`:

**Option A — GitHub Copilot (Recommended):**
```
✅ Enable: Vibearchitect › Use Copilot For Claude
```
> Requires GitHub Copilot subscription. Provides access to Claude, GPT, and Gemini models.

**Option B — Direct API Keys:**
```
Vibearchitect › Claude Api Key: sk-ant-xxxxx
Vibearchitect › Gemini Api Key: AIza-xxxxx
```

### Step 4: Assign Your First Mission

1. Open a folder in VS Code
2. Mission Control opens automatically
3. Select your workspace
4. Choose a mission mode (Refinement, Planning, or Fast)
5. Describe your mission and press Enter
6. Watch agents work, then review the results!

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

# 2. Install webview dependencies (CRITICAL — includes fonts!)
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

### AI Provider Settings

| Setting | Description |
|---------|-------------|
| `vibearchitect.useCopilotForClaude` | Use GitHub Copilot models (recommended) |
| `vibearchitect.claudeApiKey` | Direct Anthropic Claude API key |
| `vibearchitect.geminiApiKey` | Google Gemini API key |

### Browser Automation Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vibearchitect.browserRecordingsPath` | `""` | Custom path for test recordings |
| `vibearchitect.browserSelfHealingRetries` | `3` | Retry attempts for self-healing UI tests (1–10) |

### Mission Folder Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vibearchitect.missionFolderRetentionDays` | `7` | Days to keep mission history (1–90) |
| `vibearchitect.maxMissionFolders` | `50` | Max mission folders before cleanup (5–200) |
| `vibearchitect.enableMissionFolderSymlink` | `true` | Create `current` symlink to active mission |

### Corporate Guidelines Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vibearchitect.corporateGuidelines.security` | `true` | OWASP-inspired security rules |
| `vibearchitect.corporateGuidelines.performance` | `true` | Performance best practices |
| `vibearchitect.corporateGuidelines.maintainability` | `false` | SOLID principles & clean code |
| `vibearchitect.corporateGuidelines.testing` | `false` | Testing best practices |
| `vibearchitect.corporateGuidelines.accessibility` | `false` | WCAG accessibility guidelines |

### Settings JSON Example

```json
{
    "vibearchitect.useCopilotForClaude": true,
    "vibearchitect.missionFolderRetentionDays": 14,
    "vibearchitect.browserSelfHealingRetries": 3,
    "vibearchitect.corporateGuidelines.security": true,
    "vibearchitect.corporateGuidelines.maintainability": true
}
```

---

## 🌐 Browser Automation Setup

Enable agents to automatically test your web applications.

### Install Dependencies

**Method 1 — Via UI (Recommended):**
1. Click the 🌐 button in Mission Control header
2. Click **"📦 Install Missing Dependencies"**
3. **Reload Window** when complete

**Method 2 — Via Command:**
1. Press `Ctrl+Shift+P`
2. Run `VibeArchitect: Install Browser Automation Dependencies`
3. **Reload Window** when complete

**Method 3 — Manual:**
```bash
# Navigate to extension directory first!
cd ~/.vscode/extensions/vibearchitect-2.0.5
npm install playwright-core pixelmatch pngjs
```
Then **Reload Window** (`Ctrl+Shift+P` → `Developer: Reload Window`)

### Install Browser

Click 🌐 → **"📥 Download Chromium"** (or use existing Chrome/Edge)

---

## 🎮 Mission Modes

| Mode | Best For | How It Works |
|------|----------|--------------|
| **Refinement** | New features, ambiguous requirements | Agent asks clarifying questions via interactive questionnaire, generates PRD, then executes after approval |
| **Planning** | Complex, multi-phase tasks | Agent analyzes complexity, creates phased plan with approval checkpoints between phases |
| **Fast** | Quick tasks, bug fixes | Agent executes immediately without planning phase, delivers results for review |

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
```bash
cd ~/.vscode/extensions/vibearchitect-2.0.5
npm install playwright-core
```
Then **Reload Window**

### Copilot response filtered by enterprise policy?
→ Try using **Direct API Key** mode instead of Copilot, which bypasses enterprise content filters.

---

## 📌 Requirements

- **VS Code**: 1.85.0 or higher
- **AI Model**: GitHub Copilot subscription OR direct API key (Anthropic / Google)
- **Browser Testing** (optional): Node.js 18+

---

## 🏗️ Architecture

- **Extension Host**: VS Code Extension API with TypeScript (webpack bundled)
- **UI**: React + Vite three-pane Mission Control dashboard
- **AI Clients**: Claude (direct + Copilot), GPT (Copilot), Gemini (direct + Copilot) with hot-swap support
- **Execution Engine**: TaskRunner orchestrating tool execution, checkpointing, and approval workflows
- **Spec-Kit**: Constitution-based workspace governance with drift detection and rule enforcement
- **Browser Automation**: Playwright-core with session management, video recording, and vision-based verification
- **Diff Engine**: Multi-strategy (exact, fuzzy, line-hint) with aggregation, recovery, and IDE integration
- **Context Management**: Intelligent token budgeting per model with priority-based truncation
- **Security**: Secret/PII detection, path traversal protection, high-risk command gating, file locking

---

## 📄 License

MIT — see [LICENSE](./LICENSE) for details.

---

**Version**: 2.0.5
**Last Updated**: June 2026
