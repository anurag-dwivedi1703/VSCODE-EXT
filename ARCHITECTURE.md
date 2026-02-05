# VibeArchitect Architecture Documentation

A comprehensive technical guide to the VibeArchitect VS Code extension - an AI-powered coding agent with browser automation and self-healing capabilities.

---

## Table of Contents
1. [High-Level Architecture](#high-level-architecture)
2. [Backend (Extension Host)](#backend-extension-host)
3. [Frontend (Webview UI)](#frontend-webview-ui)
4. [AI Clients](#ai-clients)
5. [Refinement Mode System](#refinement-mode-system)
6. [Phased Execution Guard-Rails](#phased-execution-guard-rails)
7. [Services](#services)
8. [Utilities](#utilities)
9. [Data Flow](#data-flow)
10. [Key Workflows](#key-workflows)
11. [Security Features](#security-features)
12. [File Structure](#file-structure)
13. [Configuration Options](#configuration-options)
14. [Dependencies](#dependencies)

---

## High-Level Architecture

```mermaid
graph TB
    subgraph "VS Code Extension Host"
        EXT[extension.ts] --> MCP[MissionControlProvider]
        EXT --> TR[TaskRunner]
        
        MCP <-->|postMessage| WV[Webview UI]
        
        TR --> AT[AgentTools]
        TR --> AI[AI Clients]
        TR --> SVC[Services]
        TR --> REF[Refinement Mode]
        TR --> PEX[Phased Execution]
        
        AI --> GC[GeminiClient]
        AI --> CC[ClaudeClient]
        AI --> CCC[CopilotClaudeClient]
        AI --> CGC[CopilotGPTClient]
        
        REF --> RM_MGR[RefinementManager]
        REF --> SCB[SmartContextBuilder]
        REF --> CS[ContextSkeletonizer]
        
        PEX --> CA[ComplexityAnalyzer]
        PEX --> PG[PhaseGenerator]
        PEX --> PE[PhaseExecutor]
        PEX --> CM[ContextMonitor]
        
        SVC --> BAS[BrowserAutomationService]
        SVC --> VCS[VisualComparisonService]
        SVC --> SR[ShadowRepository]
        SVC --> RVM[RevertManager]
        SVC --> FLM[FileLockManager]
        SVC --> CH[ContextHarvester]
        SVC --> DA[DependencyAnalyzer]
        
        TR --> SM[SpecManager]
        
        AT --> TM[TerminalManager]
        AT --> WM[WorktreeManager]
        AT --> MFM[MissionFolderManager]
    end
    
    subgraph "Webview UI (React)"
        WV --> APP[App.tsx]
        APP --> BP[BrowserPreview]
        APP --> DV[DiffViewer]
        APP --> RL[ResizableLayout]
        APP --> RQ[RefinementQuestionnaire]
        APP --> PP[PhaseProgress]
        APP --> CBI[ContextBudgetIndicator]
    end
    
    subgraph "External"
        GC <-->|API| GEMINI[Google Gemini API]
        CC <-->|API| CLAUDE[Anthropic Claude API]
        CCC <-->|Copilot| VSLM[VS Code Language Model]
        CGC <-->|Copilot| VSLM
        BAS <-->|Playwright| BROWSER[Chrome Browser]
    end
```

---

## Backend (Extension Host)

### Entry Point: `extension.ts`

| Function | Description |
|----------|-------------|
| `activate(context)` | Extension activation - creates TaskRunner, registers commands |
| `deactivate()` | Cleanup on extension deactivation |

**Registered Commands:**
- `vibearchitect.openMissionControl` - Opens the main UI panel

---

### MissionControlProvider

**Path:** `src/panels/MissionControlProvider.ts`

The webview panel host - manages communication between extension and React UI.

| Method | Description |
|--------|-------------|
| `createOrShow()` | Creates or reveals the webview panel |
| `constructor()` | Sets up panel, loads persisted workspaces/tasks |
| `_setWebviewMessageListener()` | Handles messages from webview |
| `_getWebviewContent()` | Returns HTML with bundled React app |
| `saveWorkspaces()` | Persists workspaces to globalState |
| `sendWorkspaces()` | Sends workspace list to webview |

**Message Types Handled:**
- `addWorkspace`, `removeWorkspace` - Workspace management
- `startTask` - Initiates new agent task
- `replyToTask` - User follow-up message
- `changeModel` - Switch AI model mid-task
- `revertToCheckpoint` - Revert file changes
- `openFile`, `openDiff` - File operations
- `refreshPreview`, `navigatePreview` - Browser preview control

---

### TaskRunner

**Path:** `src/engine/TaskRunner.ts`

The execution engine - orchestrates AI sessions, tool execution, and task lifecycle.

```mermaid
stateDiagram-v2
    [*] --> pending: startTask()
    pending --> planning: processTask()
    planning --> executing: Plan approved
    executing --> completed: AI signals done
    executing --> failed: Error/timeout
    planning --> completed: Fast mode
```

| Method | Description |
|--------|-------------|
| `startTask(prompt, path, mode, model)` | Creates new task, returns taskId |
| `processTask(taskId)` | Main processing - creates AI session, runs loop |
| `runExecutionLoop(taskId, chat, tools)` | Tool execution loop - sends messages, executes tools |
| `changeModel(taskId, newModel)` | Hot-swap AI model mid-task |
| `approveReview(taskId, feedback?)` | Approve pending plan in Agent Decides mode |
| `rejectReview(taskId)` | Reject pending plan |
| `approveCommand(taskId)` | Approve high-risk command execution |
| `declineCommand(taskId)` | Decline high-risk command |
| `setAgentMode(mode)` | Set global agent mode ('auto' or 'agent-decides') |
| `replyToTask(taskId, message)` | Process user follow-up message |
| `revertTask(taskId, checkpointId)` | Revert to checkpoint using ShadowRepository |
| `loadTasks()` / `saveTask()` | Task persistence |
| `buildContextFromTask(task)` | Rebuilds context for session restoration |

**Key Interfaces:**

```typescript
interface AgentTask {
    id: string;
    prompt: string;
    status: 'pending' | 'planning' | 'executing' | 'completed' | 'failed';
    progress: number;
    logs: string[];
    worktreePath?: string;
    chat: { role: 'user' | 'assistant', text: string }[];
    artifacts: string[];
    mode?: 'planning' | 'fast';
    model?: string;
    checkpoints?: { id: string, message: string, timestamp: number }[];
    fileEdits?: FileEdit[];
    awaitingApproval?: {
        type: 'plan' | 'command' | 'constitution' | 'constitution-update';
        content: string;
        riskReason?: string;
    };
}
```

---

### AgentTools

**Path:** `src/engine/AgentTools.ts`

Provides all tools available to AI agents.

| Category | Methods |
|----------|---------|
| **File Operations** | `readFile()`, `writeFile()`, `listFiles()` |
| **Commands** | `runCommand()` |
| **Web Search** | `searchWeb()` |
| **Simple Preview** | `reload_browser()`, `navigate_browser()` |
| **Browser Automation** | `browserLaunch()`, `browserNavigate()`, `browserScreenshot()`, `browserClick()`, `browserType()`, `browserWaitFor()`, `browserGetDOM()`, `browserReload()`, `browserEvaluate()`, `browserClose()` |
| **UI Verification** | `browserVerifyUI()` - Uses Gemini Vision for semantic analysis |
| **Status Checks** | `isBrowserRunning()`, `isBrowserRecording()` |

---

## Frontend (Webview UI)

### App.tsx

**Path:** `webview-ui/src/App.tsx` (899 lines)

Main React application with three-pane layout.

```mermaid
graph LR
    subgraph "Three-Pane Layout"
        LP[Left Pane<br/>Workspaces & Missions] 
        MP[Middle Pane<br/>Task Logs & Chat]
        RP[Right Pane<br/>Browser Preview & Context]
    end
```

| Function/Hook | Description |
|---------------|-------------|
| `App()` | Main component - manages all state |
| `parseLogs()` | Parses raw log strings into structured LogGroup objects |
| `messageHandler()` | Handles messages from extension (task updates, etc.) |
| `handleStartTask()` | Sends startTask message to extension |
| `handleNewChat()` | Resets for new conversation |

**Key State:**
- `workspaces[]` - Workspace list
- `missions[]` - Task/mission list
- `selectedMission` - Current active mission
- `logs[]` - Raw log strings
- `parsedLogs[]` - Structured log groups
- `previewUrl` - URL for browser preview
- `previewContent` - Artifact content for right pane

### Components

| Component | Path | Description |
|-----------|------|-------------|
| **BrowserPreview** | `components/BrowserPreview.tsx` | Embedded iframe for live web preview |
| **DiffViewer** | `components/DiffViewer.tsx` | GitHub-style diff display with +/- highlighting |
| **ResizableLayout** | `components/ResizableLayout.tsx` | Three-pane resizable layout with drag handles |
| **RefinementQuestionnaire** | `components/RefinementQuestionnaire.tsx` | Interactive Q&A interface for Refinement Mode |
| **PhaseProgress** | `components/PhaseProgress.tsx` | Visual timeline showing phase execution progress |
| **PhaseApprovalModal** | `components/PhaseApprovalModal.tsx` | Modal for approving/rejecting phase completions |
| **ContextBudgetIndicator** | `components/ContextBudgetIndicator.tsx` | Real-time token budget visualization |
| **DiffRecoveryModal** | `components/DiffRecoveryModal.tsx` | UI for recovering from failed diff operations |
| **BrowserSetupWizard** | `components/BrowserSetupWizard.tsx` | Guided setup for browser automation dependencies |
| **ConstitutionReviewModal** | `components/ConstitutionReviewModal.tsx` | Review/approve auto-generated constitution |
| **SessionManagerUI** | `components/SessionManagerUI.tsx` | Manage saved sessions and restore state |
| **TypewriterText** | `components/TypewriterText.tsx` | Animated typewriter text effect for AI responses |

---

## AI Clients

### GeminiClient

**Path:** `src/ai/GeminiClient.ts`

Primary AI client using Google's Gemini API.

| Method | Description |
|--------|-------------|
| `constructor(apiKey, modelName)` | Initialize with API key |
| `startSession(systemPrompt, thinkingLevel)` | Creates chat session with tool definitions |
| `research(query)` | Web search using Gemini grounding |
| `analyzeScreenshot(base64, mime, description, mission)` | **Vision API** - Semantic UI verification |

**Tool Declarations (14 tools):**
`read_file`, `write_file`, `list_files`, `run_command`, `reload_browser`, `navigate_browser`, `search_web`, `browser_launch`, `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_wait_for`, `browser_get_dom`, `browser_verify_ui`, `browser_close`

### ClaudeClient

**Path:** `src/ai/ClaudeClient.ts`

Anthropic Claude API client with same tool definitions as Gemini.

| Method | Description |
|--------|-------------|
| `startSession(systemPrompt, thinkingLevel)` | Creates session with tool_use capability |
| `sendMessage(prompt)` | Handles multi-turn with tool_use blocks |

### CopilotClaudeClient

**Path:** `src/ai/CopilotClaudeClient.ts`

Uses VS Code's Language Model API for Claude via GitHub Copilot subscription.

| Method | Description |
|--------|-------------|
| `startSession(systemPrompt)` | Uses `vscode.lm.selectChatModels()` |
| Text parsing workaround | Extracts tool calls from text (no native function calling) |

---

## Refinement Mode System

**Path:** `src/engine/refinement/`

The Refinement Mode system enables intelligent PRD (Product Requirements Document) generation through multi-stage AI-guided conversations. It decouples requirement refinement from implementation.

```mermaid
graph TB
    subgraph "Refinement Flow"
        UP[User Prompt] --> RM[RefinementManager]
        RM --> SCB[SmartContextBuilder]
        SCB --> CS[ContextSkeletonizer]
        CS --> RS[RefinementSession]
        RS --> |Analyst Persona| Q[Clarifying Questions]
        Q --> |User Answers| RS
        RS --> |Architect Persona| PRD[PRD Generation]
        PRD --> |User Approval| IMPL[Implementation Phase]
    end
```

### RefinementManager

**Path:** `src/engine/refinement/RefinementManager.ts`

Orchestrates refinement sessions and provides the main entry point for Refinement Mode.

| Method | Description |
|--------|-------------|
| `startSessionWithSmartContext()` | Starts session with intelligent context building |
| `startSession()` | Starts refinement with provided context |
| `handleUserMessage()` | Processes user responses during refinement |
| `approveSession()` | Approves generated PRD artifact |
| `cancelSession()` | Cancels active refinement session |
| `getSession()` | Retrieves session by ID |

### SmartContextBuilder

**Path:** `src/engine/refinement/SmartContextBuilder.ts`

Intelligently scans and builds context from the workspace based on relevance to the user's prompt.

| Method | Description |
|--------|-------------|
| `buildContext()` | Builds context with token budget awareness |
| `setWorkspaceRoot()` | Sets workspace root for file scanning |
| `extractKeywords()` | Extracts relevant keywords from prompt |
| `scoreFileRelevance()` | Scores file relevance to prompt |

**Features:**
- Keyword extraction from user prompts
- File relevance scoring based on path and content
- Token budget management
- Full content for high-relevance files, skeletons for structure

### ContextSkeletonizer

**Path:** `src/engine/refinement/ContextSkeletonizer.ts`

Creates code skeletons (signatures, class outlines) to maximize context within token limits.

| Method | Description |
|--------|-------------|
| `skeletonize()` | Creates skeleton from full file content |
| `extractSignatures()` | Extracts function/class signatures |
| `summarizeImports()` | Summarizes import statements |

### RefinementSession

**Path:** `src/engine/refinement/RefinementSession.ts`

Manages individual refinement session lifecycle with persona-based interactions.

| Method | Description |
|--------|-------------|
| `start()` | Initiates session with context |
| `handleUserResponse()` | Processes user answers |
| `transition()` | Transitions between personas |
| `generateArtifact()` | Generates final PRD artifact |

**Personas:**
- **Analyst** - Asks clarifying questions about requirements
- **Architect** - Designs technical approach and generates PRD
- **Implementer** - (Future) Executes the approved PRD

### RefinementTokenManager

**Path:** `src/engine/refinement/RefinementTokenManager.ts`

Manages token budgets for different refinement stages.

| Method | Description |
|--------|-------------|
| `getAvailableTokensForStage()` | Returns token budget for a stage |
| `trackUsage()` | Tracks token consumption |
| `canAfford()` | Checks if operation fits in budget |

---

## Phased Execution Guard-Rails

**Path:** `src/services/` (multiple files)

A 5-component system that prevents context exhaustion when handling large, complex requirements by splitting them into manageable phases.

```mermaid
graph LR
    subgraph "Phase 1: Analysis"
        REQ[User Requirement] --> CA[ComplexityAnalyzer]
        CA --> |Score & Metrics| DEC{Score > 40?}
    end
    
    subgraph "Phase 2: Generation"
        DEC --> |Yes| PG[PhaseGenerator]
        PG --> |Phases| PSM[PhaseStateManager]
    end
    
    subgraph "Phase 3: Monitoring"
        PSM --> CM[ContextMonitor]
        CM --> |Budget Alerts| PE[PhaseExecutor]
    end
    
    subgraph "Phase 4: Execution"
        PE --> |Execute| IMPL[Implementation]
        IMPL --> |Complete| NEXT[Next Phase]
    end
    
    DEC --> |No| SINGLE[Single-Phase Execution]
```

### ComplexityAnalyzer

**Path:** `src/services/ComplexityAnalyzer.ts`

Analyzes user requirements and produces complexity scores to determine execution strategy.

| Method | Description |
|--------|-------------|
| `analyze()` | Analyzes requirement, returns ComplexityScore |
| `extractMetrics()` | Extracts feature count, scope indicators, risk factors |
| `calculateScore()` | Computes numeric complexity score (0-100) |
| `determineRecommendation()` | Returns PROCEED, SPLIT_PHASES, or REQUIRE_CLARIFICATION |

**Complexity Levels:**
- `LOW` (0-20) - Simple, single-phase execution
- `MEDIUM` (20-40) - Moderate, may benefit from phases
- `HIGH` (40-70) - Complex, phased execution recommended
- `EXTREME` (70-100) - Very complex, must split into phases

**Detection Patterns:**
- Scope indicators: "full-stack", "complete app", "from scratch"
- Risk factors: database migrations, refactoring, security concerns
- Technical domains: frontend, backend, database, mobile, devops

### PhaseGenerator

**Path:** `src/services/PhaseGenerator.ts`

Splits complex requirements into manageable phases using intelligent strategies.

| Method | Description |
|--------|-------------|
| `generatePhases()` | Generates phases from requirement |
| `splitByFeatures()` | Feature-based splitting strategy |
| `splitByLayers()` | Layer-based splitting (foundation → UI) |
| `splitIncremental()` | Incremental enhancement strategy |
| `determineStrategy()` | Auto-selects best splitting strategy |

**Splitting Strategies:**
- `feature-based` - Groups by functional features (auth, payments, etc.)
- `layer-based` - Groups by technical layers (data → API → UI)
- `incremental` - Core functionality first, then enhancements
- `auto` - Automatically selects best strategy

**Phase Structure:**
```typescript
interface Phase {
    id: string;
    name: string;
    description: string;
    requirements: string[];
    deliverables: string[];
    verificationCriteria: string[];
    estimatedTokens: number;
    dependencies: string[];
    status: PhaseStatus;
}
```

### ContextMonitor

**Path:** `src/services/ContextMonitor.ts`

Real-time token usage tracking with alerts and budget management.

| Method | Description |
|--------|-------------|
| `trackUsage()` | Records token usage event |
| `trackText()` | Estimates and tracks text tokens |
| `trackPrompt()` | Tracks prompt tokens |
| `trackResponse()` | Tracks response tokens |
| `getBudget()` | Returns current budget state |
| `getStatistics()` | Returns usage statistics |

**Budget Status Levels:**
- `healthy` (0-70%) - Continue normally
- `warning` (70-90%) - Consider wrapping up
- `critical` (90-100%) - Checkpoint and transition
- `exhausted` (100%+) - Must stop

**Events Emitted:**
- `onWarning` - Budget at 70%
- `onCritical` - Budget at 90%
- `onExhausted` - Budget depleted
- `onStatusChange` - Any status change
- `onUsageTracked` - Each usage event

### PhaseExecutor

**Path:** `src/services/PhaseExecutor.ts`

Orchestrates phased execution with approval workflows.

| Method | Description |
|--------|-------------|
| `initialize()` | Initializes for a mission |
| `analyzeRequirement()` | Determines execution mode |
| `executePhase()` | Executes a single phase |
| `executeAllPhases()` | Runs all phases sequentially |
| `respondToApproval()` | Handles phase approval response |

**Execution Modes:**
- `auto` - System decides based on complexity
- `single` - Force single-phase execution
- `phased` - Force phased execution

### PhaseStateManager

**Path:** `src/services/PhaseStateManager.ts`

Persists phase execution state for recovery and continuation.

| Method | Description |
|--------|-------------|
| `save()` | Saves current state to disk |
| `load()` | Loads state from disk |
| `updatePhaseStatus()` | Updates individual phase status |
| `recordPhaseResult()` | Records phase completion result |
| `getResumablePhase()` | Gets next phase to resume |

---

## Services

**Path:** `src/services/`

The services layer provides specialized functionality for browser automation, file management, security analysis, and more.

### Core Services

#### BrowserAutomationService

**Path:** `src/services/BrowserAutomationService.ts`

Playwright-based browser control for automated UI testing.

```mermaid
sequenceDiagram
    participant Agent
    participant BAS as BrowserAutomationService
    participant PW as Playwright
    participant Chrome
    
    Agent->>BAS: launchBrowser(true)
    BAS->>PW: dynamic import
    BAS->>PW: chromium.launch()
    PW->>Chrome: Open browser
    Agent->>BAS: navigateTo(url)
    BAS->>Chrome: page.goto()
    Agent->>BAS: takeScreenshot()
    BAS->>Chrome: page.screenshot()
    Agent->>BAS: closeBrowser()
    BAS->>Chrome: Close & save video
```

| Method | Description |
|--------|-------------|
| `launchBrowser(recordVideo)` | Launch Chrome with optional video recording |
| `navigateTo(url)` | Navigate with networkidle wait |
| `takeScreenshot(name)` | Full-page screenshot |
| `click(selector)` / `type(selector, text)` | Page interaction |
| `waitForSelector(selector, timeout)` | Wait for element |
| `getPageContent()` | Capture DOM HTML |
| `closeBrowser()` | Close and return RecordingResult |

### VisualComparisonService

**Path:** `src/services/VisualComparisonService.ts`

Pixel-level screenshot comparison using pixelmatch.

| Method | Description |
|--------|-------------|
| `compareScreenshots(baseline, current, diffPath)` | Pixel diff comparison |
| `saveBaseline(path, category)` | Save as baseline for future comparisons |
| `compareAgainstBaseline(current, category)` | Compare current against saved baseline |
| `analyzeScreenshotForIssues(path)` | Basic issue detection (blank pages, errors) |

### ShadowRepository

**Path:** `src/services/ShadowRepository.ts`

Invisible Git repository for workspace checkpointing.

```mermaid
graph LR
    WS[User Workspace] -->|tracked by| SR[Shadow .git<br/>in globalStorage]
    SR -->|checkpoints| H[Commit History]
```

| Method | Description |
|--------|-------------|
| `initialize()` | Create shadow git repo with `--separate-git-dir` |
| `snapshot(message)` | Create checkpoint commit |
| `getHistory()` | Get checkpoint history |
| `configureExclusions()` | Setup .gitignore (node_modules, etc.) |

### RevertManager

**Path:** `src/services/RevertManager.ts`

Handles file reversion to checkpoints.

| Method | Description |
|--------|-------------|
| `revertToCheckpoint(checkpointId)` | Restore files to checkpoint state |
| `getFileDiff(checkpointId, filePath)` | Get diff between current and checkpoint |

### FileLockManager

**Path:** `src/services/FileLockManager.ts`

Prevents concurrent file modifications by multiple agents.

| Method | Description |
|--------|-------------|
| `acquireLock(path, taskId)` | Lock file for exclusive access |
| `releaseLock(path, taskId)` | Release file lock |
| `isLocked(path)` | Check if file is locked |

### ContextHarvester

**Path:** `src/services/ContextHarvester.ts`

Extracts codebase context for AI consumption.

| Method | Description |
|--------|-------------|
| `harvest()` | Gathers relevant context from workspace |
| `getFileTree()` | Gets hierarchical file structure |
| `getRecentChanges()` | Gets recently modified files |

### Additional Services

#### DependencyAnalyzer

**Path:** `src/services/DependencyAnalyzer.ts`

Analyzes project dependencies to identify critical packages, security vulnerabilities, and circular imports.

| Method | Description |
|--------|-------------|
| `analyze()` | Performs full dependency analysis |
| `identifyCriticalDependencies()` | Finds critical packages (React, TypeScript, etc.) |
| `detectCircularImports()` | Detects circular import issues |
| `checkVulnerabilities()` | Checks for known vulnerabilities |

**Known Critical Packages:**
- Build tools: webpack, vite, typescript
- Frameworks: react, vue, angular, next
- Database: prisma, mongoose, sequelize
- Auth: passport, jsonwebtoken

#### AttachmentProcessor

**Path:** `src/services/AttachmentProcessor.ts`

Processes user-provided attachments (images, documents) for AI context.

| Method | Description |
|--------|-------------|
| `processAttachment()` | Processes single attachment |
| `extractTextFromImage()` | OCR for image content |
| `summarizeDocument()` | Summarizes document content |

#### BrowserDependencyInstaller

**Path:** `src/services/BrowserDependencyInstaller.ts`

Automated installation of browser automation dependencies (Playwright, Chromium).

| Method | Description |
|--------|-------------|
| `checkDependencies()` | Checks if dependencies are installed |
| `installDependencies()` | Installs missing dependencies |
| `getBrowserPath()` | Gets path to installed browser |

#### BrowserManager

**Path:** `src/services/BrowserManager.ts`

Manages browser lifecycle and session state for automation.

| Method | Description |
|--------|-------------|
| `launch()` | Launches browser instance |
| `getPage()` | Gets current page |
| `close()` | Closes browser instance |
| `isRunning()` | Checks if browser is active |

#### LintRuleExtractor

**Path:** `src/services/LintRuleExtractor.ts`

Extracts linting rules from project configuration for constitution generation.

| Method | Description |
|--------|-------------|
| `extract()` | Extracts all lint rules |
| `parseESLintConfig()` | Parses ESLint configuration |
| `parseTSConfig()` | Parses TypeScript configuration |

#### NetworkInterceptor

**Path:** `src/services/NetworkInterceptor.ts`

Intercepts and logs network requests during browser automation.

| Method | Description |
|--------|-------------|
| `startIntercepting()` | Begins network interception |
| `getRequests()` | Gets captured requests |
| `stopIntercepting()` | Stops interception |

#### PageLoadValidator

**Path:** `src/services/PageLoadValidator.ts`

Validates page load completion and content rendering.

| Method | Description |
|--------|-------------|
| `waitForLoad()` | Waits for page load |
| `validateContent()` | Validates expected content |
| `checkErrors()` | Checks for page errors |

#### RiskDetector

**Path:** `src/services/RiskDetector.ts`

Detects high-risk commands that require user approval.

| Method | Description |
|--------|-------------|
| `analyze()` | Analyzes command for risks |
| `isHighRisk()` | Checks if command is high-risk |
| `getRiskReason()` | Gets reason for risk classification |

**High-Risk Patterns:**
- `rm -rf`, `del /s` - Destructive file operations
- `DROP TABLE`, `DELETE FROM` - Database modifications
- `sudo`, `admin` - Privilege escalation
- `npm publish`, `git push --force` - Irreversible operations

#### RuleEnforcer

**Path:** `src/services/RuleEnforcer.ts`

Enforces constitution rules during agent execution.

| Method | Description |
|--------|-------------|
| `enforce()` | Enforces rules on agent action |
| `checkViolations()` | Checks for rule violations |
| `suggestFixes()` | Suggests fixes for violations |

#### SessionStorageManager

**Path:** `src/services/SessionStorageManager.ts`

Manages session storage for browser automation state.

| Method | Description |
|--------|-------------|
| `save()` | Saves session state |
| `restore()` | Restores session state |
| `clear()` | Clears session storage |

#### AuthSessionManager

**Path:** `src/services/AuthSessionManager.ts`

Manages authentication sessions for VS Code Language Model API.

| Method | Description |
|--------|-------------|
| `getSession()` | Gets current auth session |
| `refreshSession()` | Refreshes expired session |
| `signOut()` | Signs out of session |

---

## Utilities

**Path:** `src/utils/`

Utility modules providing common functionality across the extension.

### MissionFolderManager

**Path:** `src/utils/MissionFolderManager.ts`

Manages chat-specific mission folders to prevent context bleeding between missions.

| Method | Description |
|--------|-------------|
| `getMissionFolder()` | Gets or creates mission folder for chat |
| `generateChatId()` | Generates unique chat identifier |
| `createFolderName()` | Creates timestamped folder name |
| `updateCurrentSymlink()` | Updates 'current' symlink to active mission |
| `cleanup()` | Cleans up old mission folders |

**Folder Structure:**
```
.vibearchitect/
├── current -> ./2025-01-16_14-30-22_abc123/  (symlink)
├── 2025-01-15_10-00-00_xyz789/
│   ├── task.md
│   ├── implementation_plan.md
│   └── mission_summary.md
└── 2025-01-16_14-30-22_abc123/              (current)
```

**Features:**
- Thread-safe with mutex for symlink operations
- Active folder tracking to prevent cleanup of in-use folders
- Configurable retention (default: 7 days)
- Maximum folder limit (default: 50)

### TokenBudget

**Path:** `src/utils/TokenBudget.ts`

Utility for tracking and managing token usage with VS Code's Language Model API.

| Method | Description |
|--------|-------------|
| `estimateTokens()` | Estimates tokens for content |
| `addChunk()` | Adds content chunk to budget |
| `addChunkWithTruncation()` | Adds with auto-truncation |
| `makeRoomFor()` | Removes low-priority chunks to fit new content |
| `getSummary()` | Gets budget summary |

**Features:**
- Priority-based chunk management
- Intelligent truncation for large files
- Language-specific truncation (TypeScript, Python)

### TokenManager

**Path:** `src/utils/TokenManager.ts`

Higher-level token management for sessions.

| Method | Description |
|--------|-------------|
| `createBudget()` | Creates new token budget |
| `trackUsage()` | Tracks token usage |
| `getRemaining()` | Gets remaining tokens |

### Diff Utilities

#### SearchReplaceParser

**Path:** `src/utils/SearchReplaceParser.ts`

Parses SEARCH/REPLACE diff blocks from AI responses.

| Method | Description |
|--------|-------------|
| `parse()` | Parses diff blocks from text |
| `validate()` | Validates diff syntax |
| `extractBlocks()` | Extracts individual blocks |

#### DiffMatcher

**Path:** `src/utils/DiffMatcher.ts`

Advanced diff matching with multiple strategies.

| Method | Description |
|--------|-------------|
| `findMatch()` | Finds best match for search block |
| `exactMatch()` | Attempts exact string match |
| `fuzzyMatch()` | Attempts fuzzy matching |
| `lineHintMatch()` | Uses line number hints |

**Matching Strategies:**
1. Exact match
2. Whitespace-normalized match
3. Line hint match (@@ 120-135 @@)
4. Fuzzy match with scoring

#### DiffAggregator

**Path:** `src/utils/DiffAggregator.ts`

Aggregates multiple diffs to same file for batch application.

| Method | Description |
|--------|-------------|
| `queue()` | Queues diff for file |
| `flush()` | Applies all queued diffs |
| `getPending()` | Gets pending diffs |

#### DiffRecovery

**Path:** `src/utils/DiffRecovery.ts`

Recovers from failed diff operations.

| Method | Description |
|--------|-------------|
| `diagnose()` | Diagnoses diff failure |
| `suggestFix()` | Suggests fix for failure |
| `recover()` | Attempts automatic recovery |

#### DiffPreview

**Path:** `src/utils/DiffPreview.ts`

Previews diffs before application.

| Method | Description |
|--------|-------------|
| `preview()` | Generates diff preview |
| `highlight()` | Highlights changes |

#### DiffLogger

**Path:** `src/utils/DiffLogger.ts`

Logs diff operations for debugging.

| Method | Description |
|--------|-------------|
| `logAttempt()` | Logs diff attempt |
| `logSuccess()` | Logs successful diff |
| `logFailure()` | Logs failed diff |

#### IDEDiffApplier

**Path:** `src/utils/IDEDiffApplier.ts`

Uses VS Code's native diff system for applying changes.

| Method | Description |
|--------|-------------|
| `apply()` | Applies diff using VS Code API |
| `showDiff()` | Shows diff in editor |

### File Utilities

#### FileDiscovery

**Path:** `src/utils/FileDiscovery.ts`

Discovers relevant files in workspace.

| Method | Description |
|--------|-------------|
| `discover()` | Discovers files matching criteria |
| `filterByRelevance()` | Filters by relevance score |

#### FileSearch

**Path:** `src/utils/FileSearch.ts`

Searches file contents.

| Method | Description |
|--------|-------------|
| `search()` | Searches files for pattern |
| `grep()` | Grep-like search |

#### SymbolNavigator

**Path:** `src/utils/SymbolNavigator.ts`

Navigates code symbols using VS Code's symbol provider.

| Method | Description |
|--------|-------------|
| `getSymbols()` | Gets symbols in document |
| `findSymbol()` | Finds specific symbol |
| `navigateTo()` | Navigates to symbol |

---

## Data Flow

### Message Flow: Extension ↔ Webview

```mermaid
sequenceDiagram
    participant UI as Webview (React)
    participant MCP as MissionControlProvider
    participant TR as TaskRunner
    participant AI as AI Client
    
    UI->>MCP: postMessage({type: 'startTask', prompt})
    MCP->>TR: startTask(prompt, path, mode, model)
    TR->>AI: startSession(systemPrompt)
    
    loop Execution Loop
        AI->>TR: response with function calls
        TR->>TR: Execute tools
        TR->>MCP: taskUpdate (via callback)
        MCP->>UI: postMessage({type: 'taskUpdate', task})
    end
    
    TR->>MCP: Task completed
    MCP->>UI: postMessage({type: 'taskUpdate', task})
```

---

## Key Workflows

### 1. Self-Healing UI Verification

```mermaid
flowchart TD
    A[Agent creates web UI] --> B[browser_launch true]
    B --> C[browser_navigate url]
    C --> D[browser_verify_ui category, description]
    D --> E{Gemini Vision Analysis}
    E -->|PASS| F[browser_close]
    E -->|FAIL + issues| G[Fix code based on suggestions]
    G --> D
    F --> H[Video recording saved]
```

### 2. Task Checkpoint & Revert

```mermaid
flowchart LR
    A[Tool Call] --> B[ShadowRepo.snapshot]
    B --> C[Checkpoint Created]
    C --> D[Tool Executes]
    D --> E[File Modified]
    
    F[User: Revert] --> G[RevertManager]
    G --> H[Restore from checkpoint]
```

---

## Security Features

### Secret Detection

**Path:** `src/ai/SecurityInstructions.ts`

AgentTools automatically scans file content for sensitive data before writing:

| Detection Type | Examples | Action |
|----------------|----------|--------|
| **API Keys** | `sk-...`, `AKIA...`, `ghp_...` | Warning logged, continues |
| **Passwords** | `password=`, `secret=` | Warning logged, continues |
| **Private Keys** | `-----BEGIN RSA PRIVATE KEY-----` | Warning logged, continues |

### PII Detection

Scans text files for personally identifiable information:

| PII Type | Pattern | Severity |
|----------|---------|----------|
| **SSN** | `XXX-XX-XXXX` | High |
| **Credit Card** | `XXXX-XXXX-XXXX-XXXX` | High |
| **Email** | `user@domain.com` | Medium |
| **Phone** | `(XXX) XXX-XXXX` | Medium |

### .env File Handling

When writing `.env` files:
1. Auto-creates `.env.example` with placeholder values
2. Auto-updates `.gitignore` to exclude `.env`
3. Warns about hardcoded secrets

### File Locking

**FileLockManager** prevents concurrent file modifications:
- Acquires lock before write operations
- Releases lock after completion
- Prevents race conditions between parallel agents

### Path Traversal Protection

AgentTools validates all file paths:
```typescript
if (!fullPath.startsWith(path.resolve(this.worktreeRoot))) {
    throw new Error(`Access Denied: Path traverses outside workspace root.`);
}
```

---

## File Structure

```
VSCODE-EXT/
├── src/
│   ├── extension.ts                     # Entry point
│   ├── ai/
│   │   ├── GeminiClient.ts              # Gemini API + Vision
│   │   ├── ClaudeClient.ts              # Anthropic API
│   │   ├── CopilotClaudeClient.ts       # VS Code LM API (Claude)
│   │   ├── CopilotGPTClient.ts          # VS Code LM API (GPT)
│   │   ├── PromptEngine.ts              # Prompt templates
│   │   └── SecurityInstructions.ts      # Secret/PII detection
│   ├── engine/
│   │   ├── TaskRunner.ts                # Execution engine
│   │   ├── AgentTools.ts                # Tool implementations
│   │   ├── TerminalManager.ts           # Terminal sessions
│   │   ├── WorktreeManager.ts           # Git worktrees
│   │   ├── SpecManager.ts               # Specification management
│   │   ├── ConstitutionSchema.ts        # Constitution type definitions
│   │   ├── CorporateGuidelines.ts       # Corporate rule definitions
│   │   └── refinement/                  # Refinement Mode system
│   │       ├── index.ts                 # Module exports
│   │       ├── RefinementManager.ts     # Orchestrates sessions
│   │       ├── RefinementSession.ts     # Session lifecycle
│   │       ├── RefinementTypes.ts       # Type definitions
│   │       ├── RefinementPrompts.ts     # Persona prompts
│   │       ├── RefinementTokenManager.ts # Token budgets
│   │       ├── SmartContextBuilder.ts   # Intelligent context
│   │       └── ContextSkeletonizer.ts   # Code skeletons
│   ├── panels/
│   │   └── MissionControlProvider.ts    # Webview host
│   ├── services/
│   │   ├── BrowserAutomationService.ts  # Playwright automation
│   │   ├── BrowserDependencyInstaller.ts # Browser setup
│   │   ├── BrowserManager.ts            # Browser lifecycle
│   │   ├── VisualComparisonService.ts   # pixelmatch
│   │   ├── ShadowRepository.ts          # Git checkpoints
│   │   ├── RevertManager.ts             # Checkpoint revert
│   │   ├── FileLockManager.ts           # Concurrent access
│   │   ├── ContextHarvester.ts          # Workspace context
│   │   ├── AuthSessionManager.ts        # Copilot authentication
│   │   ├── ComplexityAnalyzer.ts        # Requirement analysis
│   │   ├── PhaseGenerator.ts            # Phase splitting
│   │   ├── PhaseExecutor.ts             # Phase orchestration
│   │   ├── PhaseStateManager.ts         # State persistence
│   │   ├── ContextMonitor.ts            # Token tracking
│   │   ├── DependencyAnalyzer.ts        # Dependency analysis
│   │   ├── RiskDetector.ts              # High-risk detection
│   │   ├── RuleEnforcer.ts              # Rule enforcement
│   │   ├── LintRuleExtractor.ts         # Lint rule extraction
│   │   ├── AttachmentProcessor.ts       # Attachment handling
│   │   ├── NetworkInterceptor.ts        # Network interception
│   │   ├── PageLoadValidator.ts         # Page validation
│   │   ├── SessionStorageManager.ts     # Session storage
│   │   └── TaskRunnerPhaseIntegration.ts # Phase integration
│   ├── utils/
│   │   ├── SearchReplaceParser.ts       # Diff parsing
│   │   ├── DiffLogger.ts                # Diff visualization
│   │   ├── DiffMatcher.ts               # Advanced matching
│   │   ├── DiffAggregator.ts            # Batch diffs
│   │   ├── DiffRecovery.ts              # Failure recovery
│   │   ├── DiffPreview.ts               # Preview generation
│   │   ├── IDEDiffApplier.ts            # VS Code diff API
│   │   ├── TokenBudget.ts               # Token management
│   │   ├── TokenManager.ts              # Session tokens
│   │   ├── MissionFolderManager.ts      # Mission folders
│   │   ├── FileDiscovery.ts             # File discovery
│   │   ├── FileSearch.ts                # File search
│   │   └── SymbolNavigator.ts           # Symbol navigation
│   └── test/
│       ├── runTest.ts                   # Test runner
│       └── suite/                       # Test suites
│           ├── ComplexityAnalyzer.test.ts
│           ├── ContextMonitor.test.ts
│           ├── PhaseExecutor.test.ts
│           ├── PhaseGenerator.test.ts
│           ├── PhaseStateManager.test.ts
│           └── taskRunner.test.ts
├── webview-ui/
│   └── src/
│       ├── App.tsx                      # Main React app
│       ├── App.css                      # Styles
│       ├── main.tsx                     # React entry
│       ├── components/
│       │   ├── BrowserPreview.tsx       # Live preview iframe
│       │   ├── BrowserSetupWizard.tsx   # Browser setup wizard
│       │   ├── DiffViewer.tsx           # Git diff display
│       │   ├── DiffRecoveryModal.tsx    # Diff recovery UI
│       │   ├── ResizableLayout.tsx      # Three-pane layout
│       │   ├── RefinementQuestionnaire.tsx # Q&A interface
│       │   ├── PhaseProgress.tsx        # Phase timeline
│       │   ├── PhaseApprovalModal.tsx   # Phase approval
│       │   ├── ContextBudgetIndicator.tsx # Token budget
│       │   ├── ConstitutionReviewModal.tsx # Constitution review
│       │   ├── SessionManagerUI.tsx     # Session management
│       │   └── TypewriterText.tsx       # Text animation
│       └── utilities/
│           └── vscode.ts                # postMessage wrapper
├── package.json                         # Dependencies & config
├── webpack.config.js                    # Build configuration
├── tsconfig.json                        # TypeScript config
├── .eslintrc.json                       # Linting rules
├── ARCHITECTURE.md                      # This document
└── README.md                            # Project overview
```

---

## Configuration Options

### AI Provider Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `vibearchitect.geminiApiKey` | string | - | Google Gemini API key |
| `vibearchitect.claudeApiKey` | string | - | Anthropic Claude API key |
| `vibearchitect.useCopilotForClaude` | boolean | false | Use Copilot subscription for Claude |

### Browser Automation Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `vibearchitect.browserRecordingsPath` | string | - | Custom path for video recordings |
| `vibearchitect.browserSelfHealingRetries` | number | 3 | Max self-healing attempts |

### Mission Folder Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `vibearchitect.missionFolderRetentionDays` | number | 7 | Days to keep old mission folders |
| `vibearchitect.maxMissionFolders` | number | 50 | Maximum folders before cleanup |
| `vibearchitect.enableMissionFolderSymlink` | boolean | true | Create 'current' symlink to active mission |

### Corporate Guidelines Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `vibearchitect.corporateGuidelines.security` | boolean | true | Enable OWASP-inspired security rules |
| `vibearchitect.corporateGuidelines.performance` | boolean | true | Enable performance best practices |
| `vibearchitect.corporateGuidelines.maintainability` | boolean | false | Enable SOLID principles |
| `vibearchitect.corporateGuidelines.testing` | boolean | false | Enable testing best practices |

---

## Dependencies

### Extension (Backend)
| Package | Purpose |
|---------|---------|
| `@google/generative-ai` | Gemini API client |
| `@anthropic-ai/sdk` | Claude API client |
| `simple-git` | Git operations for ShadowRepository |
| `fs-extra` | Enhanced file operations |
| `playwright-core` | Browser automation (optional) |
| `pixelmatch` | Image comparison (optional) |
| `pngjs` | PNG processing (optional) |

### Webview (Frontend)
| Package | Purpose |
|---------|---------|
| `react` | UI framework |
| `react-markdown` | Markdown rendering |
| `esbuild` | Fast bundling |

---

*Last updated: January 2025*
