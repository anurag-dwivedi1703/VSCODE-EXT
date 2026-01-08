# Mission Summary

## Project Explanation: Vibe Architect

### Overview
**Vibe Architect** is a VS Code Extension designed to be an **AI Agent Manager**. It aims to replicate the "Google Antigravity" concept, shifting the developer experience from manual coding to orchestrating autonomous agents via a "Mission Control" dashboard.

### Key Components
1.  **Mission Control (Frontend)**:
    -   Located in `webview-ui/`.
    -   Built with **React**, **Vite**, and **VS Code Webview UI Toolkit**.
    -   Acts as the dashboard for spawning and monitoring agents.

2.  **Extension Host (Backend)**:
    -   Located in `src/`.
    -   **MissionControlProvider**: Bridges the UI and the backend.
    -   **BrowserAutomationService**: Uses **Playwright** for agents to interact with web apps.
    -   **ShadowRepository**: Uses **Git Worktrees** (`simple-git`) to isolate agent changes from the user's live code.
    -   **VisualComparisonService**: Uses `pixelmatch` for UI verification.

3.  **AI Integration**:
    -   Supports **Google Gemini 3 Pro** and **Anthropic Claude**.
    -   Designed for "Planning" (deep reasoning) vs "Fast" (quick fix) modes.

### Verification Status
-   **Analysis**: Complete. The codebase structure matches the provided "Constitution" and "Project Overview".
-   **Build**: Not attempted (Task was explanation only).
-   **Tests**: Not run (Task was explanation only).

### Instructions
To start working on this project:
1.  Run `npm run setup` to install dependencies for both root and webview.
2.  Run `npm run compile` to build the extension.
3.  Press `F5` in VS Code to launch the Extension Development Host.
