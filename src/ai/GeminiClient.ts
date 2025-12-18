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
    private modelName: string = 'gemini-3-pro-preview'; // User requested preview model

    constructor(apiKey: string) {
        this.genAI = new GoogleGenerativeAI(apiKey);
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
}
