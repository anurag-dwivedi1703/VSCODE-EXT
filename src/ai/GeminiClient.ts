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
                            description: "Write content to a file",
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
                            description: "Take a screenshot and verify the UI against expectations. Compares against baseline if exists.",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    category: { type: "STRING" as any, description: "Category/name for this UI state (e.g., 'homepage', 'login-form')" },
                                    description: { type: "STRING" as any, description: "Expected appearance of the UI" }
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
}
