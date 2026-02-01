/**
 * AttachmentProcessor.ts
 * Processes user attachments (images, documents) for context enrichment.
 * 
 * - Images: Analyzed via vision APIs (Copilot Claude, Gemini, Claude)
 * - Documents: Text extracted for context
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CopilotClaudeClient } from '../ai/CopilotClaudeClient';
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
 * Process attachments and generate context-enriched descriptions.
 */
export class AttachmentProcessor {
    private copilotClaudeClient?: CopilotClaudeClient;
    private claudeClient?: ClaudeClient;
    private geminiClient?: GeminiClient;

    constructor() {
        // Clients are initialized on-demand when needed
    }

    /**
     * Initialize AI clients for vision analysis
     */
    private async initializeClients(): Promise<void> {
        const config = vscode.workspace.getConfiguration('vibearchitect');

        // Try to initialize Copilot Claude
        if (!this.copilotClaudeClient) {
            try {
                this.copilotClaudeClient = new CopilotClaudeClient();
                await this.copilotClaudeClient.initialize();
                console.log('[AttachmentProcessor] Copilot Claude initialized');
            } catch (e: any) {
                console.log(`[AttachmentProcessor] Copilot Claude unavailable: ${e.message}`);
            }
        }

        // Try to initialize Gemini if API key available
        if (!this.geminiClient) {
            const geminiApiKey = config.get<string>('geminiApiKey') || '';
            if (geminiApiKey) {
                this.geminiClient = new GeminiClient(geminiApiKey, 'gemini-2.0-flash');
                console.log('[AttachmentProcessor] Gemini initialized');
            }
        }

        // Try to initialize Claude if API key available
        if (!this.claudeClient) {
            const claudeApiKey = config.get<string>('claudeApiKey') || '';
            if (claudeApiKey) {
                this.claudeClient = new ClaudeClient(claudeApiKey, 'claude-3-5-sonnet-20241022');
                console.log('[AttachmentProcessor] Claude initialized');
            }
        }
    }

    /**
     * Process all attachments and return enriched context.
     */
    async processAttachments(attachments: Attachment[]): Promise<ProcessedAttachment[]> {
        if (!attachments || attachments.length === 0) {
            return [];
        }

        await this.initializeClients();

        const results: ProcessedAttachment[] = [];

        for (const attachment of attachments) {
            try {
                if (attachment.type === 'image') {
                    const result = await this.processImage(attachment);
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
     * Process an image attachment using vision APIs.
     */
    private async processImage(attachment: Attachment): Promise<ProcessedAttachment> {
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

        // Try vision analysis with available clients
        let analysis: string | undefined;

        // Priority 1: Copilot Claude (most accessible)
        if (!analysis && this.copilotClaudeClient) {
            try {
                const result = await this.copilotClaudeClient.analyzeScreenshot(
                    imageBuffer,
                    mimeType,
                    'Analyze this image attached by the user. Describe what you see in detail - UI elements, layout, colors, text, icons, and any design patterns. This is a reference image for a feature request.',
                    'Extract relevant information from this reference image to help implement the user\'s feature request.'
                );
                if (result && result.analysis) {
                    analysis = `**Image Analysis (${attachment.name}):**\n${result.analysis}`;
                }
            } catch (e: any) {
                console.log(`[AttachmentProcessor] Copilot Claude vision failed: ${e.message}`);
            }
        }

        // Priority 2: Gemini (excellent vision)
        if (!analysis && this.geminiClient) {
            try {
                const base64 = imageBuffer.toString('base64');
                const result = await this.geminiClient.analyzeScreenshot(
                    base64,
                    mimeType,
                    'Analyze this image attached by the user. Describe UI elements, layout, colors, text, icons, and design patterns. This is a reference image for a feature request.',
                    'Extract information from this reference image for implementation.'
                );
                if (result && result.analysis) {
                    analysis = `**Image Analysis (${attachment.name}):**\n${result.analysis}`;
                }
            } catch (e: any) {
                console.log(`[AttachmentProcessor] Gemini vision failed: ${e.message}`);
            }
        }

        // Priority 3: Claude API
        if (!analysis && this.claudeClient) {
            try {
                const base64 = imageBuffer.toString('base64');
                const result = await this.claudeClient.analyzeScreenshot(
                    base64,
                    mimeType,
                    'Analyze this image attached by the user. Describe UI elements, layout, colors, text, icons, and design patterns. This is a reference image for a feature request.',
                    'Extract information from this reference image for implementation.'
                );
                if (result && result.analysis) {
                    analysis = `**Image Analysis (${attachment.name}):**\n${result.analysis}`;
                }
            } catch (e: any) {
                console.log(`[AttachmentProcessor] Claude vision failed: ${e.message}`);
            }
        }

        return {
            name: attachment.name,
            type: 'image',
            originalPath: attachment.path,
            analysis: analysis || `Image attached: ${attachment.name} (vision analysis unavailable - no API configured)`
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
