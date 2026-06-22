import * as vscode from 'vscode';

/**
 * Shared tool definitions for Copilot clients using the VS Code Language Model API.
 * Single source of truth for tool schemas — used by CopilotClaudeClient, CopilotGeminiClient, CopilotGPTClient.
 *
 * Each tool maps 1:1 to a case in TaskRunner's dispatch switch and an AgentTools method.
 */

/**
 * Returns the full tool set for main agent sessions.
 * Includes all read/write/browser/analysis tools.
 */
export function getMainAgentTools(): vscode.LanguageModelChatTool[] {
    return [
        {
            name: 'read_file',
            description: 'Read the contents of a file. For large files (>300 lines), use startLine/endLine to read specific sections instead of reading the entire file.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file' },
                    startLine: { type: 'number', description: 'Start line number (1-indexed, inclusive). Omit to read from beginning.' },
                    endLine: { type: 'number', description: 'End line number (1-indexed, inclusive). Omit to read to end.' }
                },
                required: ['path']
            }
        },
        {
            name: 'write_file',
            description: 'Write content to a file. Use ONLY for creating NEW files that do not exist yet. NEVER use write_file to modify existing files — use apply_diff instead. SECURITY: Never hardcode API keys/passwords/secrets — use environment variables.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file to create' },
                    content: { type: 'string', description: 'Content to write to the file' }
                },
                required: ['path', 'content']
            }
        },
        {
            name: 'apply_diff',
            description: 'Apply a SEARCH/REPLACE diff to modify an existing file. The diff parameter contains one or more SEARCH/REPLACE blocks. Each SEARCH block must match file content exactly (including whitespace and indentation). ALWAYS use read_file first to see current content before editing. Batch all changes to the same file in one apply_diff call.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file to modify' },
                    diff: { type: 'string', description: 'One or more SEARCH/REPLACE blocks in the format: <<<<<<< SEARCH\nexact code to find\n=======\nreplacement code\n>>>>>>> REPLACE' }
                },
                required: ['path', 'diff']
            }
        },
        {
            name: 'list_files',
            description: 'List files and directories in a given directory path.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path to list' }
                },
                required: ['path']
            }
        },
        {
            name: 'grep_search',
            description: 'Search for text or regex pattern across workspace files. Returns matching lines with file paths and line numbers. Use this to find code locations before using read_file with line ranges.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text or regex pattern to search for' },
                    includePattern: { type: 'string', description: "Glob pattern to filter files (e.g., 'src/**/*.ts'). Default: all files." },
                    isRegexp: { type: 'boolean', description: 'Whether query is a regex pattern. Default: false.' },
                    maxResults: { type: 'number', description: 'Maximum results to return. Default: 50.' }
                },
                required: ['query']
            }
        },
        {
            name: 'file_search',
            description: "Find files matching a glob pattern. Returns list of file paths. Example patterns: '**/*.ts', 'src/engine/*.ts'.",
            inputSchema: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: "Glob pattern (e.g., '**/*.ts', 'src/engine/*.ts')" },
                    maxResults: { type: 'number', description: 'Maximum results. Default: 50.' }
                },
                required: ['pattern']
            }
        },
        {
            name: 'run_command',
            description: "Run a shell command. Default timeout: 15s. For slow operations (pip install, npm install, venv creation), set waitTimeoutMs to 120000 (2min) or higher. Use '&' suffix for background execution.",
            inputSchema: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Command to execute' },
                    waitTimeoutMs: { type: 'number', description: 'Timeout in ms (default: 15000, max: 600000). Use 120000+ for pip/npm install.' }
                },
                required: ['command']
            }
        },
        {
            name: 'search_web',
            description: 'Search the web for documentation, solutions, or technical information.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' }
                },
                required: ['query']
            }
        },
        {
            name: 'reload_browser',
            description: 'Reload the browser preview to verify UI changes.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            }
        },
        {
            name: 'navigate_browser',
            description: 'Navigate the browser preview to a specific URL (e.g., http://localhost:8080).',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to navigate to (e.g., http://localhost:8080)' }
                },
                required: ['url']
            }
        },
        {
            name: 'browser_launch',
            description: 'Launch a Chrome browser for automated testing. Optionally records a video of the session.',
            inputSchema: {
                type: 'object',
                properties: {
                    recordVideo: { type: 'boolean', description: 'If true, records the browser session as an MP4 video' }
                },
                required: []
            }
        },
        {
            name: 'browser_navigate',
            description: 'Navigate the automated browser to a URL and wait for page load. If SSO/Okta login is detected, the system automatically pauses for user authentication (5min timeout).',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to navigate to' }
                },
                required: ['url']
            }
        },
        {
            name: 'browser_screenshot',
            description: 'Take a screenshot of the current browser page.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Optional name for the screenshot file' }
                },
                required: []
            }
        },
        {
            name: 'browser_click',
            description: 'Click on an element in the browser using a CSS selector.',
            inputSchema: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector of the element to click' }
                },
                required: ['selector']
            }
        },
        {
            name: 'browser_type',
            description: 'Type text into an input field in the browser.',
            inputSchema: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector of the input element' },
                    text: { type: 'string', description: 'Text to type' }
                },
                required: ['selector', 'text']
            }
        },
        {
            name: 'browser_wait_for',
            description: 'Wait for an element to appear in the browser.',
            inputSchema: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector to wait for' },
                    timeout: { type: 'number', description: 'Timeout in milliseconds (default 5000)' }
                },
                required: ['selector']
            }
        },
        {
            name: 'browser_get_dom',
            description: "Get the current page's HTML content for analysis.",
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            }
        },
        {
            name: 'browser_verify_ui',
            description: 'Take a screenshot and use AI Vision to verify the UI matches expectations. Returns detailed analysis with issues and fix suggestions. Use this for self-healing: if FAIL, fix the issues and call again.',
            inputSchema: {
                type: 'object',
                properties: {
                    category: { type: 'string', description: "Category/name for this UI state (e.g., 'homepage', 'login-form')" },
                    description: { type: 'string', description: 'Detailed description of what the UI should look like' },
                    mission_objective: { type: 'string', description: 'The overall goal/mission this UI should fulfill' }
                },
                required: ['category', 'description']
            }
        },
        {
            name: 'browser_close',
            description: 'Close the automated browser and stop recording if active.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            }
        },
        {
            name: 'update_phase_status',
            description: 'Declare a phase transition. Call this ONCE when you finish a phase (e.g., refinement complete, planning complete, implementation phase N complete, moving to testing). This is how the system tracks your progress. You MUST call this before starting work on the next phase.',
            inputSchema: {
                type: 'object',
                properties: {
                    completedPhase: { type: 'string', description: "The phase just completed: 'refinement', 'planning', 'implementation', or 'testing'" },
                    nextPhase: { type: 'string', description: "The phase you are about to start: 'planning', 'implementation', 'testing', or 'done'" },
                    implementationPhaseNumber: { type: 'number', description: 'If completing an implementation sub-phase, which number (1, 2, 3...). Omit for planning/testing.' },
                    summary: { type: 'string', description: 'Brief summary of what was accomplished in the completed phase.' }
                },
                required: ['completedPhase', 'nextPhase', 'summary']
            }
        },
        {
            name: 'spawn_analysis_agents',
            description: 'Spawn parallel read-only analysis agents for deep codebase investigation. Each agent gets its own context, reads specified files, and writes findings to disk. Use during Discovery phase. Max 8 tasks per call. Use focused questions per task.',
            inputSchema: {
                type: 'object',
                properties: {
                    tasks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'Unique identifier for this analysis task' },
                                description: { type: 'string', description: 'What to analyze' },
                                files: { type: 'array', items: { type: 'string' }, description: 'File paths to analyze' },
                                question: { type: 'string', description: 'Specific question to answer' }
                            },
                            required: ['id', 'description', 'files', 'question']
                        },
                        description: 'Array of analysis tasks to run in parallel (max 8)'
                    }
                },
                required: ['tasks']
            }
        },
        {
            name: 'get_diagnostics',
            description: 'Get compiler errors, lint warnings, and type-check issues from the IDE language services. Call with no arguments to get all errors across the workspace, or with a file path to get diagnostics for a specific file. Results are instant — no build step required.',
            inputSchema: {
                type: 'object',
                properties: {
                    filePath: {
                        type: 'string',
                        description: 'Optional absolute or relative file path to check. Omit to get all errors across the workspace.'
                    }
                },
                required: []
            }
        },
        {
            name: 'codebase_search',
            description: 'Search the codebase semantically. Unlike grep_search which finds exact text matches, this finds conceptually related code. Use this when you need to find code by what it DOES rather than exact text. Example: searching "authentication middleware" will find auth guards, session validators, token checkers. Falls back to grep if semantic search is unavailable.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Natural language description of the code you are looking for.'
                    }
                },
                required: ['query']
            }
        },
        {
            name: 'run_tests',
            description: 'Run tests in the workspace. Automatically detects the test framework. Optionally provide a pattern to run specific tests. Returns structured pass/fail results when available, otherwise returns the test command output.',
            inputSchema: {
                type: 'object',
                properties: {
                    testPattern: {
                        type: 'string',
                        description: 'Optional pattern to filter which tests to run (e.g., a test file name or test name pattern).'
                    }
                },
                required: []
            }
        }
    ];
}

/**
 * Returns the read-only tool subset for discovery sub-agent sessions.
 * Only includes: read_file, grep_search, file_search, list_files
 */
export function getSubAgentTools(): vscode.LanguageModelChatTool[] {
    const mainTools = getMainAgentTools();
    const subAgentToolNames = ['read_file', 'grep_search', 'file_search', 'list_files', 'get_diagnostics', 'codebase_search'];
    return mainTools.filter(t => subAgentToolNames.includes(t.name));
}

/**
 * Returns the tool set for refinement discovery sessions.
 * Includes grep_search, list_files, file_search (lightweight) and spawn_analysis_agents (heavyweight).
 * MaxResults descriptions are capped for grep_search and file_search in refinement mode.
 */
export function getRefinementDiscoveryTools(): vscode.LanguageModelChatTool[] {
    const mainTools = getMainAgentTools();
    const refinementToolNames = [
        'grep_search',
        'list_files',
        'file_search',
        'spawn_analysis_agents',
        'get_diagnostics',
        'codebase_search'
    ];

    return mainTools
        .filter(t => refinementToolNames.includes(t.name))
        .map(t => {
            // Cap maxResults in descriptions for grep_search and file_search
            if (t.name === 'grep_search') {
                const schema = JSON.parse(JSON.stringify(t.inputSchema));
                if (schema.properties?.maxResults) {
                    schema.properties.maxResults.description =
                        'Maximum results to return. Default: 20. Max: 20 (refinement mode cap).';
                }
                return { ...t, inputSchema: schema };
            }
            if (t.name === 'file_search') {
                const schema = JSON.parse(JSON.stringify(t.inputSchema));
                if (schema.properties?.maxResults) {
                    schema.properties.maxResults.description =
                        'Maximum results. Default: 20. Max: 20 (refinement mode cap).';
                }
                return { ...t, inputSchema: schema };
            }
            return t;
        });
}
