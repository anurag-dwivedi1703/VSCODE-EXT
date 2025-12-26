import { GoogleGenerativeAI, Content, GenerateContentRequest, Part, Tool } from '@google/generative-ai';

export interface ISession {
    sendMessage(prompt: string | Part[]): Promise<{
        response: {
            text: () => string;
            functionCalls: () => { name: string, args: any }[] | undefined;
        }
    }>;
}

export class GeminiClient {
    private genAI: GoogleGenerativeAI;
    private modelName: string;

    constructor(apiKey: string, modelName: string = 'gemini-3-pro-preview') {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.modelName = modelName;
    }

    public startSession(systemPrompt: string, thinkingLevel: 'low' | 'high' = 'high'): ISession {
        // TODO: Configure thinking level when API supports it publicly or via specific params.
        // For now, we will assume the model handles reasoning based on prompt.

        const model = this.genAI.getGenerativeModel({
            model: this.modelName,
            systemInstruction: systemPrompt
        });

        const chat = model.startChat({
            history: [],
            generationConfig: {
                maxOutputTokens: 8192,
                temperature: thinkingLevel === 'high' ? 0.2 : 0.7, // Lower temp for planning
            },
            tools: [
                {
                    functionDeclarations: [
                        {
                            name: "read_file",
                            description: "Read the contents of a file",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    path: { type: "STRING" as any, description: "Absolute path to the file" }
                                },
                                required: ["path"]
                            }
                        },
                        {
                            name: "write_file",
                            description: "Write content to a file. SECURITY: Never hardcode API keys/passwords/secrets - use environment variables (process.env.X). When creating .env files, a .env.example with placeholders is auto-created.",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    path: { type: "STRING" as any, description: "Absolute path to the file" },
                                    content: { type: "STRING" as any, description: "Content to write" }
                                },
                                required: ["path", "content"]
                            }
                        },
                        {
                            name: "list_files",
                            description: "List files in a directory",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    path: { type: "STRING" as any, description: "Directory path" }
                                },
                                required: ["path"]
                            }
                        },
                        {
                            name: "run_command",
                            description: "Run a shell command",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    command: { type: "STRING" as any, description: "Command to execute" }
                                },
                                required: ["command"]
                            }
                        },
                        {
                            name: "search_web",
                            description: "Search the web for documentation or solutions",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    query: { type: "STRING" as any, description: "Search query" }
                                },
                                required: ["query"]
                            }
                        },
                        {
                            name: "reload_browser",
                            description: "Reload the browser preview to verify UI changes",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {},
                                required: []
                            }
                        },
                        {
                            name: "navigate_browser",
                            description: "Navigate the browser preview to a specific URL (e.g., http://localhost:8080)",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    url: { type: "STRING" as any, description: "URL to navigate to (e.g., http://localhost:8080)" }
                                },
                                required: ["url"]
                            }
                        },
                        // Browser Automation Tools
                        {
                            name: "browser_launch",
                            description: "Launch a Chrome browser for automated testing. Optionally records a video of the session.",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    recordVideo: { type: "BOOLEAN" as any, description: "If true, records the browser session as an MP4 video" }
                                },
                                required: []
                            }
                        },
                        {
                            name: "browser_navigate",
                            description: "Navigate the automated browser to a URL and wait for page load",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    url: { type: "STRING" as any, description: "URL to navigate to" }
                                },
                                required: ["url"]
                            }
                        },
                        {
                            name: "browser_screenshot",
                            description: "Take a screenshot of the current browser page",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    name: { type: "STRING" as any, description: "Optional name for the screenshot file" }
                                },
                                required: []
                            }
                        },
                        {
                            name: "browser_click",
                            description: "Click on an element in the browser using a CSS selector",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    selector: { type: "STRING" as any, description: "CSS selector of the element to click" }
                                },
                                required: ["selector"]
                            }
                        },
                        {
                            name: "browser_type",
                            description: "Type text into an input field in the browser",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    selector: { type: "STRING" as any, description: "CSS selector of the input element" },
                                    text: { type: "STRING" as any, description: "Text to type" }
                                },
                                required: ["selector", "text"]
                            }
                        },
                        {
                            name: "browser_wait_for",
                            description: "Wait for an element to appear in the browser",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    selector: { type: "STRING" as any, description: "CSS selector to wait for" },
                                    timeout: { type: "NUMBER" as any, description: "Timeout in milliseconds (default 5000)" }
                                },
                                required: ["selector"]
                            }
                        },
                        {
                            name: "browser_get_dom",
                            description: "Get the current page's HTML content for analysis",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {},
                                required: []
                            }
                        },
                        {
                            name: "browser_verify_ui",
                            description: "Take a screenshot and use Gemini Vision AI to verify the UI matches expectations. Returns detailed analysis with issues and fix suggestions. Use this for self-healing: if FAIL, fix the issues and call again.",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    category: { type: "STRING" as any, description: "Category/name for this UI state (e.g., 'homepage', 'login-form')" },
                                    description: { type: "STRING" as any, description: "Detailed description of what the UI should look like" },
                                    mission_objective: { type: "STRING" as any, description: "The overall goal/mission this UI should fulfill" }
                                },
                                required: ["category", "description"]
                            }
                        },
                        {
                            name: "browser_close",
                            description: "Close the automated browser and stop recording if active",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {},
                                required: []
                            }
                        }
                    ]
                }
            ]
        });

        return {
            sendMessage: async (prompt: string | Part[]) => {
                const result = await chat.sendMessage(prompt);
                const response = result.response;

                // Thought Signature Logic (Stubbed for now as API support varies)
                // const signature = response.candidates?.[0]?.citationMetadata;

                return {
                    response: {
                        text: () => {
                            try {
                                return response.text();
                            } catch (e) {
                                return ""; // Handle cases with only function calls
                            }
                        },
                        functionCalls: () => {
                            return response.functionCalls();
                        }
                    }
                };
            }
        };
    }

    public async research(query: string): Promise<string> {
        try {
            const model = this.genAI.getGenerativeModel({
                model: 'gemini-3-flash-preview', // Unifying search model as requested
                tools: [
                    {
                        googleSearch: {}
                    } as any
                ]
            });

            const result = await model.generateContent(query);
            const response = result.response;
            return response.text();
        } catch (error: any) {
            return `Search failed: ${error.message}`;
        }
    }

    /**
     * Analyze a screenshot using Gemini Vision to verify it matches expectations
     * This is the core of the self-healing system - semantic UI validation
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
            // Use a vision-capable model
            const model = this.genAI.getGenerativeModel({
                model: 'gemini-2.0-flash'
            });

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
- Consider: layout, colors, text content, element presence, responsiveness
- If the page is blank, loading, or shows an error, that's a critical issue

Respond ONLY with the JSON, no other text.`;

            const result = await model.generateContent([
                prompt,
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: imageBase64
                    }
                }
            ]);

            const responseText = result.response.text();

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
                    confidence: 30, // Low confidence since we couldn't parse properly
                    issues: ['Could not parse vision analysis response'],
                    suggestions: ['Manual review recommended'],
                    analysis: responseText.substring(0, 500)
                };
            }
        } catch (error: any) {
            console.error('[GeminiClient] Vision analysis failed:', error.message);
            return {
                matches: false,
                confidence: 0,
                issues: [`Vision analysis error: ${error.message}`],
                suggestions: ['Check Gemini API connection and try again'],
                analysis: 'Analysis failed due to API error'
            };
        }
    }
}
