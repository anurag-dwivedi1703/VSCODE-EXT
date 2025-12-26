import Anthropic from '@anthropic-ai/sdk';
import { ISession } from './GeminiClient';

export class ClaudeClient {
    private client: Anthropic;
    private modelName: string;

    constructor(apiKey: string, modelName: string = 'claude-opus-4-5-20251101') {
        this.client = new Anthropic({ apiKey });
        this.modelName = modelName;
    }

    public startSession(systemPrompt: string, thinkingLevel: 'low' | 'high' = 'high'): ISession {
        // Store full conversation history for multi-turn (includes tool_use blocks)
        const messages: Anthropic.MessageParam[] = [];

        // Track tool_use IDs in order for parallel tool calls
        // Array of { name, id } from last assistant response
        let lastToolUses: { name: string; id: string }[] = [];

        // Define tools for Claude
        const tools: Anthropic.Tool[] = [
            {
                name: "read_file",
                description: "Read the contents of a file",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        path: { type: "string", description: "Absolute path to the file" }
                    },
                    required: ["path"]
                }
            },
            {
                name: "write_file",
                description: "Write content to a file. SECURITY: Never hardcode API keys/passwords/secrets - use environment variables (process.env.X). When creating .env files, a .env.example with placeholders is auto-created.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        path: { type: "string", description: "Absolute path to the file" },
                        content: { type: "string", description: "Content to write" }
                    },
                    required: ["path", "content"]
                }
            },
            {
                name: "list_files",
                description: "List files in a directory",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        path: { type: "string", description: "Directory path" }
                    },
                    required: ["path"]
                }
            },
            {
                name: "run_command",
                description: "Run a shell command",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        command: { type: "string", description: "Command to execute" }
                    },
                    required: ["command"]
                }
            },
            {
                name: "search_web",
                description: "Search the web for documentation or solutions",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        query: { type: "string", description: "Search query" }
                    },
                    required: ["query"]
                }
            },
            {
                name: "reload_browser",
                description: "Reload the browser preview to verify UI changes",
                input_schema: {
                    type: "object" as const,
                    properties: {},
                    required: []
                }
            },
            {
                name: "navigate_browser",
                description: "Navigate the browser preview to a specific URL (e.g., http://localhost:8080)",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        url: { type: "string", description: "URL to navigate to (e.g., http://localhost:8080)" }
                    },
                    required: ["url"]
                }
            },
            // Browser Automation Tools
            {
                name: "browser_launch",
                description: "Launch a Chrome browser for automated testing. Optionally records a video of the session.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        recordVideo: { type: "boolean", description: "If true, records the browser session as an MP4 video" }
                    },
                    required: []
                }
            },
            {
                name: "browser_navigate",
                description: "Navigate the automated browser to a URL and wait for page load",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        url: { type: "string", description: "URL to navigate to" }
                    },
                    required: ["url"]
                }
            },
            {
                name: "browser_screenshot",
                description: "Take a screenshot of the current browser page",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        name: { type: "string", description: "Optional name for the screenshot file" }
                    },
                    required: []
                }
            },
            {
                name: "browser_click",
                description: "Click on an element in the browser using a CSS selector",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        selector: { type: "string", description: "CSS selector of the element to click" }
                    },
                    required: ["selector"]
                }
            },
            {
                name: "browser_type",
                description: "Type text into an input field in the browser",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        selector: { type: "string", description: "CSS selector of the input element" },
                        text: { type: "string", description: "Text to type" }
                    },
                    required: ["selector", "text"]
                }
            },
            {
                name: "browser_wait_for",
                description: "Wait for an element to appear in the browser",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        selector: { type: "string", description: "CSS selector to wait for" },
                        timeout: { type: "number", description: "Timeout in milliseconds (default 5000)" }
                    },
                    required: ["selector"]
                }
            },
            {
                name: "browser_get_dom",
                description: "Get the current page's HTML content for analysis",
                input_schema: {
                    type: "object" as const,
                    properties: {},
                    required: []
                }
            },
            {
                name: "browser_verify_ui",
                description: "Take a screenshot and use Gemini Vision AI to verify the UI matches expectations. Returns detailed analysis with issues and fix suggestions. Use this for self-healing: if FAIL, fix the issues and call again.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        category: { type: "string", description: "Category/name for this UI state (e.g., 'homepage', 'login-form')" },
                        description: { type: "string", description: "Detailed description of what the UI should look like" },
                        mission_objective: { type: "string", description: "The overall goal/mission this UI should fulfill" }
                    },
                    required: ["category", "description"]
                }
            },
            {
                name: "browser_close",
                description: "Close the automated browser and stop recording if active",
                input_schema: {
                    type: "object" as const,
                    properties: {},
                    required: []
                }
            }
        ];

        return {
            sendMessage: async (prompt: string | any[]) => {
                try {
                    // Handle prompt - could be string or array of parts (for tool results)
                    if (typeof prompt === 'string') {
                        // Regular user message
                        messages.push({ role: 'user', content: prompt });
                    } else if (Array.isArray(prompt)) {
                        // Check if this is a tool response (functionResponse from Gemini-style)
                        const toolResponses = prompt.filter((p: any) => p.functionResponse);
                        if (toolResponses.length > 0) {
                            // Convert Gemini-style tool responses to Claude format
                            // Match by position in the order they were called
                            const toolResultBlocks: Anthropic.ToolResultBlockParam[] = toolResponses.map((tr: any, index: number) => {
                                // Find matching tool_use by index (same order as they were called)
                                const toolUse = lastToolUses[index];
                                const toolUseId = toolUse?.id;

                                if (!toolUseId) {
                                    console.error(`[ClaudeClient] No tool_use_id found at index ${index} for tool: ${tr.functionResponse.name}`);
                                }

                                return {
                                    type: 'tool_result' as const,
                                    tool_use_id: toolUseId || `unknown_${index}`,
                                    content: JSON.stringify(tr.functionResponse.response)
                                };
                            });
                            messages.push({ role: 'user', content: toolResultBlocks });
                        } else {
                            // Regular text parts
                            const text = prompt.map((p: any) => p.text || '').join('\n');
                            if (text) {
                                messages.push({ role: 'user', content: text });
                            }
                        }
                    }

                    // Build request
                    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
                        model: this.modelName,
                        max_tokens: 16000,
                        system: systemPrompt,
                        tools,
                        messages
                    };

                    const response = await this.client.messages.create(requestParams);

                    // Extract text and tool calls from response
                    let responseText = '';
                    const functionCalls: { name: string; args: any }[] = [];

                    // Clear previous tool uses and track new ones
                    lastToolUses = [];

                    // Build assistant content array for history
                    const assistantContent: Anthropic.ContentBlock[] = [];

                    for (const block of response.content) {
                        if (block.type === 'text') {
                            responseText += block.text;
                            assistantContent.push(block);
                        } else if (block.type === 'tool_use') {
                            // Track tool_use in order for later matching
                            lastToolUses.push({ name: block.name, id: block.id });
                            functionCalls.push({
                                name: block.name,
                                args: block.input
                            });
                            assistantContent.push(block);
                        }
                    }

                    // Add assistant response to history (with full content including tool_use blocks)
                    if (assistantContent.length > 0) {
                        messages.push({ role: 'assistant', content: assistantContent as any });
                    }

                    return {
                        response: {
                            text: () => responseText,
                            functionCalls: () => functionCalls.length > 0 ? functionCalls : undefined
                        }
                    };
                } catch (error: any) {
                    console.error('[ClaudeClient] API Error:', error.message);
                    return {
                        response: {
                            text: () => `Error: ${error.message}`,
                            functionCalls: () => undefined
                        }
                    };
                }
            }
        };
    }
}
