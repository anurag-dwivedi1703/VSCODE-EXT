## Tech Stack
- **Runtime**: Node.js (v20.x compatible), Electron (VS Code host)
- **Language**: TypeScript v5.3.3
- **Extension Framework**: VS Code Extension API (^1.85.0)
- **Frontend (Webview)**: 
  - React (inferred)
  - Vite (Build tool for webview)
- **Bundler (Extension)**: Webpack v5.89.0
- **AI/LLM SDKs**:
  - Google GenAI SDK (`@google/genai` ^1.34.0, `@google/generative-ai` ^0.24.1)
  - Anthropic SDK (`@anthropic-ai/sdk` ^0.39.0)
- **Browser Automation**: Playwright Core (^1.40.0)
- **Utilities**:
  - `simple-git` (^3.22.0) for Git operations
  - `fs-extra` (^11.2.0) for file system
  - `pixelmatch` & `pngjs` for visual comparison
- **Testing**: Mocha (^10.2.0), @vscode/test-electron

## Architecture Patterns
- **Hybrid Extension Architecture**: Split between **Extension Host** (Backend logic) and **Webview** (React-based Frontend).
- **Service-Oriented Design**: Core logic encapsulated in specific services (`BrowserAutomationService`, `ShadowRepository`, `VisualComparisonService`) managed by a central `TaskRunner`.
- **Provider Pattern**: `MissionControlProvider` acts as the bridge/controller between the VS Code Extension Host and the Webview UI, using message passing.
- **Isolation Pattern**: Uses **Git Worktrees** and a **Shadow Repository** (`temp_verification/shadow_git`) to isolate agent modifications from the user's actual working directory until approved.
- **Adapter Pattern**: AI Clients (`GeminiClient`, `ClaudeClient`) abstract specific LLM APIs into a common interface.

## Coding Standards
- **Language**: TypeScript is mandatory (`.ts` files).
- **Type Safety**: Strict mode enabled (`"strict": true` in `tsconfig.json`).
- **Target**: ES2022 (`"target": "ES2022"`).
- **Linting**: ESLint used with `@typescript-eslint`.
- **Module Resolution**: Node16 (`"moduleResolution": "Node16"`).
- **Async/Await**: Heavy usage expected for file I/O and AI calls.
- **External Dependencies**: Native modules (`pixelmatch`, `pngjs`, `playwright-core`) must be listed in `externals` in `webpack.config.js` to avoid bundling issues.

## Testing Strategy
- **Framework**: Mocha for unit and integration tests.
- **Runner**: `@vscode/test-electron` to run tests within the VS Code environment.
- **Location**: Tests located in `src/test/` (compiled to `out/test/`).
- **Linting**: `npm run lint` enforces code quality before testing.
- **Browser Testing**: Self-healing UI tests utilize Playwright with visual regression testing (`pixelmatch`).

## Critical Invariants
- **Webview Build Separation**: The Webview UI (`webview-ui/`) is a separate project with its own `package.json` and build process (`vite`). It must be built (`npm run build:all`) before packaging the extension.
- **Webpack Externals**: `vscode`, `playwright-core`, `pixelmatch`, and `pngjs` MUST remain in the `externals` section of `webpack.config.js`.
- **VS Code Engine Compatibility**: Code must remain compatible with VS Code engine `^1.85.0`.
- **Configuration Persistence**: User settings (API keys) are accessed via `vscode.workspace.getConfiguration` and never hardcoded.

## Agent Constraints
- **Secret Management**: NEVER hardcode API keys. Always use `vscode.workspace.getConfiguration('vibearchitect')` to retrieve secrets.
- **File System Access**: When performing agent tasks, prefer using the `ShadowRepository` or `WorktreeManager` mechanisms to avoid destructive changes to the user's primary workspace.
- **Webview Modifications**: Do not modify `webview-ui/dist` directly. Modify `webview-ui/src` and run the build script.
- **Dependency Management**: When adding dependencies, determine if they belong to the Extension (root `package.json`) or the Webview (`webview-ui/package.json`).