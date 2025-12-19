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
