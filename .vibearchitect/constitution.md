# Workspace Constitution v2.0

## 1. Project Identity
- **Name**: vibearchitect
- **Type**: extension
- **Primary Language**: typescript
- **Framework**: React (Webview UI)
- **Description**: Manage autonomous AI agents that complete coding missions end-to-end. Assign tasks, agents execute autonomously, you review results.

## 2. Critical Dependencies (DO NOT MODIFY WITHOUT REVIEW)
| Package | Version | Reason | Risk Level |
|---------|---------|--------|------------|
| @anthropic-ai/sdk | ^0.39.0 | Primary Claude client used for agent LLM access; core to mission execution when Claude is selected. | CRITICAL |
| @google/genai | ^1.34.0 | Gemini/Google GenAI client used for alternative LLMs — used by several AI clients. | CRITICAL |
| playwright-core | ^1.40.0 | Browser automation engine used by BrowserAutomationService for end-to-end tests and recordings. | CRITICAL |
| pixelmatch | ^5.3.0 | Image diffing library used by VisualComparisonService to validate visual regressions. | HIGH |
| pngjs | ^7.0.0 | PNG read/write used by screenshot comparison and recording pipelines. | HIGH |
| fs-extra | ^11.2.0 | File utilities used across ShadowRepository, MissionFolderManager, and persistence logic. | MEDIUM |
| simple-git | ^3.22.0 | Lightweight git operations used by ShadowRepository and revert/commit tools. | MEDIUM |

Reasoning: these packages implement core runtime capabilities (LLM access, browser automation, visual diffing, file operations). Upgrading or removing them without coordinated testing and reviews risks breaking mission execution, recordings, and recovery workflows.

## 3. Architecture Rules
- **Pattern**: Layered (Extension Host backend) + Webview (React) UI with clear message-passing boundary
- **Entry Point**: src/extension.ts

### Module Boundaries
- **ai**: LLM clients, prompt engine, and security instruction generators — encapsulates all external LLM API usage and prompt shaping.
  - Reason: Centralizes model-related changes and credentials handling.
- **engine**: Orchestration (TaskRunner), refinement pipeline, constitution/schema, and spec management.
  - Reason: Core business logic; must be deterministic and testable.
- **panels**: MissionControlProvider — hosts webview and mediates UI <-> backend messages.
  - Reason: Single point for message validation and persistence.
- **services**: Side-effectful services (BrowserAutomationService, VisualComparisonService, ShadowRepository, RevertManager, FileLockManager, DependencyAnalyzer, etc.)
  - Reason: Isolate external integrations and filesystem/git interactions.
- **utils**: Pure helpers (file discovery, diff applier, token managers).
  - Reason: Reusable, side-effect-minimal utilities.
- **webview-ui**: React frontend bundle — must not be imported by backend code.
  - Reason: Bundled and served as static content; keeps backend tree-shakable and testable.

### Import Rules
- Backend (anything under src/) MUST NOT import from webview-ui. Communication with the UI MUST occur only via MissionControlProvider postMessage APIs.
  - Reason: Prevents runtime bundling/import issues and enforces separation of concerns.
- services/* MUST be the only code allowed to perform filesystem or git operations; engine/* and ai/* MUST call services APIs (ShadowRepository, MissionFolderManager, FileLockManager) instead of direct fs/git calls.
  - Reason: Centralizes side effects for easier testing and recovery.
- ai/* clients MUST NOT access VS Code APIs or UI; they may only be used by engine TaskRunner or services.
  - Reason: Keeps LLM logic pure and portable.
- engine/* (TaskRunner, PhaseExecutor, RefinementManager) are the orchestrators and MUST NOT manipulate UI directly — use MissionControlProvider messaging.
  - Reason: Ensures consistent lifecycle and auditability of tasks.
- No circular imports between top-level modules (ai, engine, services, panels, utils). Violations must be fixed by introducing explicit interfaces in utils or engine.
  - Reason: Maintainable dependency graph and predictable builds.

## 4. Coding Standards
List each standard with enforcement level:
- 🔴 **TypeScript strict mode**: strict=true; noImplicitReturns=true; noFallthroughCasesInSwitch=true (STRICT - must follow)  
  - Reason: Prevent runtime type bugs; matches tsconfig.json.
- 🔴 **No hardcoded secrets**: Never commit API keys, tokens, or secrets in repo (STRICT - must follow)  
  - Reason: Security and compliance; package.json and settings indicate API keys are user-configured.
- 🟡 **Prefer explicit types over `any` for public APIs**: Use `unknown` for parsed external data and cast explicitly after validation (WARNING - should follow)  
  - Reason: Improves correctness and documents intent. Note: ESLint currently allows `any`, but project-wide code should avoid it.
- 🔴 **Async/await for async flows; avoid long-running synchronous I/O on main thread** (STRICT - must follow)  
  - Reason: Extension host responsiveness and predictable task lifecycle.
- 🟡 **Use services for side effects**: Any code modifying the workspace filesystem must go through ShadowRepository / MissionFolderManager (WARNING - should follow)  
  - Reason: Enables revert, audit, and conflict management.
- 🟢 **Document exported module behavior with JSDoc/TSDoc** (SUGGESTION)  
  - Reason: Improves discoverability for agents and maintainers.
- 🟡 **Follow ESLint/TS rules in .eslintrc.json; reduce `no-explicit-any` use over time** (WARNING - should follow)  
  - Reason: Maintain consistency; existing config relaxes some rules but code should trend stricter.
- 🟢 **Small, focused modules and single responsibility** (SUGGESTION)  
  - Reason: Easier testing and reasoning by agents.

## 5. Forbidden Patterns
- ❌ **Hardcoding API keys or secrets in source files or committed config**
  - Reason: Security leakage and credential theft risk.
  - Instead: Use VS Code settings (vibearchitect.*) or environment variables and document in README.
- ❌ **Direct modifications of workspace files outside ShadowRepository/WorktreeManager**
  - Reason: Bypasses revert, diff, and audit capabilities; breaks mission recovery.
  - Instead: Use ShadowRepository APIs, then apply via IDEDiffApplier with user review checkpoints.
- ❌ **Webview UI direct imports from backend code**
  - Reason: Bundling mismatch and runtime errors; violates separation.
  - Instead: Communicate over MissionControlProvider messages.
- ❌ **Running arbitrary shell commands from agents or TaskRunner without explicit opt-in/approval**
  - Reason: Security and sandboxing — prevents exfiltration or destructive operations.
  - Instead: Use predefined Service tools (TerminalManager) with explicit authorization and logging.
- ❌ **Committing large binaries (>5MB) into repo (recordings, browser profiles)**
  - Reason: Repository bloat and packaging failures.
  - Instead: Store recordings under workspace/.vibearchitect/recordings or external storage; add .gitignore entries.

## 6. Testing Requirements
- **Framework**: mocha
  - Reason: devDependencies include mocha and @types/mocha; test files exist under src/test.
- **Test Pattern**: src/test/**/*.test.ts and src/test/suite/**/*.test.ts
  - Reason: Matches current test layout.
- **Coverage Minimum**: Not enforced by CI (N/A) — target 80% for critical modules (engine, services, ai)
  - Reason: No coverage tool configured; aim set as maintainability goal.
- **Required Test Types**: unit (required), integration (required for engine <-> services), e2e (optional for browser automation using Playwright)
  - Reason: Agents perform file and browser operations; integration tests validate real interactions. Playwright-based tests must run in isolated CI or developer environment.

## 7. Agent Constraints (ENFORCED)

### MUST
- ✅ Always respect the Constitution and use documented services (ShadowRepository, FileLockManager, MissionFolderManager) for file operations.  
  - Reason: Ensures recoverability and audit trails.
- ✅ Validate and sanitize any external model output before using as code or shell commands (use parsing + token/size checks).  
  - Reason: Prevents injection and runaway actions.
- ✅ Persist mission artifacts under workspace/.vibearchitect or configured missionFolder and include metadata (taskId, model, timestamp).  
  - Reason: Predictable storage and cleanup.
- ✅ Run unit tests for changed modules locally (or CI) before creating a commit/PR that modifies engine, services, or ai modules.  
  - Reason: Prevent regressions in core logic.

### MUST NOT
- ❌ Modify package.json dependencies, webpack externals, or tsconfig.json without human review and test run.  
  - Reason: Dependency changes affect packaging and runtime; must be reviewed.
- ❌ Exfiltrate or log sensitive data (API keys, tokens, private user files) to external endpoints.  
  - Reason: Compliance and security.
- ❌ Import webview-ui from backend or call DOM APIs from extension host.  
  - Reason: Architectural boundary violation.
- ❌ Execute unchecked shell scripts or network installs during autonomous runs without explicit opt-in.  
  - Reason: Security and deterministic behavior.

### SHOULD
- 💡 Use ShadowRepository and commit/rollback semantics for incremental edits; create checkpoints for each phase.  
  - Reason: Enables safe iteration and human review.
- 💡 Prefer self-healing retries for Playwright flows; follow configured vibearchitect.browserSelfHealingRetries.  
  - Reason: Improves robustness of browser tests.
- 💡 Emit structured logs (taskId, phase, timestamp, tool, outcome) and surface them to Mission Control for traceability.  
  - Reason: Troubleshooting and auditability.

## 8. Custom Rules (User-Defined)
Add custom rules here using the format:
```text
- MUST: Use 'unknown' (not 'any') for raw LLM responses; validate and map to typed interfaces before use.
- MUST NOT: Commit API keys or credentials; settings must be used (vibearchitect.*) and documented.
- SHOULD: Always create a MissionFolder via MissionFolderManager for any mission run; do not write directly to workspace root.
```

---
*This constitution is the source of truth for AI agents working in this workspace.*