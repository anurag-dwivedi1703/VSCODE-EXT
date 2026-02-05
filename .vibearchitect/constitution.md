# Workspace Constitution

Generated automatically for: VSCODE-EXT

This constitution defines the rules and patterns for this workspace.

## Project Metadata

### package.json

```json
{
    "name": "vibearchitect",
    "displayName": "VibeArchitect Agent Manager",
    "description": "Manage autonomous AI agents that complete coding missions end-to-end. Assign tasks, agents execute autonomously, you review results. Features Mission Control dashboard, multi-model support (Claude, GPT-5, Gemini), and automated browser testing.",
    "version": "0.0.1",
    "engines": {
        "vscode": "^1.85.0"
    },
    "categories": [
        "Machine Learning",
        "Programming Languages",
        "Other"
    ],
    "keywords": [
        "ai agents",
        "autonomous",
        "agent manager",
        "claude",
        "gpt",
        "automation",
        "mission control"
    ],
    "activationEvents": [
        "onCommand:vibearchitect.openMissionControl"
    ],
    "main": "./dist/extension.js",
    "contributes": {
        "commands": [
            {
                "command": "vibearchitect.openMissionControl",
                "title": "VibeArchitect: Open Mission Control"
            },
            {
                "command": "vibearchitect.installBrowserDependencies",
                "title": "VibeArchitect: Install Browser Automation Dependencies"
            },
            {
                "command": "vibearchitect.checkBrowserDependencies",
                "title": "VibeArchitect: Check Browser Dependencies Status"
            }
        ],
        "configuration": {
            "title": "VibeArchitect",
            "properties": {
                "vibearchitect.geminiApiKey": { "type": "string" },
                "vibearchitect.claudeApiKey": { "type": "string" },
                "vibearchitect.useCopilotForClaude": { "type": "boolean", "default": false },
                "vibearchitect.browserRecordingsPath": { "type": "string" },
                "vibearchitect.browserSelfHealingRetries": { "type": "number", "default": 3 },
                "vibearchitect.missionFolderRetentionDays": { "type": "number", "default": 7 },
                "vibearchitect.maxMissionFolders": { "type": "number", "default": 50 },
                "vibearchitect.enableMissionFolderSymlink": { "type": "boolean", "default": true },
                "vibearchitect.corporateGuidelines.security": { "type": "boolean", "default": true },
                "vibearchitect.corporateGuidelines.performance": { "type": "boolean", "default": true },
                "vibearchitect.corporateGuidelines.maintainability": { "type": "boolean", "default": false },
                "vibearchitect.corporateGuidelines.testing": { "type": "boolean", "default": false }
            }
        }
    },
    "devDependencies": {
        "@types/fs-extra": "^11.0.4",
        "@types/glob": "^8.1.0",
        "@types/mocha": "^10.0.6",
        "@types/node": "20.x",
        "@types/pixelmatch": "^5.2.6",
        "@types/pngjs": "^6.0.5",
        "@types/vscode": "^1.85.0",
        "@typescript-eslint/eslint-plugin": "^6.15.0",
        "@typescript-eslint/parser": "^6.15.0",
        "@vscode/test-electron": "^2.3.8",
        "@vscode/vsce": "^3.7.1",
        "eslint": "^8.56.0",
        "glob": "^8.1.0",
        "mocha": "^10.2.0",
        "ts-loader": "^9.5.1",
        "typescript": "^5.3.3",
        "webpack": "^5.89.0",
        "webpack-cli": "^5.1.4"
    },
    "dependencies": {
        "@anthropic-ai/sdk": "^0.39.0",
        "@google/genai": "^1.34.0",
        "@google/generative-ai": "^0.24.1",
        "fs-extra": "^11.2.0",
        "pixelmatch": "^5.3.0",
        "playwright-core": "^1.40.0",
        "pngjs": "^7.0.0",
        "simple-git": "^3.22.0"
    }
}
```

### tsconfig.json

```json
{
    "compilerOptions": {
        "module": "Node16",
        "target": "ES2022",
        "outDir": "out",
        "lib": ["ES2022"],
        "sourceMap": true,
        "rootDir": "src",
        "strict": true,
        "noImplicitReturns": true,
        "noFallthroughCasesInSwitch": true,
        "moduleResolution": "Node16",
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true
    },
    "exclude": ["node_modules", ".vscode-test", "webview-ui", "_local_work"]
}
```

### .eslintrc.json

```json
{
    "root": true,
    "parser": "@typescript-eslint/parser",
    "parserOptions": {
        "ecmaVersion": 2020,
        "sourceType": "module"
    },
    "plugins": ["@typescript-eslint"],
    "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
    "rules": {
        "@typescript-eslint/naming-convention": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
        "semi": "off",
        "curly": "warn",
        "eqeqeq": "warn",
        "no-throw-literal": "warn"
    },
    "ignorePatterns": ["out", "dist", "**/*.d.ts", "node_modules", "webview-ui"]
}
```

## Project Structure

```
├── src/
│   ├── ai/
│   │   ├── ClaudeClient.ts
│   │   ├── CopilotClaudeClient.ts
│   │   ├── CopilotGPTClient.ts
│   │   ├── GeminiClient.ts
│   │   ├── PromptEngine.ts
│   │   └── SecurityInstructions.ts
│   ├── engine/
│   │   ├── refinement/
│   │   │   ├── ContextSkeletonizer.ts
│   │   │   ├── index.ts
│   │   │   ├── RefinementManager.ts
│   │   │   ├── RefinementPrompts.ts
│   │   │   ├── RefinementSession.ts
│   │   │   ├── RefinementTokenManager.ts
│   │   │   ├── RefinementTypes.ts
│   │   │   └── SmartContextBuilder.ts
│   │   ├── AgentTools.ts
│   │   ├── ConstitutionSchema.ts
│   │   ├── CorporateGuidelines.ts
│   │   ├── SpecManager.ts
│   │   ├── TaskRunner.ts
│   │   ├── TerminalManager.ts
│   │   └── WorktreeManager.ts
│   ├── panels/
│   │   └── MissionControlProvider.ts
│   ├── services/
│   │   ├── AttachmentProcessor.ts
│   │   ├── AuthSessionManager.ts
│   │   ├── BrowserAutomationService.ts
│   │   ├── BrowserDependencyInstaller.ts
│   │   ├── BrowserManager.ts
│   │   ├── ComplexityAnalyzer.ts
│   │   ├── ContextHarvester.ts
│   │   ├── ContextMonitor.ts
│   │   ├── DependencyAnalyzer.ts
│   │   ├── FileLockManager.ts
│   │   ├── LintRuleExtractor.ts
│   │   ├── NetworkInterceptor.ts
│   │   ├── PageLoadValidator.ts
│   │   ├── PhaseExecutor.ts
│   │   ├── PhaseGenerator.ts
│   │   ├── PhaseStateManager.ts
│   │   ├── RevertManager.ts
│   │   ├── RiskDetector.ts
│   │   ├── RuleEnforcer.ts
│   │   ├── SessionStorageManager.ts
│   │   ├── ShadowRepository.ts
│   │   ├── TaskRunnerPhaseIntegration.ts
│   │   └── VisualComparisonService.ts
│   ├── test/
│   │   ├── suite/
│   │   │   ├── ComplexityAnalyzer.test.ts
│   │   │   ├── ContextMonitor.test.ts
│   │   │   ├── index.ts
│   │   │   ├── PhaseExecutor.test.ts
│   │   │   ├── PhaseGenerator.test.ts
│   │   │   ├── PhaseStateManager.test.ts
│   │   │   └── taskRunner.test.ts
│   │   ├── runTest.ts
│   │   └── simple.test.ts
│   ├── utils/
│   │   ├── DiffAggregator.ts
│   │   ├── DiffLogger.ts
│   │   ├── DiffMatcher.ts
│   │   ├── DiffPreview.ts
│   │   ├── DiffRecovery.ts
│   │   ├── FileDiscovery.ts
│   │   ├── FileSearch.ts
│   │   ├── IDEDiffApplier.ts
│   │   ├── MissionFolderManager.ts
│   │   ├── SearchReplaceParser.ts
│   │   ├── SymbolNavigator.ts
│   │   ├── TokenBudget.ts
│   │   └── TokenManager.ts
│   └── extension.ts
├── webview-ui/
│   ├── src/
│   │   ├── components/
│   │   │   ├── BrowserPreview.tsx
│   │   │   ├── BrowserSetupWizard.css
│   │   │   ├── BrowserSetupWizard.tsx
│   │   │   ├── ConstitutionReviewModal.tsx
│   │   │   ├── ContextBudgetIndicator.css
│   │   │   ├── ContextBudgetIndicator.tsx
│   │   │   ├── DiffRecoveryModal.css
│   │   │   ├── DiffRecoveryModal.tsx
│   │   │   ├── DiffViewer.tsx
│   │   │   ├── PhaseApprovalModal.css
│   │   │   ├── PhaseApprovalModal.tsx
│   │   │   ├── PhaseProgress.css
│   │   │   ├── PhaseProgress.tsx
│   │   │   ├── RefinementQuestionnaire.css
│   │   │   ├── RefinementQuestionnaire.tsx
│   │   │   ├── ResizableLayout.tsx
│   │   │   ├── SessionManagerUI.css
│   │   │   ├── SessionManagerUI.tsx
│   │   │   ├── TypewriterText.css
│   │   │   └── TypewriterText.tsx
│   │   ├── utilities/
│   │   │   └── vscode.ts
│   │   ├── App.css
│   │   ├── App.tsx
│   │   ├── index.css
│   │   └── main.tsx
│   ├── build.js
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── .eslintrc.json
├── ARCHITECTURE.md
├── package.json
├── README.md
├── tsconfig.json
└── webpack.config.js
```

## Detected Technologies

- **Node.js/NPM** project detected
- **TypeScript** enabled (strict mode)
- **Webpack** bundler for extension
- **Vite** bundler for webview-ui
- **ESLint** configured with TypeScript parser
- **Mocha** test framework
- **Playwright** for browser automation
- **React** for webview UI

## Architecture Patterns

### AI Clients
Multiple AI provider integrations:
- `ClaudeClient.ts` - Direct Anthropic API
- `CopilotClaudeClient.ts` - Claude via VS Code Copilot
- `CopilotGPTClient.ts` - GPT via VS Code Copilot
- `GeminiClient.ts` - Google Gemini API

### Engine Layer
Core execution logic:
- `TaskRunner.ts` - Main orchestration engine
- `AgentTools.ts` - Tool definitions for AI agents
- `TerminalManager.ts` - Terminal command execution
- `WorktreeManager.ts` - Git worktree isolation
- `refinement/` - PRD generation and refinement workflow

### Services Layer
Supporting services:
- `BrowserAutomationService.ts` - Playwright browser control
- `BrowserDependencyInstaller.ts` - Browser setup automation
- `ShadowRepository.ts` - Checkpoint/revert system
- `PhaseGenerator.ts` / `PhaseExecutor.ts` / `PhaseStateManager.ts` - Phased execution
- `ComplexityAnalyzer.ts` - Task complexity assessment
- `ContextHarvester.ts` - Codebase context extraction
- `RiskDetector.ts` - High-risk command detection

### Utils Layer
Utility modules:
- `SearchReplaceParser.ts` - Diff parsing
- `DiffLogger.ts` / `DiffMatcher.ts` / `DiffRecovery.ts` - Diff handling
- `TokenManager.ts` / `TokenBudget.ts` - Token management
- `MissionFolderManager.ts` - Mission folder lifecycle

## Configuration Options

### Corporate Guidelines (configurable)
- `security` - OWASP-inspired security rules (default: true)
- `performance` - Performance best practices (default: true)
- `maintainability` - SOLID principles (default: false)
- `testing` - Testing best practices (default: false)

### Mission Management
- `missionFolderRetentionDays` - Cleanup threshold (default: 7)
- `maxMissionFolders` - Max folders before cleanup (default: 50)
- `enableMissionFolderSymlink` - Create 'current' symlink (default: true)

*Constitution auto-generated from workspace scan*