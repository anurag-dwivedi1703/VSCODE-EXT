/**
 * AttachmentProcessor.ts
 * Processes user attachments (images, documents) for context enrichment.
 * 
 * - Images: Analyzed via vision APIs with CONTEXT-AWARE prompts
 *   Priority: Gemini Flash (Copilot) > Claude (Copilot) > GPT (Copilot) > Gemini API > Claude API
 * - Documents: Text extracted for context
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CopilotClaudeClient } from '../ai/CopilotClaudeClient';
import { CopilotGPTClient } from '../ai/CopilotGPTClient';
import { CopilotGeminiClient } from '../ai/CopilotGeminiClient';
import { ClaudeClient } from '../ai/ClaudeClient';
import { GeminiClient } from '../ai/GeminiClient';

export interface Attachment {
    name: string;
    type: 'image' | 'document' | 'file';
    path?: string;          // For workspace files
    dataUrl?: string;       // For uploaded files (base64 data URL)
    mimeType?: string;
    size?: number;
}

export interface ProcessedAttachment {
    name: string;
    type: 'image' | 'document' | 'file';
    originalPath?: string;
    analysis?: string;      // For images: vision analysis result
    content?: string;       // For documents: extracted text
    error?: string;         // If processing failed
}

/**
 * Vision client that supports analyzeScreenshot - common interface across all Copilot clients.
 */
type VisionCapableClient = CopilotClaudeClient | CopilotGPTClient | CopilotGeminiClient;

/**
 * Process attachments and generate context-enriched descriptions.
 */
export class AttachmentProcessor {
    // Best-vision-first Copilot clients
    private copilotGeminiClient?: CopilotGeminiClient;
    private copilotClaudeClient?: CopilotClaudeClient;
    private copilotGPTClient?: CopilotGPTClient;
    // API-key fallback clients
    private geminiApiClient?: GeminiClient;
    private claudeApiClient?: ClaudeClient;
    // Track initialization
    private clientsInitialized = false;

    constructor() {
        // Clients are initialized on-demand when needed
    }

    /**
     * Initialize AI clients for vision analysis.
     * Best-vision priority: Gemini Flash (Copilot) > Claude (Copilot) > GPT (Copilot) > Gemini API > Claude API
     */
    private async initializeClients(): Promise<void> {
        if (this.clientsInitialized) { return; }
        this.clientsInitialized = true;

        const config = vscode.workspace.getConfiguration('vibearchitect');

        // Priority 1: Copilot Gemini Flash (best for vision - fast and accurate)
        try {
            this.copilotGeminiClient = new CopilotGeminiClient();
            const ok = await this.copilotGeminiClient.initialize('gemini-3-flash');
            if (ok) {
                console.log('[AttachmentProcessor] Copilot Gemini Flash initialized (best vision)');
            } else {
                this.copilotGeminiClient = undefined;
            }
        } catch (e: any) {
            console.log(`[AttachmentProcessor] Copilot Gemini unavailable: ${e.message}`);
            this.copilotGeminiClient = undefined;
        }

        // Priority 2: Copilot Claude (good vision, especially Sonnet 4.5)
        try {
            this.copilotClaudeClient = new CopilotClaudeClient();
            const ok = await this.copilotClaudeClient.initialize('claude-sonnet-4.5');
            if (ok) {
                console.log('[AttachmentProcessor] Copilot Claude initialized');
            } else {
                this.copilotClaudeClient = undefined;
            }
        } catch (e: any) {
            console.log(`[AttachmentProcessor] Copilot Claude unavailable: ${e.message}`);
            this.copilotClaudeClient = undefined;
        }

        // Priority 3: Copilot GPT (decent vision)
        try {
            this.copilotGPTClient = new CopilotGPTClient();
            const ok = await this.copilotGPTClient.initialize('gpt-5-mini');
            if (ok) {
                console.log('[AttachmentProcessor] Copilot GPT initialized');
            } else {
                this.copilotGPTClient = undefined;
            }
        } catch (e: any) {
            console.log(`[AttachmentProcessor] Copilot GPT unavailable: ${e.message}`);
            this.copilotGPTClient = undefined;
        }

        // Priority 4: Gemini API (if API key available)
        const geminiApiKey = config.get<string>('geminiApiKey') || '';
        if (geminiApiKey) {
            this.geminiApiClient = new GeminiClient(geminiApiKey, 'gemini-2.0-flash');
            console.log('[AttachmentProcessor] Gemini API initialized');
        }

        // Priority 5: Claude API (if API key available)
        const claudeApiKey = config.get<string>('claudeApiKey') || '';
        if (claudeApiKey) {
            this.claudeApiClient = new ClaudeClient(claudeApiKey, 'claude-3-5-sonnet-20241022');
            console.log('[AttachmentProcessor] Claude API initialized');
        }
    }

    /**
     * Step 1 of two-step vision: Extract the user's specific intent about the image.
     * Uses a fast text-only AI call to distill the user's prompt into a focused
     * instruction for the vision model, so vision analysis is laser-targeted.
     * 
     * Priority: uses whichever Copilot model is available (cheapest first).
     */
    private async extractUserIntent(userPrompt: string): Promise<string | null> {
        // Find any available Copilot model for a text-only call
        const textModel = this.copilotGeminiClient?.['model'] 
            || this.copilotGPTClient?.['model'] 
            || this.copilotClaudeClient?.['model'];

        if (!textModel) {
            console.log('[AttachmentProcessor] No text model available for intent extraction');
            return null;
        }

        try {
            console.log('[AttachmentProcessor] Step 1: Extracting user intent from prompt...');

            const messages = [
                vscode.LanguageModelChatMessage.User(
`You are an intent extraction assistant. The user has attached an image along with a text message. Your job is to understand EXACTLY what the user wants to know about the image and produce a focused instruction for a vision model.

USER'S MESSAGE: "${userPrompt}"

Based on the user's message above, produce a CLEAR, SPECIFIC instruction (2-3 sentences max) that tells a vision model exactly what to look for and extract from the image. 

Examples:
- If user says "can you analyze this screenshot for me" → "Describe the UI layout, all visible elements, text labels, data values, and any notable visual patterns or issues in this screenshot."
- If user says "there's a bug in this form, the submit button is misaligned" → "Focus on the form area and the submit button. Identify any alignment issues, spacing problems, or visual inconsistencies with the button positioning relative to other form elements."
- If user says "what are the sales numbers in this chart" → "Extract all numerical data, labels, and values visible in the chart. Report exact numbers, axis labels, legends, and any trends shown."
- If user says "implement this UI design" → "Describe the complete UI design in detail: layout structure, component hierarchy, colors, typography, spacing, icons, and all visual elements needed to recreate this design in code."

Reply with ONLY the focused instruction, nothing else.`)
            ];

            const response = await textModel.sendRequest(
                messages,
                {},
                new vscode.CancellationTokenSource().token
            );

            let intent = '';
            for await (const fragment of response.text) {
                intent += fragment;
            }

            intent = intent.trim();
            if (intent.length > 0) {
                console.log(`[AttachmentProcessor] Extracted intent: "${intent.substring(0, 120)}..."`);
                return intent;
            }
        } catch (e: any) {
            console.log(`[AttachmentProcessor] Intent extraction failed: ${e.message}`);
        }

        return null;
    }

    /**
     * Build a fallback vision prompt when intent extraction is unavailable.
     * Only used when no text model is available for the two-step flow.
     */
    private buildFallbackVisionPrompt(userPrompt: string): { description: string; objective: string } {
        if (userPrompt && userPrompt.trim().length > 0) {
            return {
                description: `The user said: "${userPrompt}". Analyze this image focusing on what is directly relevant to the user's message. Be specific about the aspects the user cares about.`,
                objective: `Extract information from this image that addresses the user's request: "${userPrompt.substring(0, 200)}"`
            };
        }

        return {
            description: 'Analyze this image in detail. Describe all visible elements including: UI components, text/labels, data/values, layout structure, colors, icons, and any notable visual information. Be thorough and specific.',
            objective: 'Extract all relevant information from this image to provide comprehensive context.'
        };
    }

    /**
     * Process all attachments and return enriched context.
     * @param attachments - List of attachments to process
     * @param userPrompt - The user's message (used to make vision analysis context-aware)
     */
    async processAttachments(attachments: Attachment[], userPrompt?: string): Promise<ProcessedAttachment[]> {
        if (!attachments || attachments.length === 0) {
            return [];
        }

        await this.initializeClients();

        const results: ProcessedAttachment[] = [];

        for (const attachment of attachments) {
            try {
                if (attachment.type === 'image') {
                    const result = await this.processImage(attachment, userPrompt || '');
                    results.push(result);
                } else if (attachment.type === 'document') {
                    const result = await this.processDocument(attachment);
                    results.push(result);
                } else {
                    // Generic file - just include path/name
                    results.push({
                        name: attachment.name,
                        type: attachment.type,
                        originalPath: attachment.path,
                        content: `File attached: ${attachment.name}`
                    });
                }
            } catch (error: any) {
                results.push({
                    name: attachment.name,
                    type: attachment.type,
                    error: `Failed to process: ${error.message}`
                });
            }
        }

        return results;
    }

    /**
     * Process an image attachment using TWO-STEP vision analysis:
     *   Step 1: AI extracts the user's intent from their text prompt (text-only call)
     *   Step 2: Vision model analyzes the image with the focused intent
     * 
     * This ensures vision analysis directly addresses what the user is asking about,
     * rather than producing a generic image description.
     * 
     * Vision priority: Gemini Flash (Copilot) > Claude (Copilot) > GPT (Copilot) > Gemini API > Claude API
     */
    private async processImage(attachment: Attachment, userPrompt: string): Promise<ProcessedAttachment> {
        let imageBuffer: Buffer;
        let mimeType = attachment.mimeType || 'image/png';

        // Get image data
        if (attachment.dataUrl) {
            // Extract base64 from data URL
            const base64Match = attachment.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
                mimeType = base64Match[1];
                imageBuffer = Buffer.from(base64Match[2], 'base64');
            } else {
                throw new Error('Invalid data URL format');
            }
        } else if (attachment.path) {
            // Read from file
            if (!fs.existsSync(attachment.path)) {
                throw new Error(`File not found: ${attachment.path}`);
            }
            imageBuffer = fs.readFileSync(attachment.path);
            mimeType = this.getMimeType(attachment.path);
        } else {
            throw new Error('No image data or path provided');
        }

        // ============ TWO-STEP VISION ANALYSIS ============
        // Step 1: Extract user intent (text-only AI call)
        // Step 2: Use focused intent for vision analysis
        // ==================================================

        let visionDescription: string;
        let visionObjective: string;

        if (userPrompt && userPrompt.trim().length > 0) {
            // Step 1: Extract focused intent from user's prompt
            const extractedIntent = await this.extractUserIntent(userPrompt);

            if (extractedIntent) {
                // Step 2 will use the AI-extracted focused intent
                visionDescription = extractedIntent;
                visionObjective = `Analyze this image following these specific instructions: ${extractedIntent.substring(0, 300)}`;
                console.log('[AttachmentProcessor] Step 2: Running vision with AI-extracted intent');
            } else {
                // Fallback: intent extraction failed, use basic prompt
                console.log('[AttachmentProcessor] Intent extraction unavailable, using fallback vision prompt');
                const fallback = this.buildFallbackVisionPrompt(userPrompt);
                visionDescription = fallback.description;
                visionObjective = fallback.objective;
            }
        } else {
            // No user prompt at all - generic analysis
            const fallback = this.buildFallbackVisionPrompt('');
            visionDescription = fallback.description;
            visionObjective = fallback.objective;
        }

        // Try vision analysis with available clients (best-vision-first priority)
        let analysis: string | undefined;

        // Priority 1: Copilot Gemini Flash (best vision model)
        if (!analysis && this.copilotGeminiClient) {
            try {
                console.log('[AttachmentProcessor] Trying Copilot Gemini Flash for vision...');
                const result = await this.copilotGeminiClient.analyzeScreenshot(
                    imageBuffer,
                    mimeType,
                    visionDescription,
                    visionObjective
                );
                if (result && result.analysis) {
                    analysis = `**Image Analysis (${attachment.name}):**\n${result.analysis}`;
                    console.log('[AttachmentProcessor] Copilot Gemini Flash vision succeeded');
                }
            } catch (e: any) {
                console.log(`[AttachmentProcessor] Copilot Gemini vision failed: ${e.message}`);
            }
        }

        // Priority 2: Copilot Claude (good vision)
        if (!analysis && this.copilotClaudeClient) {
            try {
                console.log('[AttachmentProcessor] Trying Copilot Claude for vision...');
                const result = await this.copilotClaudeClient.analyzeScreenshot(
                    imageBuffer,
                    mimeType,
                    visionDescription,
                    visionObjective
                );
                if (result && result.analysis) {
                    analysis = `**Image Analysis (${attachment.name}):**\n${result.analysis}`;
                    console.log('[AttachmentProcessor] Copilot Claude vision succeeded');
                }
            } catch (e: any) {
                console.log(`[AttachmentProcessor] Copilot Claude vision failed: ${e.message}`);
            }
        }

        // Priority 3: Copilot GPT (decent vision)
        if (!analysis && this.copilotGPTClient) {
            try {
                console.log('[AttachmentProcessor] Trying Copilot GPT for vision...');
                const result = await this.copilotGPTClient.analyzeScreenshot(
                    imageBuffer,
                    mimeType,
                    visionDescription,
                    visionObjective
                );
                if (result && result.analysis) {
                    analysis = `**Image Analysis (${attachment.name}):**\n${result.analysis}`;
                    console.log('[AttachmentProcessor] Copilot GPT vision succeeded');
                }
            } catch (e: any) {
                console.log(`[AttachmentProcessor] Copilot GPT vision failed: ${e.message}`);
            }
        }

        // Priority 4: Gemini API (if available)
        if (!analysis && this.geminiApiClient) {
            try {
                console.log('[AttachmentProcessor] Trying Gemini API for vision...');
                const base64 = imageBuffer.toString('base64');
                const result = await this.geminiApiClient.analyzeScreenshot(
                    base64,
                    mimeType,
                    visionDescription,
                    visionObjective
                );
                if (result && result.analysis) {
                    analysis = `**Image Analysis (${attachment.name}):**\n${result.analysis}`;
                    console.log('[AttachmentProcessor] Gemini API vision succeeded');
                }
            } catch (e: any) {
                console.log(`[AttachmentProcessor] Gemini API vision failed: ${e.message}`);
            }
        }

        // Priority 5: Claude API (if available)
        if (!analysis && this.claudeApiClient) {
            try {
                console.log('[AttachmentProcessor] Trying Claude API for vision...');
                const base64 = imageBuffer.toString('base64');
                const result = await this.claudeApiClient.analyzeScreenshot(
                    base64,
                    mimeType,
                    visionDescription,
                    visionObjective
                );
                if (result && result.analysis) {
                    analysis = `**Image Analysis (${attachment.name}):**\n${result.analysis}`;
                    console.log('[AttachmentProcessor] Claude API vision succeeded');
                }
            } catch (e: any) {
                console.log(`[AttachmentProcessor] Claude API vision failed: ${e.message}`);
            }
        }

        return {
            name: attachment.name,
            type: 'image',
            originalPath: attachment.path,
            analysis: analysis || `Image attached: ${attachment.name} (vision analysis unavailable - no vision-capable model found)`
        };
    }

    /**
     * Process a document attachment by extracting text.
     */
    private async processDocument(attachment: Attachment): Promise<ProcessedAttachment> {
        let content: string;

        if (attachment.dataUrl) {
            // Extract content from data URL
            const base64Match = attachment.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
                const mimeType = base64Match[1];
                const data = Buffer.from(base64Match[2], 'base64');
                content = await this.extractText(data, mimeType, attachment.name);
            } else {
                throw new Error('Invalid data URL format');
            }
        } else if (attachment.path) {
            // Read from file
            if (!fs.existsSync(attachment.path)) {
                throw new Error(`File not found: ${attachment.path}`);
            }
            const data = fs.readFileSync(attachment.path);
            const mimeType = attachment.mimeType || this.getMimeType(attachment.path);
            content = await this.extractText(data, mimeType, attachment.name);
        } else {
            throw new Error('No document data or path provided');
        }

        return {
            name: attachment.name,
            type: 'document',
            originalPath: attachment.path,
            content: content ? `**Document: ${attachment.name}**\n\n${content}` : `Document attached: ${attachment.name} (content extraction failed)`
        };
    }

    /**
     * Extract text from document based on mime type.
     */
    private async extractText(data: Buffer, mimeType: string, filename: string): Promise<string> {
        // Plain text files
        if (mimeType.includes('text/') || filename.endsWith('.md') || filename.endsWith('.txt')) {
            return data.toString('utf-8');
        }

        // PDF files - basic extraction (full PDF parsing would need a library)
        if (mimeType.includes('pdf') || filename.endsWith('.pdf')) {
            // Simple approach: look for text between stream markers
            // For production, use pdf-parse or similar library
            const text = data.toString('utf-8', 0, Math.min(data.length, 100000));
            const cleanText = text.replace(/[^\x20-\x7E\n\r]/g, ' ').trim();
            if (cleanText.length > 100) {
                return `[PDF Content - First 10000 chars]\n${cleanText.substring(0, 10000)}`;
            }
            return `[PDF attached: ${filename}] - Binary content, please describe what this document contains.`;
        }

        // Word documents - basic approach
        if (mimeType.includes('word') || filename.endsWith('.doc') || filename.endsWith('.docx')) {
            // For .docx, could unzip and parse document.xml
            // Simple approach: extract any readable text
            const text = data.toString('utf-8', 0, Math.min(data.length, 100000));
            const cleanText = text.replace(/[^\x20-\x7E\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
            if (cleanText.length > 100) {
                return `[Word Document Content]\n${cleanText.substring(0, 10000)}`;
            }
            return `[Word document attached: ${filename}] - Please describe what this document contains.`;
        }

        // Default: return note about the file
        return `[File attached: ${filename}] (${mimeType}) - Content extraction not supported for this format.`;
    }

    /**
     * Get MIME type from file extension.
     */
    private getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.pdf': 'application/pdf',
            '.txt': 'text/plain',
            '.md': 'text/markdown',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        };
        return mimeTypes[ext] || 'application/octet-stream';
    }

    /**
     * Generate a context string from processed attachments.
     */
    generateContextString(processed: ProcessedAttachment[]): string {
        if (!processed || processed.length === 0) {
            return '';
        }

        const parts: string[] = [
            '\n\n---',
            '## User Attachments',
            ''
        ];

        for (const attachment of processed) {
            if (attachment.error) {
                parts.push(`### ${attachment.name} ⚠️`);
                parts.push(`Error: ${attachment.error}`);
            } else if (attachment.type === 'image' && attachment.analysis) {
                parts.push(attachment.analysis);
            } else if (attachment.content) {
                parts.push(attachment.content);
            }
            parts.push('');
        }

        parts.push('---\n');
        return parts.join('\n');
    }
}

// Singleton instance
let _attachmentProcessor: AttachmentProcessor | null = null;

export function getAttachmentProcessor(): AttachmentProcessor {
    if (!_attachmentProcessor) {
        _attachmentProcessor = new AttachmentProcessor();
    }
    return _attachmentProcessor;
}
