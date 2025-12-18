The landscape of software development is undergoing a fundamental metamorphosis, shifting from a model of manual syntax entry to one of high-level architectural orchestration. This evolution is most prominently represented by the launch of Google Antigravity in late 2025, an integrated development environment (IDE) built specifically for an agent-first development paradigm. Antigravity introduces a bifurcated workflow that separates the traditional code editor from a sophisticated "Manager View"—a mission control center designed to spawn, monitor, and verify multiple autonomous agents operating asynchronously across diverse workspaces. For developers seeking to replicate this functionality within the Visual Studio Code (VS Code) ecosystem, the objective is to engineer an extension that transcends the current chatbot-centric limitations and provides a robust framework for multi-agent task delegation and verification.   

The Architectural Foundation of Agent-First Development
At its core, the Antigravity environment is built upon the premise that artificial intelligence is no longer a peripheral autocomplete tool but a primary actor in the development lifecycle. The system is built as a specialized fork of Visual Studio Code, potentially via the Windsurf intermediary, indicating that the underlying mechanisms for file manipulation, terminal access, and extension support remain compatible with the VS Code API. However, Antigravity radically alters the user experience by prioritizing the Agent Manager over the text editor.   

The primary innovation is the "Mission Control" dashboard, which facilitates a non-linear, asynchronous workflow. In a traditional IDE, AI interactions are typically synchronous and blocking; the developer asks a question and must wait for the response before proceeding. Antigravity resolves this "synchronicity tax" by allowing the developer to dispatch multiple agents—perhaps five different agents for five different bugs—simultaneously. This architectural shift necessitates a robust state management system that can track parallel execution threads and provide high-level visibility over their progress through structured artifacts.   

Core Component	Functional Role in Antigravity	Replicated Implementation Strategy in VS Code
Manager View	
Central dashboard for spawning and monitoring parallel agent threads.

Custom Webview View Container in the Activity Bar with a React/Vue dashboard.

Workspace Selector	
Interface for targeting specific folders or projects for agent missions.

Integration with vscode.workspace.workspaceFolders and URI selection dialogs.

Artifact System	
Structured outputs (plans, diffs, recordings) used for verification.

Custom Markdown rendering, vscode.diff command, and embedded media players.

Autonomy Controls	
User-defined levels of agent permission (Off, Auto, Turbo).

Extension settings and per-mission configuration toggles in the Manager UI.

Background Agents	
Autonomous processes running independently of the active editor.

Process spawning via vscode.terminal or background workers with worktree isolation.

  
Designing the Manager View: Orchestrating Parallel Missions
The implementation of a "Manager View" within a VS Code extension requires a departure from standard tree-view based sidebars. The complexity of orchestrating multiple agents, each with its own task list, implementation plan, and real-time status, demands the use of the Webview API. This allows the developer to create a fully customizable user interface using modern web technologies while maintaining integration with the VS Code host.   

Workspace Selection and Mission Initialization
A critical requirement for the proposed extension is the ability to select a specific workspace and spin up agents for targeted tasks. In the Antigravity model, a workspace corresponds to a local folder where agents perform their work. To mimic this, the VS Code extension must provide a "New Mission" interface that allows the user to:   

Select a Root Directory: Use the vscode.window.showOpenDialog or a dropdown of currently open workspaceFolders to define the agent's operational boundary.   

Define the Objective: Enter a high-level prompt, such as "Refactor the authentication module" or "Create a unit test suite for the billing API".   

Choose a Model and Mode: Select from available reasoning engines like Gemini 3 Pro and choose between "Fast" and "Planning" modes.   

The distinction between "Fast" and "Planning" modes is vital for operational efficiency. Fast mode is intended for simple, localized tasks like variable renaming or executing basic terminal commands. In contrast, Planning mode is optimized for deep research and complex architectural changes, forcing the agent to organize its work into task groups and produce artifacts for user approval before modifying any source code.   

The Lifecycle of an Agent Mission
When a mission is initiated, the extension spawns a dedicated agent instance. In a multi-agent environment, the extension must manage the lifecycle of these instances to ensure they do not consume excessive system resources or interfere with one another. This is achieved through an asynchronous orchestration layer that monitors the status of each agent—displayed in the Manager View as a visualization of parallel workstreams.   

The execution process follows a structured hierarchy reflective of real-world engineering workflows. The agent first analyzes the prompt and the project structure, often leveraging tools like the File Search store for semantic context. It then generates an Implementation Plan, an artifact that outlines the intended steps, such as "Audit directory," "Generate test cases," and "Apply patches". The developer reviews this plan in the Manager View, offering feedback directly on the artifact, which the agent incorporates without stopping its execution flow.   

Enhancing Trust through the Artifact Transparency System
A fundamental challenge in autonomous coding is the erosion of developer trust when an AI system acts as a "black box". Antigravity addresses this by moving away from raw tool call logs—which are tedious to verify—and toward "Artifacts," which are tangible deliverables at a natural task-level abstraction.   

Types of Verifiable Artifacts
To mimic Antigravity, the VS Code extension must support the rendering and interaction of various artifact types within its Manager View.   

Task Lists and Implementation Plans: Rich Markdown files that structure the agent's objectives and sequence.   

Code Diffs: Standardized visual representations of proposed changes, allowing for granular approval of agent edits.   

Screenshots and Walkthroughs: Visual captures of the application state, particularly useful for UI-centric tasks where the agent iterates on front-end components.   

Browser Recordings: Videos of the agent interacting with the built-in Chrome browser to verify functional requirements, such as a successful login flow or dashboard navigation.   

Test Results: Structured logs and summaries from test suites (e.g., Pytest or Jest) generated and executed by the agent to validate behavior.   

Feedback and Iteration Mechanism
The artifact system is not merely for observation; it is an interface for collaboration. Users can leave "Google-doc-style" comments on text artifacts or select-and-comment on screenshots. This feedback is automatically incorporated into the agent's context, allowing it to course-correct in real-time. In the VS Code extension, this can be implemented by capturing webview events and passing the commentary back to the Language Model API as part of the ongoing mission history, ensuring that the agent’s reasoning reflects human oversight.   

Agent Reasoning and the Gemini 3 Foundation
The intelligence behind the Antigravity manager is primarily driven by Gemini 3 Pro, Google's state-of-the-art reasoning model launched in late 2025. Replicating this experience requires leveraging the specific capabilities of Gemini 3, notably its thinking levels and stateful tool use mechanisms.   

Thinking Levels for Granular Control
Gemini 3 introduces the concept of a "thinking budget" via the thinking_level parameter. This allows the extension to balance reasoning depth against latency and cost for different types of missions.   

Thinking Budget=f(Task Complexity,Latency Requirement)
Thinking Level	Description	Use Case in the Manager
Low	
Minimizes latency and cost; best for simple instructions and high-throughput chat.

Used for "Fast" mode tasks like renaming symbols or documentation formatting.

High (Default)	
Maximizes reasoning depth; model takes more time but vetted output is higher quality.

Used for "Planning" mode missions, architectural refactors, and complex debugging.

  
In the VS Code extension, the thinkingLevel should be configurable per agent mission, allowing the user to decide when they need a "deep dive" versus a "quick fix".   

Stateful Tool Use through Thought Signatures
A persistent issue in multi-step agentic workflows is "reasoning drift," where the model loses its train of thought across several turns of tool use. Gemini 3 solves this by generating "Thought Signatures"—encrypted representations of its internal reasoning.   

To maintain context across an asynchronous mission, the extension must capture the thoughtSignature from every model response (particularly during function calling) and return it exactly as received in the next request. For Gemini 3 Pro, this is a strict requirement; missing signatures in a turn involving tool calls result in a 400 error. This ensures that when an agent in the background waits for a developer's approval on a plan, it resumes execution with the exact reasoning context it had when the plan was generated.   

Tooling and Grounding: The Model Context Protocol (MCP)
For an agent to act autonomously within a workspace, it must be equipped with tools that allow it to interact with the file system, databases, and the web. Antigravity utilizes the Model Context Protocol (MCP) as a universal interface for these integrations.   

Connecting Agents to Enterprise and Local Data
The integration of MCP servers into the Antigravity environment acts as a "USB-C port for AI," allowing agents to plug into data sources in a standardized way. For a data-heavy application, an agent can use an MCP server for BigQuery or AlloyDB to act as a data analyst, querying schemas and verifying metric consistency without manual configuration by the user.   

In the VS Code extension, developers can implement contributes.mcpServerDefinitionProviders to register local or remote MCP servers.   

Filesystem MCP Server: Grants the agent secure access to read and write files within the project directory.   

Terminal MCP Server: Enables the agent to execute shell commands, run build scripts, and monitor outputs.   

Browser MCP Server: Provides the agent with the ability to "actuate" a Chrome window for UI testing and research.   

Grounding via File Search Stores
Effective agent orchestration requires the system to understand the specific context of the codebase. Antigravity accomplishes this through a managed Retrieval-Augmented Generation (RAG) system known as the File Search Store. When a user opens a workspace, the extension should automatically index the project’s files—including PDFs, Markdown, and various programming languages—into a File Search Store.   

This store acts as a persistent container for embeddings that the agent can query during a mission. By including a FileSearchRetrievalResource in the generateContent call, the model can perform semantic searches across the entire repository to find relevant implementation patterns or documentation, significantly reducing hallucinations and improving the accuracy of generated artifacts.   

Managing Workspace Isolation and Background Execution
One of the most complex requirements of mimicking Antigravity is the implementation of background agents that operate independently of the user's active editor window. These agents must be able to modify files, run tests, and even commit changes without disrupting the developer's current work.   

Isolation through Git Worktrees
To prevent file conflicts when running multiple background missions simultaneously, the extension can employ Git worktrees for isolation. When a background agent mission is started, VS Code can automatically create a new Git worktree in a separate folder. All changes made by the agent—such as implementing a plan or fixing a bug—are applied to this worktree, isolating them from the main workspace where the developer is actively working.   

After the agent completes its mission, the Manager View provides a summary of all outstanding changes in the worktree. The developer can then:   

Explore Edits: Use a diff view to review changes made by the agent.   

Keep/Undo: Selectively keep or discard specific agentic modifications.   

Apply: Merge the validated changes from the worktree back into the local repository.   

Terminal and Process Management
Background agents often interact with terminal and shell commands to do their work. The extension must manage these persistent sessions, ensuring that processes (like a test runner or a local server) can be monitored from the Manager View. VS Code's support for "process reconnection" and "process revive" is essential here, allowing agent-managed terminals to survive a window reload or a VS Code restart.   

The "Agent HQ" or "Agent Sessions" view in VS Code provides a centralized location to track these sessions, displaying their status (active, completed, failed) and key details like file changes. This unified interface ensures that whether an agent is running locally, in the background, or in the cloud, its progress remains visible and manageable.   

Knowledge Management and the Self-Improving Agent
A key tenet of the Antigravity philosophy is "Self-improvement"—treating learning as a core primitive. Agents in this environment do not just execute tasks; they contribute to a persistent knowledge base that improves future performance.   

Implementation of Knowledge Items
The extension should implement a "Knowledge Items" (KI) system that automatically captures and organizes insights from coding sessions.   

Mechanism: As the user and agent interact, the system analyzes the conversation to extract important patterns, solutions, or architectural decisions.   

Structure: Each KI contains a title, a summary, and a collection of artifacts, such as automatically generated documentation or code examples.   

Retrieval: The summaries of all KIs are available to the agent. When the agent identifies a relevant KI, it "studies" the associated artifacts to inform its response to a new task.   

This persistent memory allows the agent to learn a team's naming conventions, preferred libraries, and past fixes, transforming the agent from a generic assistant into a specialized system expert.   

Multi-Agent Interaction Patterns
When building the orchestration layer for the VS Code extension, developers can draw upon established multi-agent patterns from the Google Agent Development Kit (ADK).   

Pattern	Description	Application in VS Code Extension
Sequential Pipeline	
A "baton-pass" model where Agent A finishes a task and hands it to Agent B.

Ideal for processing raw documents: a Parser Agent creates text, and an Extractor Agent pulls structured data.

Coordinator / Dispatcher	
A central intelligent agent routes requests to specialized sub-agents.

A "Billing Specialist" agent handles invoice issues while a "Tech Support" agent handles debugging.

Parallel Execution	
Multiple agents work on independent sub-tasks simultaneously.

Simultaneously refactoring five different modules or generating tests for five different APIs.

  
By using the SequentialAgent or CoordinatorAgent primitives in the extension's backend logic, the Manager View can efficiently manage complex, multi-step workflows while maintaining clear state through a shared whiteboard (session.state).   

Security and Permission Gating: The "Turbo" Mode Guardrails
Delegating autonomous actions to agents requires a robust security model to ensure they operate within strict operational boundaries. Antigravity includes workspace isolation, permission gating, and task-specific sandboxes to safeguard execution.   

Setting Agent Autonomy Levels
The extension must allow developers to customize the level of autonomy granted to agents during a mission.   

Agent-Assisted (Recommended): The agent identifies the need for an action (e.g., executing a terminal command) and requests user approval.   

Turbo Mode: The agent operates with high autonomy, auto-executing commands except those on a user-defined "Deny List".   

Strict Mode: The agent requires permission for every single tool call and terminal invocation, ensuring complete human control at the cost of speed.   

Protecting the Environment
Security is further enhanced through "Secure Mode" and terminal execution policies. Developers can designate certain commands as "off-limits" (e.g., deleting root directories or accessing sensitive env files). Furthermore, by linking a Google account and using Identity and Access Management (IAM) credentials for MCP server connections, the extension ensures that agents access enterprise tools without exposing raw secrets in the chat or terminal windows.   

Technical Roadmap for Replication
Building a VS Code extension that mimics the Antigravity Agent Manager requires a staged development approach, focusing on UI parity, reasoning depth, and operational safety.

Step 1: Establishing the Activity Bar Hub
The extension must contribute a custom View Container to the VS Code Activity Bar. This acts as the "HQ" and contains two primary views:   

The Mission Tree: A native TreeView showing current workspaces and active missions.   

The Manager Dashboard: A WebviewView that renders the Antigravity-style orchestration interface.   

Step 2: Implementing the Reasoning and Tooling Layer
Integrate the Gemini 3 Pro model via the @google/genai Node.js SDK. This layer must handle:   

Thinking Level Configuration: Mapping "Fast" and "Planning" UI toggles to API parameters.   

Signature Tracking: Implementing a middleware to capture and resend thoughtSignature values in every request turn.   

MCP Integration: Providing a mechanism for the agent to discover and use local tool servers.   

Step 3: Engineering the Artifact and Diffs System
To render the implementation plans and code changes, the extension should leverage VS Code's internal commands.   

Markdown Rendering: Use the markdown-it library or VS Code's built-in Markdown previewer to display plans and task lists.   

Diff Generation: Use vscode.commands.executeCommand('vscode.diff',...) to show side-by-side comparisons of agent-proposed changes.   

Media Integration: Use the Webview API to embed browser recordings and screenshots captured by the agent during verification steps.   

Step 4: Finalizing Background Mission Orchestration
Enable background task execution using Git worktrees for isolation. The extension must provide a "Handoff" mechanism where a local chat session can be promoted to a "Background Mission," allowing the agent to continue its work autonomously while the user moves to another task.   

Technical Specification: Agent Manager Extension for VS Code
This section defines the core modules and functional requirements for the proposed extension.

1. Manager Surface (Webview UI)
Mission Control Dashboard: A central React-based view within a VS Code WebviewView for spawning and monitoring agents.   

Parallel Workstream Visualization: Real-time progress bars and status indicators (Active, Idle, Review Needed) for multiple agents.   

Context Management UI: Controls to select specific workspace folders and link grounding sources (File Search Stores).   

2. Orchestration & Isolation Layer
Async Multi-Agent Runner: Logic to manage parallel mission lifecycles using background processes.   

Git Worktree Isolation: Automated spawning of worktrees for background missions to prevent file system conflicts.   

Handoff Protocol: Mechanism to transfer a synchronous "Editor View" conversation to an asynchronous "Manager View" background mission.   

3. Gemini 3 Reasoning Engine
Thinking Level API: Integration of thinking_level ('low' for fast tasks, 'high' for planning).   

Thought Signature Middleware: Mandatory capture and injection of thoughtSignature tokens to prevent reasoning drift during multi-turn tool use.   

Grounding (RAG) Integration: Managed vector search using Gemini's File Search Store for codebase awareness.   

4. Artifact & Verification System
Verifiable Deliverables: Rendering of Markdown-based implementation plans, side-by-side diffs, and media artifacts (screenshots, browser recordings).   

Async Feedback Loop: Support for "Google-doc-style" comments directly on artifacts that are folded back into agent logic.   

Detailed Implementation Plan (Phased Roadmap)
Phase 1: Foundation & UI Scaffolding
Project Initialization: Scaffold a TypeScript extension using yo code.   

Activity Bar & Views: Register the "Agent HQ" View Container and the "Manager" Webview View.   

Basic Workspace Selection: Implement workspace selection dialogs and URI handling.   

Phase 2: Agent Brain & Context Grounding
Gemini 3 Integration: Connect to the gemini-3-pro-preview model using the Google Gen AI SDK.   

RAG Pipeline: Implement the File Search Store logic to index local workspace files into a semantic database.   

Thought Signature System: Build the turn-by-turn logic to persist thoughtSignature for function calling.   

Phase 3: Multi-Agent Execution & Isolation
Background Orchestrator: Develop the manager logic to handle multiple parallel generateContent streams.   

Worktree Manager: Implement automated git worktree add and git worktree remove logic for mission isolation.   

Terminal Session Management: Integrate with vscode.window.createTerminal to track and display agent-driven shell commands.   

Phase 4: Verification & Artifacts
Artifact Renderer: Build the Webview components to display Markdown plans and task lists.   

Interactive Diffs: Map agent-generated patches to vscode.commands.executeCommand('vscode.diff').   

Feedback Capture: Implement the messaging protocol between the Webview and the extension host to capture user comments on artifacts.   

Phase 5: Security & Persistent Knowledge
Autonomy Modes: Implement the "Off, Auto, Turbo" permission gating logic for terminal and tool execution.   

Knowledge Items (KIs): Design a persistent memory system using workspace memento or hidden JSON files to store learned patterns.   

MCP Tooling: Support registration and discovery of local MCP servers for extended capabilities.   

Future Trajectory: The Shift from Bricklayer to Architect
The successful replication of the Antigravity Manager in VS Code represents a transition for the developer from a "code bricklayer" to a "system architect". In this new era, the primary skill for an engineer is no longer typing syntax but managing workflows and orchestrating a workforce of digital agents.   

As models like Gemini 3 continue to evolve, the distinction between local and remote development will blur, with agents operating across repositories and environments with a context window wide enough to understand entire systems. The Manager View serves as the interface for this new reality—a dedicated space for high-level mission planning, artifact-driven verification, and multi-agent collaboration. By building this framework into VS Code, developers can leverage the power of agentic development without leaving the stability and ecosystem of the world's most popular editor.   

Advanced Technical Implementation: The Agent Manager as a Service
The culmination of this engineering effort is the realization of the "Agent Manager as a Service." By integrating the Vertex AI Agent Engine with the VS Code extension, developers can deploy their custom agents to a fully managed runtime. This allows agents to persist across different machines and team members, maintaining session state, memory banks, and tool configurations in the cloud.   

Deployment and Scaling
Through the ADK, an agent mission can be containerized and deployed to environments like Google Cloud Run or Vertex AI Agent Engine. This enables "Cloud Agents"—autonomous workers that operate on branches and pull requests isolated from the local workspace. The Manager View in VS Code then becomes a window into a global engineering team, where both local background workers and remote cloud agents report their progress via a unified artifact system.   

Execution Environment	Isolation Mechanism	Best Use Case
Local Interactivity	Standard Editor Context	
Rapid prototyping, inline edits, and code explanation.

Local Background	Git Worktrees	
Long-running refactors and test generation without workspace interference.

Cloud Agent	Branches and Pull Requests	
Large-scale migrations, documentation audits, and collaborative feature builds.

  
In this paradigm, the "Manager View" isn't just a feature of the IDE; it is the core of the development platform. It extracts the agent from the sidebar and gives it a dedicated surface to work, ensuring that the developer remains in control through high-level verification and asynchronous feedback loops. The engineering of a VS Code extension that mimics this manager is therefore a critical step toward an agent-first future where the velocity of software development is limited only by the clarity of the architect's vision.   

Conclusion: Engineering Actionable Recommendations
To build a high-fidelity replica of the Google Antigravity Agent Manager within a VS Code extension, engineers must focus on the following core principles of agentic development:

Implement a Bifurcated UI: Separate the code editor from a "Mission Control" webview dashboard that focuses on task management, agent status, and artifact review.

Prioritize Asynchronous Workflow: Design the extension host to support parallel agent missions, using Git worktrees to isolate background implementation tasks from the main workspace.

Utilize Structured Artifacts for Trust: Replace generic chat logs with verifiable deliverables like plans, diffs, and recordings, allowing for non-blocking developer oversight.

Leverage Gemini 3’s Reasoning Controls: Implement thinking level settings and thought signature validation to maintain high-quality reasoning across complex, multi-step tasks.

Standardize Tooling via MCP: Use the Model Context Protocol to bridge the gap between AI agents and local/enterprise data sources, ensuring agents have the necessary "hands" to perform their missions.

Incorporate Persistent Knowledge: Build a knowledge management system that allows agents to learn from past work, creating a self-improving development environment tailored to the specific patterns of the codebase.

By synthesizing these technical requirements into a cohesive extension, developers can achieve the same "liftoff" in productivity promised by the Antigravity platform, transforming the IDE into a sophisticated orchestration hub for the multi-agent era.   

\