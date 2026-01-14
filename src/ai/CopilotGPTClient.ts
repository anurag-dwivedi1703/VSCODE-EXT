import * as vscode from 'vscode';
import { ISession } from './GeminiClient';

/**
 * GPT client using VS Code's Language Model API (vscode.lm)
 * This leverages the user's GitHub Copilot subscription for GPT-5-mini access
 */
export class CopilotGPTClient {
    private model: vscode.LanguageModelChat | undefined;

    constructor() {
        // Model will be selected when session starts
    }

    public async initialize(): Promise<boolean> {
        try {
            // Log all available models for discovery
            const allModels = await vscode.lm.selectChatModels({});

            // Try to find GPT-5-mini model
            let gptModel = allModels.find(m =>
                m.id.toLowerCase().includes('gpt-5-mini') ||
                m.family.toLowerCase().includes('gpt-5-mini')
            );

            // Fallback to any GPT-5 model
            if (!gptModel) {
                gptModel = allModels.find(m =>
                    m.id.toLowerCase().includes('gpt-5') ||
                    m.family.toLowerCase().includes('gpt-5')
                );
            }

            // Fallback to any GPT model
            if (!gptModel) {
                gptModel = allModels.find(m =>
                    m.id.toLowerCase().includes('gpt') ||
                    m.name.toLowerCase().includes('gpt') ||
                    m.family.toLowerCase().includes('gpt')
                );
            }

            if (gptModel) {
                this.model = gptModel;
                console.log(`[CopilotGPTClient] ✓ Selected GPT model: ${this.model.id} (${this.model.name})`);
                return true;
            }

            console.error('[CopilotGPTClient] ✗ No GPT models found. Available:', allModels.map(m => m.id).join(', '));
            return false;
        } catch (error: any) {
            console.error('[CopilotGPTClient] Error initializing:', error.message);
            return false;
        }
    }

    public startSession(systemPrompt: string, _thinkingLevel: 'low' | 'high' = 'high'): ISession {
        const messages: vscode.LanguageModelChatMessage[] = [];
        const model = this.model;

        // Inject tool call format instructions since vscode.lm doesn't support native function calling
        const toolCallInstructions = `

CRITICAL - TOOL CALL FORMAT:
Since you're running through VS Code's Language Model API, you MUST output tool calls in this EXACT format:

\`\`\`tool_call
{"name": "tool_name", "args": {"param1": "value1", "param2": "value2"}}
\`\`\`

═══════════════════════════════════════════════════════════════════════════════
⚠️  MANDATORY: USE apply_diff FOR ALL FILE EDITS - DO NOT USE write_file!  ⚠️
═══════════════════════════════════════════════════════════════════════════════

When modifying existing files, you MUST use apply_diff. Using write_file on existing
files causes catastrophic errors (1000+ TypeScript errors from broken code).

✅ CORRECT - Use apply_diff for edits:
\`\`\`tool_call
{"name": "apply_diff", "args": {"path": "src/file.ts", "diff": "<<<<<<< SEARCH\\nold code to find\\n=======\\nnew replacement code\\n>>>>>>> REPLACE"}}
\`\`\`

❌ WRONG - Never use write_file to modify existing files:
\`\`\`tool_call
{"name": "write_file", "args": {"path": "src/file.ts", "content": "..."}}  // DON'T DO THIS!
\`\`\`

apply_diff Rules:
1. SEARCH block must match file content EXACTLY (including whitespace and indentation)
2. Include enough unique context (2-3 lines) to identify the exact location
3. For multiple changes in one file, use multiple SEARCH/REPLACE blocks
4. Before editing, ALWAYS read_file first to see exact current content

═══════════════════════════════════════════════════════════════════════════════

Other Available Tools:
- \`\`\`tool_call
{"name": "list_files", "args": {"path": "."}}
\`\`\`
- \`\`\`tool_call
{"name": "read_file", "args": {"path": "path/to/file"}}
\`\`\`
- \`\`\`tool_call
{"name": "write_file", "args": {"path": "path/to/NEW/file", "content": "file content"}}
\`\`\`
  ^ Use ONLY for creating NEW files that don't exist yet!
  
- \`\`\`tool_call
{"name": "run_command", "args": {"command": "npm start"}}
\`\`\`
- \`\`\`tool_call
{"name": "reload_browser", "args": {}}
\`\`\`
- \`\`\`tool_call
{"name": "navigate_browser", "args": {"url": "http://localhost:3000"}}
\`\`\`
- \`\`\`tool_call
{"name": "search_web", "args": {"query": "search query"}}
\`\`\`

You MUST use this exact format. Do NOT just describe what you want to do - output the tool_call block!
`;


        // Add system context as first user message (vscode.lm may not support system role)
        messages.push(vscode.LanguageModelChatMessage.User(`[SYSTEM CONTEXT]\n${systemPrompt}\n${toolCallInstructions}\n[END SYSTEM CONTEXT]`));

        return {
            sendMessage: async (prompt: string | any[]) => {
                if (!model) {
                    return {
                        response: {
                            text: () => 'Error: Copilot GPT model not initialized. Ensure GitHub Copilot is installed and you have an active subscription.',
                            functionCalls: () => undefined
                        }
                    };
                }

                try {
                    // Handle prompt - could be string or array of parts (for tool results)
                    let userMessage = '';

                    if (typeof prompt === 'string') {
                        userMessage = prompt;
                    } else if (Array.isArray(prompt)) {
                        // Check if this is a tool response
                        const toolResponses = prompt.filter((p: any) => p.functionResponse);
                        if (toolResponses.length > 0) {
                            // Format tool responses as text (vscode.lm doesn't support native tool_use)
                            userMessage = toolResponses.map((tr: any) =>
                                `[TOOL RESULT: ${tr.functionResponse.name}]\n${JSON.stringify(tr.functionResponse.response, null, 2)}\n[END TOOL RESULT]`
                            ).join('\n\n');
                        } else {
                            // Regular text parts
                            userMessage = prompt.map((p: any) => p.text || '').join('\n');
                        }
                    }

                    if (userMessage) {
                        messages.push(vscode.LanguageModelChatMessage.User(userMessage));
                    }

                    // Send request to model
                    const response = await model.sendRequest(
                        messages,
                        {},
                        new vscode.CancellationTokenSource().token
                    );

                    // Collect response text
                    let responseText = '';
                    for await (const fragment of response.text) {
                        responseText += fragment;
                    }

                    // Add assistant response to history
                    messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));

                    // Parse for tool calls (text-based parsing since vscode.lm doesn't support native tool_use)
                    const functionCalls = this.parseToolCalls(responseText);

                    // Strip tool call blocks from text to avoid showing JSON in UI
                    const cleanedText = this.stripToolCallsFromText(responseText);

                    return {
                        response: {
                            text: () => cleanedText,
                            functionCalls: () => functionCalls.length > 0 ? functionCalls : undefined
                        }
                    };
                } catch (error: any) {
                    console.error('[CopilotGPTClient] API Error:', error.message);

                    // Check for consent error
                    if (error.message?.includes('consent') || error.message?.includes('permission')) {
                        return {
                            response: {
                                text: () => `Error: Copilot access denied. Please grant permission when prompted, or use API mode instead.\n\nDetails: ${error.message}`,
                                functionCalls: () => undefined
                            }
                        };
                    }

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
     * Parse tool calls from text response
     * Model is instructed to output tool calls in a specific format
     */
    private parseToolCalls(text: string): { name: string; args: any }[] {
        const calls: { name: string; args: any }[] = [];

        // Method 1: Look for fenced code blocks with tool_call
        // Format: ```tool_call\n{"name": "tool_name", "args": {...}}\n```
        const fencedRegex = /```tool_call\s*\n?([\s\S]*?)\n?```/g;
        let match;

        while ((match = fencedRegex.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(match[1].trim());
                if (parsed.name) {
                    calls.push({
                        name: parsed.name,
                        args: parsed.args || parsed.arguments || {}
                    });
                    console.log(`[CopilotGPTClient] Parsed fenced tool call: ${parsed.name}`);
                }
            } catch (e) {
                console.warn('[CopilotGPTClient] Failed to parse fenced tool call:', match[1]);
            }
        }

        // Method 2: Look for inline JSON with "name" field (the model might not use code fences)
        // Format: {"name": "tool_name", "args": {...}}
        if (calls.length === 0) {
            const inlineRegex = /\{"name"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[^}]*\})\s*\}/g;
            while ((match = inlineRegex.exec(text)) !== null) {
                try {
                    const name = match[1];
                    const args = JSON.parse(match[2]);
                    calls.push({ name, args });
                    console.log(`[CopilotGPTClient] Parsed inline tool call: ${name}`);
                } catch (e) {
                    console.warn('[CopilotGPTClient] Failed to parse inline tool call');
                }
            }
        }

        // Method 3: Look for tool calls with nested objects in args
        if (calls.length === 0) {
            const nestedRegex = /\{"name"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}(?:\]|\)|$|[,\s])/g;
            while ((match = nestedRegex.exec(text)) !== null) {
                try {
                    const name = match[1];
                    const args = JSON.parse(match[2]);
                    calls.push({ name, args });
                    console.log(`[CopilotGPTClient] Parsed nested tool call: ${name}`);
                } catch (e) {
                    // Skip malformed
                }
            }
        }

        console.log(`[CopilotGPTClient] Total tool calls found: ${calls.length}`);
        return calls;
    }

    /**
     * Strip tool call blocks from text to avoid showing raw JSON in the UI
     */
    private stripToolCallsFromText(text: string): string {
        // Remove fenced tool_call blocks: ```tool_call\n{...}\n```
        let cleaned = text.replace(/```tool_call\s*\n?[\s\S]*?\n?```/g, '');

        // Remove inline JSON tool calls that might be at the end of lines
        cleaned = cleaned.replace(/\{"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[^}]*\}\s*\}/g, '');

        // Clean up any extra whitespace left behind
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

        return cleaned;
    }

    /**
     * Research/search the web using Copilot GPT
     */
    public async research(query: string): Promise<string> {
        if (!this.model) {
            return 'Error: Copilot GPT model not initialized.';
        }

        try {
            const messages = [
                vscode.LanguageModelChatMessage.User(`You are a research assistant. Please provide comprehensive, factual information about the following query. Include relevant technical details, best practices, and current recommendations. If this is about a specific technology or library, include version-specific information where relevant.

Query: ${query}

Provide a detailed, helpful response based on your training data. If you're uncertain about specific details, indicate that clearly.`)
            ];

            const response = await this.model.sendRequest(
                messages,
                {},
                new vscode.CancellationTokenSource().token
            );

            let result = '';
            for await (const fragment of response.text) {
                result += fragment;
            }

            return result || 'No research results found.';
        } catch (error: any) {
            return `Research failed: ${error.message}`;
        }
    }

    /**
     * Analyze a screenshot using Copilot GPT Vision
     * Uses the vscode.lm API with image content support
     */
    public async analyzeScreenshot(
        imageBase64: Uint8Array,
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
        if (!this.model) {
            return {
                matches: false,
                confidence: 0,
                issues: ['Copilot GPT model not initialized'],
                suggestions: ['Ensure VS Code Copilot is available'],
                analysis: 'Vision analysis failed: Model not initialized'
            };
        }

        try {
            const prompt = `You are a UI testing expert. Analyze this screenshot and determine if it matches the expected design.

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
- If the page is blank, loading, or shows an error, that's a critical issue

Respond ONLY with the JSON, no other text.`;

            // Create multimodal message with text and image
            const messages = [
                vscode.LanguageModelChatMessage.User([new vscode.LanguageModelDataPart(imageBase64, mimeType)]),
                vscode.LanguageModelChatMessage.User(prompt),
            ];

            const response = await this.model.sendRequest(
                messages,
                {},
                new vscode.CancellationTokenSource().token
            );

            let responseText = '';
            for await (const fragment of response.text) {
                responseText += fragment;
            }

            console.log(`[CopilotGPTClient] Vision response: ${responseText.substring(0, 100)}...`);

            // Parse the JSON response
            try {
                let jsonText = responseText.trim();
                if (jsonText.startsWith('```json')) jsonText = jsonText.slice(7);
                if (jsonText.startsWith('```')) jsonText = jsonText.slice(3);
                if (jsonText.endsWith('```')) jsonText = jsonText.slice(0, -3);
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
            console.error('[CopilotGPTClient] Vision analysis failed:', error.message);

            // Check if it's a "not supported" error - fall back gracefully
            if (error.message?.includes('image') || error.message?.includes('multimodal') || error.message?.includes('content')) {
                return {
                    matches: false,
                    confidence: 0,
                    issues: ['This GPT model may not support vision through Copilot'],
                    suggestions: [
                        'Use Gemini for vision analysis (set Gemini API key)',
                        `Expected: ${expectedDescription.substring(0, 100)}...`
                    ],
                    analysis: `Vision analysis not available for this model. Mission objective: ${missionObjective}`
                };
            }

            return {
                matches: false,
                confidence: 0,
                issues: [`Vision analysis error: ${error.message}`],
                suggestions: ['Check Copilot connection and try again'],
                analysis: 'Analysis failed due to API error'
            };
        }
    }
}
