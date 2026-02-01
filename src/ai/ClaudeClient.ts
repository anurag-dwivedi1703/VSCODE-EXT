import Anthropic from '@anthropic-ai/sdk';
import { ISession } from './GeminiClient';

export class ClaudeClient {
    private client: Anthropic;
    private modelName: string;

    constructor(apiKey: string, modelName: string = 'claude-opus-4-5-20251101') {
        this.client = new Anthropic({ apiKey });
        this.modelName = modelName;
    }

    public startSession(systemPrompt: string, _thinkingLevel: 'low' | 'high' = 'high', includeToolInstructions: boolean = true): ISession {
        // Store full conversation history for multi-turn (includes tool_use blocks)
        const messages: Anthropic.MessageParam[] = [];

        // Track tool_use IDs in order for parallel tool calls
        // Array of { name, id } from last assistant response
        let lastToolUses: { name: string; id: string }[] = [];

        // For refinement mode (includeToolInstructions=false), add instruction to not use tools
        const effectivePrompt = includeToolInstructions 
            ? systemPrompt
            : `${systemPrompt}\n\nIMPORTANT: You are in analysis/refinement mode. Do NOT use any tools. Only provide text responses - questions, analysis, or structured documents.`;

        // Define tools for Claude (only if tool instructions are enabled)
        const tools: Anthropic.Tool[] = includeToolInstructions ? [
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
                description: "Run a shell command. Default timeout: 15s. For slow operations (pip install, npm install, venv creation), set waitTimeoutMs to 120000 (2min) or higher. Use '&' suffix for background execution.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        command: { type: "string", description: "Command to execute" },
                        waitTimeoutMs: { type: "number", description: "Timeout in ms (default: 15000, max: 600000). Use 120000+ for pip/npm install." }
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
                description: "Navigate the automated browser to a URL and wait for page load. If SSO/Okta login is detected, the system automatically pauses for user authentication (5min timeout). No extra action needed.",
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
        ] : [];  // Empty tools array when in refinement mode

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
                        system: effectivePrompt,
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

    /**
     * Research/search the web using Claude
     * Note: Claude doesn't have native web search, so we simulate with a research prompt
     */
    public async research(query: string): Promise<string> {
        try {
            const response = await this.client.messages.create({
                model: this.modelName,
                max_tokens: 4096,
                messages: [{
                    role: 'user',
                    content: `You are a research assistant. Please provide comprehensive, factual information about the following query. Include relevant technical details, best practices, and current recommendations. If this is about a specific technology or library, include version-specific information where relevant.

Query: ${query}

Provide a detailed, helpful response based on your training data. If you're uncertain about specific details, indicate that clearly.`
                }]
            });

            // Extract text from response
            let result = '';
            for (const block of response.content) {
                if (block.type === 'text') {
                    result += block.text;
                }
            }
            return result || 'No research results found.';
        } catch (error: any) {
            return `Research failed: ${error.message}`;
        }
    }

    /**
     * Analyze a screenshot using Claude Vision to verify it matches expectations
     * This enables the browser_verify_ui tool to work with Claude
     */
    public async analyzeScreenshot(
        imageBase64: string,
        mimeType: string,
        expectedDescription: string,
        missionObjective: string
    ): Promise<{
        matches: boolean;
        confidence: number;
        issues: string[];
        suggestions: string[];
        analysis: string;
    }> {
        try {
            const response = await this.client.messages.create({
                model: this.modelName,
                max_tokens: 4096,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                                data: imageBase64
                            }
                        },
                        {
                            type: 'text',
                            text: `You are a UI testing expert. Analyze this screenshot and determine if it matches the expected design.

MISSION OBJECTIVE: ${missionObjective}

EXPECTED UI DESCRIPTION: ${expectedDescription}

Analyze the screenshot and respond in this EXACT JSON format:
{
"matches": true/false,
"confidence": 0-100,
"issues": ["list of specific UI problems found"],
"suggestions": ["list of specific code fixes to address the issues"],
"analysis": "Brief description of what you see vs what was expected"
}

IMPORTANT:
- Set "matches" to true ONLY if the UI clearly fulfills the expected description
- Be specific about issues (e.g., "Button text is 'Submit' but should be 'Login'")
- Provide actionable suggestions (e.g., "Change the h1 text from 'Welcome' to 'Login Form'")
- Consider: layout, colors, text content, element presence, responsiveness
- If the page is blank, loading, or shows an error, that's a critical issue

Respond ONLY with the JSON, no other text.`
                        }
                    ]
                }]
            });

            // Extract text from response
            let responseText = '';
            for (const block of response.content) {
                if (block.type === 'text') {
                    responseText += block.text;
                }
            }

            // Parse the JSON response
            try {
                // Clean up the response (remove markdown code blocks if present)
                let jsonText = responseText.trim();
                if (jsonText.startsWith('```json')) {
                    jsonText = jsonText.slice(7);
                }
                if (jsonText.startsWith('```')) {
                    jsonText = jsonText.slice(3);
                }
                if (jsonText.endsWith('```')) {
                    jsonText = jsonText.slice(0, -3);
                }
                jsonText = jsonText.trim();

                const parsed = JSON.parse(jsonText);
                return {
                    matches: parsed.matches === true,
                    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
                    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
                    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
                    analysis: parsed.analysis || 'No analysis provided'
                };
            } catch (parseError) {
                // If JSON parsing fails, try to extract meaning from text
                const lowerText = responseText.toLowerCase();
                const matches = lowerText.includes('matches": true') ||
                    (lowerText.includes('looks correct') && !lowerText.includes('not'));

                return {
                    matches: matches,
                    confidence: 30,
                    issues: ['Could not parse vision analysis response'],
                    suggestions: ['Manual review recommended'],
                    analysis: responseText.substring(0, 500)
                };
            }
        } catch (error: any) {
            console.error('[ClaudeClient] Vision analysis failed:', error.message);
            return {
                matches: false,
                confidence: 0,
                issues: [`Vision analysis error: ${error.message}`],
                suggestions: ['Check Claude API connection and try again'],
                analysis: 'Analysis failed due to API error'
            };
        }
    }
}
