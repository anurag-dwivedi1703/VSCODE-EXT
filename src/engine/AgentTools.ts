import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { TerminalManager } from './TerminalManager';
import { GeminiClient } from '../ai/GeminiClient';
import { ClaudeClient } from '../ai/ClaudeClient';
import { CopilotClaudeClient } from '../ai/CopilotClaudeClient';
import { FileLockManager } from '../services/FileLockManager';
import { BrowserAutomationService, ScreenshotResult, RecordingResult } from '../services/BrowserAutomationService';
import { VisualComparisonService, ComparisonResult } from '../services/VisualComparisonService';
import { detectSecrets, detectPII, DetectedSecret, DetectedPII } from '../ai/SecurityInstructions';

export class AgentTools {
    private browserService: BrowserAutomationService | null = null;
    private visualService: VisualComparisonService | null = null;

    constructor(
        private readonly worktreeRoot: string,
        private readonly terminalManager?: TerminalManager,
        private readonly geminiClient?: GeminiClient,
        private readonly claudeClient?: ClaudeClient,
        private readonly copilotClaudeClient?: CopilotClaudeClient,
        private readonly onReloadBrowserCallback?: () => void,
        private readonly onNavigateBrowserCallback?: (url: string) => void,
        private readonly fileLockManager?: FileLockManager,
        private readonly taskId?: string
    ) {
        // Initialize browser automation services if taskId is available
        if (this.taskId) {
            this.browserService = new BrowserAutomationService(this.taskId, this.worktreeRoot);
            this.visualService = new VisualComparisonService(this.worktreeRoot, this.taskId);
        }
    }


    private getUri(relativePath: string): vscode.Uri {
        const fullPath = path.resolve(this.worktreeRoot, relativePath);
        if (!fullPath.startsWith(path.resolve(this.worktreeRoot))) {
            throw new Error(`Access Denied: Path '${relativePath}' traverses outside the workspace root.`);
        }
        return vscode.Uri.file(fullPath);
    }

    async readFile(relativePath: string): Promise<string> {
        try {
            const fileUri = this.getUri(relativePath);
            const uint8Array = await vscode.workspace.fs.readFile(fileUri);
            return new TextDecoder().decode(uint8Array);
        } catch (error: any) {
            return `Error reading file ${relativePath}: ${error.message}`;
        }
    }

    async writeFile(relativePath: string, content: string): Promise<string> {
        try {
            const fileUri = this.getUri(relativePath);
            const absolutePath = fileUri.fsPath;

            // ==================== SECURITY CHECKS ====================
            const securityWarnings: string[] = [];
            const isEnvFile = relativePath.endsWith('.env') || relativePath.includes('.env.');
            // Check if this is a text-based file that should be scanned for PII
            // Includes source code, config files, data files, and files without extensions
            const isTextFile = /\.(js|ts|jsx|tsx|py|rb|java|go|rs|php|cs|cpp|c|h|txt|json|yaml|yml|xml|md|csv|sql|html|htm|css|scss|less|sh|bat|ps1|cfg|conf|ini|log|env)$/i.test(relativePath) ||
                !relativePath.includes('.'); // Files without extensions are often text

            // Detect secrets in content (warn but allow for prototyping)
            const detectedSecrets = detectSecrets(content);
            console.log(`[Security] File: ${relativePath}, isEnvFile: ${isEnvFile}, isTextFile: ${isTextFile}, secrets: ${detectedSecrets.length}`);
            if (detectedSecrets.length > 0 && !isEnvFile) {
                securityWarnings.push(`⚠️ SECURITY WARNING: Detected ${detectedSecrets.length} potential secret(s) in ${relativePath}:`);
                for (const secret of detectedSecrets.slice(0, 3)) { // Limit to first 3
                    securityWarnings.push(`  - ${secret.type} at line ${secret.line}: ${secret.suggestion}`);
                }
                if (detectedSecrets.length > 3) {
                    securityWarnings.push(`  ... and ${detectedSecrets.length - 3} more`);
                }
                securityWarnings.push(`  💡 TIP: Use environment variables instead of hardcoding secrets.`);
            }

            // Detect PII in text-based files
            if (isTextFile) {
                const detectedPII = detectPII(content);
                console.log(`[Security] PII detection: ${detectedPII.length} items found`);
                detectedPII.forEach(pii => console.log(`  - ${pii.type}: ${pii.match}`));
                const highSeverityPII = detectedPII.filter(p => p.severity === 'high');
                if (highSeverityPII.length > 0) {
                    securityWarnings.push(`⚠️ PII WARNING: Detected sensitive personal data in ${relativePath}:`);
                    for (const pii of highSeverityPII.slice(0, 3)) {
                        securityWarnings.push(`  - ${pii.type} at line ${pii.line}: Use ${pii.maskExample} for testing`);
                    }
                }
            } else {
                console.log(`[Security] Skipping PII check - not a text file: ${relativePath}`);
            }
            console.log(`[Security] Total warnings: ${securityWarnings.length}`);

            // ==================== .ENV FILE HANDLING ====================
            let envExampleCreated = false;
            let gitignoreUpdated = false;

            if (isEnvFile && relativePath.endsWith('.env')) {
                // Auto-create .env.example with placeholder values
                try {
                    const envExampleContent = this.generateEnvExample(content);
                    const envExamplePath = relativePath.replace(/\.env$/, '.env.example');
                    const envExampleUri = this.getUri(envExamplePath);

                    // Check if .env.example already exists
                    try {
                        await vscode.workspace.fs.stat(envExampleUri);
                    } catch {
                        // File doesn't exist, create it
                        const exampleUint8 = new TextEncoder().encode(envExampleContent);
                        await vscode.workspace.fs.writeFile(envExampleUri, exampleUint8);
                        envExampleCreated = true;
                    }
                } catch (e) {
                    // Ignore errors creating .env.example
                }

                // Auto-update .gitignore to exclude .env
                try {
                    gitignoreUpdated = await this.ensureGitignoreExcludes('.env');
                } catch (e) {
                    // Ignore errors updating .gitignore
                }
            }

            // ==================== ORIGINAL FILE WRITE ====================
            // Enforce Locking
            if (this.fileLockManager && this.taskId) {
                if (!this.fileLockManager.acquireLock(absolutePath, this.taskId)) {
                    return `Error: File ${relativePath} is currently locked by another agent. Please wait.`;
                }
            }

            try {
                const uint8Array = new TextEncoder().encode(content);
                const parentDir = vscode.Uri.file(path.dirname(path.join(this.worktreeRoot, relativePath)));
                await vscode.workspace.fs.createDirectory(parentDir);

                await vscode.workspace.fs.writeFile(fileUri, uint8Array);

                // Build response with security info
                let response = `Successfully wrote to ${relativePath}`;
                if (envExampleCreated) {
                    response += `\n✅ Auto-created .env.example with placeholder values`;
                }
                if (gitignoreUpdated) {
                    response += `\n✅ Added .env to .gitignore`;
                }
                if (securityWarnings.length > 0) {
                    response += `\n\n${securityWarnings.join('\n')}`;
                }
                return response;
            } finally {
                // Always release lock
                if (this.fileLockManager && this.taskId) {
                    this.fileLockManager.releaseLock(absolutePath, this.taskId);
                }
            }
        } catch (error: any) {
            return `Error writing file ${relativePath}: ${error.message}`;
        }
    }

    /**
     * Generate .env.example content from .env content by replacing values with placeholders
     */
    private generateEnvExample(envContent: string): string {
        const lines = envContent.split('\n');
        const exampleLines = lines.map(line => {
            // Keep comments and empty lines
            if (line.trim().startsWith('#') || line.trim() === '') {
                return line;
            }
            // Replace values with placeholders
            const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (match) {
                const [, key, value] = match;
                const placeholder = this.getPlaceholderForEnvKey(key, value);
                return `${key}=${placeholder}`;
            }
            return line;
        });
        return exampleLines.join('\n');
    }

    /**
     * Get appropriate placeholder for an environment variable key
     */
    private getPlaceholderForEnvKey(key: string, value: string): string {
        const keyLower = key.toLowerCase();
        if (keyLower.includes('key') || keyLower.includes('secret') || keyLower.includes('token')) {
            return `your_${keyLower}_here`;
        }
        if (keyLower.includes('password') || keyLower.includes('passwd') || keyLower.includes('pwd')) {
            return 'your_password_here';
        }
        if (keyLower.includes('database') || keyLower.includes('db_url') || keyLower.includes('connection')) {
            return 'your_connection_string_here';
        }
        if (keyLower.includes('url') || keyLower.includes('host') || keyLower.includes('endpoint')) {
            return 'https://your-service-url.com';
        }
        if (keyLower.includes('port')) {
            return value; // Keep port numbers as-is
        }
        // Default placeholder
        return `your_${keyLower}_here`;
    }

    /**
     * Ensure .gitignore contains the specified pattern
     */
    private async ensureGitignoreExcludes(pattern: string): Promise<boolean> {
        const gitignorePath = '.gitignore';
        const gitignoreUri = this.getUri(gitignorePath);

        let content = '';
        try {
            const uint8Array = await vscode.workspace.fs.readFile(gitignoreUri);
            content = new TextDecoder().decode(uint8Array);
        } catch {
            // .gitignore doesn't exist, create it
            content = '# Environment files\n';
        }

        // Check if pattern already exists
        const lines = content.split('\n');
        if (lines.some(line => line.trim() === pattern || line.trim() === pattern + '/')) {
            return false; // Already excluded
        }

        // Add the pattern
        const newContent = content.trimEnd() + '\n' + pattern + '\n';
        const uint8Array = new TextEncoder().encode(newContent);
        await vscode.workspace.fs.writeFile(gitignoreUri, uint8Array);
        return true;
    }

    async listFiles(relativePath: string): Promise<string> {
        try {
            const dirUri = this.getUri(relativePath);
            const entries = await vscode.workspace.fs.readDirectory(dirUri);
            const formatted = entries.map(([name, type]) => {
                const typeName = type === vscode.FileType.Directory ? 'DIR' : 'FILE';
                return `${typeName}\t${name}`;
            }).join('\n');
            return formatted || '(Empty Directory)';
        } catch (error: any) {
            return `Error listing directory ${relativePath}: ${error.message}`;
        }
    }

    async searchWeb(query: string): Promise<string> {
        // Try Gemini first, then Claude API, then Copilot Claude
        if (this.geminiClient) {
            return await this.geminiClient.research(query);
        } else if (this.claudeClient) {
            return await this.claudeClient.research(query);
        } else if (this.copilotClaudeClient) {
            return await this.copilotClaudeClient.research(query);
        }
        return "Error: No AI client available for web search. Configure either Gemini or Claude API key.";
    }

    async reload_browser(): Promise<string> {
        // We need a way to signal the UI to reload. 
        // This tool instance doesn't have direct access to the TaskRunner's event emitter.
        // However, we can use vscode.commands to broadcast a signal? 
        // Or better, we can inject a callback or the event emitter into AgentTools.

        // LIMITATION: For this iteration, we will implement it by triggering a workspace command 
        // that the MissionControlProvider listens to, OR we simply return a message saying 
        // "Browser Reloaded (Visual Verification Required by User)".

        // Wait! The TaskRunner passes `this.onReloadBrowser` event... no, it doesn't pass it to AgentTools.
        // Let's check how AgentTools is instantiated. 

        // Ideally, AgentTools should emit an event. 
        // For now, let's just return a placeholder and we fix the wiring in TaskRunner.

        // EDIT: I will add a callback to the constructor for `onReloadBrowser`.
        if (this.onReloadBrowserCallback) {
            this.onReloadBrowserCallback();
            return "Browser Preview Reloaded. Please check the visual output.";
        }
        return "Browser Reload Triggered (Simulated).";
    }

    async navigate_browser(url: string): Promise<string> {
        if (this.onNavigateBrowserCallback) {
            this.onNavigateBrowserCallback(url);
            return `Browser navigated to ${url}. Please check the visual output.`;
        }
        return `Browser navigation to ${url} triggered (Simulated).`;
    }

    async runCommand(command: string): Promise<string> {
        return new Promise((resolve) => {
            // Basic safety check
            if (command.includes('rm -rf /') || command.includes('format c:')) {
                resolve('Error: Command blocked for safety reasons.');
                return;
            }

            // Show Terminal
            if (this.terminalManager) {
                this.terminalManager.show();
                this.terminalManager.print(`\x1b[36m> ${command}\x1b[0m\n`); // Cyan prompt
            }

            // Detect background execution request
            const isBackground = command.trim().endsWith('&');

            // Spawn Process
            const child = cp.spawn(command, {
                cwd: this.worktreeRoot,
                shell: true
            });

            // 1. TIMEOUT LOGIC
            // If not background, force resolve after 15 seconds to prevent hanging (e.g., interactive 'date' command)
            if (!isBackground) {
                setTimeout(() => {
                    if (!resolved) {
                        child.kill(); // Kill the stuck process
                        combinedOutput += "\n[System]: Command timed out after 15s. It may have been waiting for input.";
                        safeResolve(combinedOutput);
                    }
                }, 15000);
            }

            // 2. PREVENT INTERACTIVE HANGS
            // Immediately end stdin so commands waiting for input (like 'date') fail or exit instead of hanging
            child.stdin.end();

            let combinedOutput = '';
            let resolved = false;

            const safeResolve = (msg: string) => {
                if (!resolved) {
                    resolved = true;
                    resolve(msg);
                }
            };

            child.stdout.on('data', (data) => {
                const text = data.toString();
                combinedOutput += text;
                if (this.terminalManager) this.terminalManager.print(text);
            });

            child.stderr.on('data', (data) => {
                const text = data.toString();
                combinedOutput += text;
                if (this.terminalManager) this.terminalManager.print(`\x1b[31m${text}\x1b[0m`); // Red for error
            });

            child.on('close', (code) => {
                if (!resolved) {
                    if (code !== 0) {
                        combinedOutput += `\n(Process exited with code ${code})`;
                    }
                    safeResolve(combinedOutput || '(No Output)');
                }
            });

            child.on('error', (err) => {
                const errorMsg = `Error spawning process: ${err.message}`;
                combinedOutput += errorMsg;
                if (this.terminalManager) this.terminalManager.print(`\x1b[31m${errorMsg}\x1b[0m\n`);
                safeResolve(combinedOutput);
            });

            // If background, resolve early to prevent blocking
            if (isBackground) {
                setTimeout(() => {
                    child.unref();
                    safeResolve(`(Background Process Started) Output so far:\n${combinedOutput}`);
                }, 2000); // Wait 2s to catch immediate startup errors
            }
        });
    }

    private splitCommand(command: string): string[] {
        // Very basic splitter, shell: true handles the heavy lifting usually
        // But for spawn(cmd, args), usually we pass command string with shell:true
        // Logic above uses shell:true so 'command' as string is fine.
        return [command];
    }

    // ==================== BROWSER AUTOMATION TOOLS ====================

    /**
     * Launch browser with optional video recording
     */
    async browserLaunch(recordVideo: boolean = false): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized. Task ID required.';
        }
        return await this.browserService.launchBrowser(recordVideo);
    }

    /**
     * Navigate browser to a URL
     */
    async browserNavigate(url: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.navigateTo(url);
    }

    /**
     * Take a screenshot of the current page
     */
    async browserScreenshot(name?: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        const result = await this.browserService.takeScreenshot(name);
        if (typeof result === 'string') {
            return result; // Error message
        }
        return `Screenshot saved: ${result.path}`;
    }

    /**
     * Click on an element
     */
    async browserClick(selector: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.click(selector);
    }

    /**
     * Type text into an element
     */
    async browserType(selector: string, text: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.type(selector, text);
    }

    /**
     * Wait for an element to appear
     */
    async browserWaitFor(selector: string, timeout?: number): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.waitForSelector(selector, timeout);
    }

    /**
     * Get the current page's DOM content
     */
    async browserGetDOM(): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.getPageContent();
    }

    /**
     * Reload the current page
     */
    async browserReload(): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.reload();
    }

    /**
     * Evaluate JavaScript in the page
     */
    async browserEvaluate(script: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.evaluate(script);
    }

    /**
     * Close the browser and stop recording
     */
    async browserClose(): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        const result = await this.browserService.closeBrowser();
        if (typeof result === 'string') {
            return result;
        }
        return `Browser closed. Recording saved: ${result.path} (${Math.round(result.duration / 1000)}s)`;
    }

    /**
     * Verify UI by taking a screenshot and using Gemini Vision to analyze
     * whether it matches the expected description and mission objective.
     * This is the core of the self-healing system.
     */
    async browserVerifyUI(category: string, description: string, missionObjective?: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }

        try {
            // Take current screenshot
            const screenshotResult = await this.browserService.takeScreenshot(`verify_${category}`);
            if (typeof screenshotResult === 'string') {
                return screenshotResult; // Error
            }

            // Read the screenshot file for vision analysis
            const fs = await import('fs');
            const screenshotBuffer = fs.readFileSync(screenshotResult.path);
            const screenshotBase64 = screenshotBuffer.toString('base64');

            // Vision analysis priority:
            // 1. Gemini (best vision quality) - use passed client or create on-demand
            // 2. Claude API (good vision)
            // 3. Copilot Claude (fallback - no actual vision support)
            let analysis: {
                matches: boolean;
                confidence: number;
                issues: string[];
                suggestions: string[];
                analysis: string;
            } | null = null;

            // Try Gemini first - if not passed, try to create one from API key
            let visionClient = this.geminiClient;
            if (!visionClient) {
                // Try to create a temporary Gemini client for vision analysis
                const config = vscode.workspace.getConfiguration('vibearchitect');
                const geminiApiKey = config.get<string>('geminiApiKey') || '';
                if (geminiApiKey) {
                    const { GeminiClient } = await import('../ai/GeminiClient');
                    visionClient = new GeminiClient(geminiApiKey, 'gemini-2.0-flash');
                    console.log('[AgentTools] Created on-demand Gemini client for vision analysis');
                }
            }

            if (visionClient) {
                analysis = await visionClient.analyzeScreenshot(
                    screenshotBase64,
                    'image/png',
                    description,
                    missionObjective || 'Verify the UI looks correct'
                );
            } else if (this.claudeClient) {
                analysis = await this.claudeClient.analyzeScreenshot(
                    screenshotBase64,
                    'image/png',
                    description,
                    missionObjective || 'Verify the UI looks correct'
                );
            } else if (this.copilotClaudeClient) {
                // Copilot Claude can't do vision - provide helpful fallback
                analysis = await this.copilotClaudeClient.analyzeScreenshot(
                    screenshotBase64,
                    'image/png',
                    description,
                    missionObjective || 'Verify the UI looks correct'
                );
            }

            if (analysis) {
                // Build detailed result for the agent
                let result = `\n=== UI VERIFICATION: "${category}" ===\n`;
                result += `📊 VERDICT: ${analysis.matches ? '✅ PASS' : '❌ FAIL'}\n`;
                result += `🎯 Confidence: ${analysis.confidence}%\n\n`;

                result += `📝 Analysis:\n${analysis.analysis}\n\n`;

                if (analysis.issues.length > 0) {
                    result += `⚠️ Issues Found:\n`;
                    analysis.issues.forEach((issue, i) => {
                        result += `  ${i + 1}. ${issue}\n`;
                    });
                    result += '\n';
                }

                if (analysis.suggestions.length > 0) {
                    result += `💡 Suggested Fixes:\n`;
                    analysis.suggestions.forEach((suggestion, i) => {
                        result += `  ${i + 1}. ${suggestion}\n`;
                    });
                    result += '\n';
                }

                result += `📸 Screenshot: ${screenshotResult.path}\n`;
                result += `🎯 Expected: ${description}\n`;

                if (!analysis.matches) {
                    result += `\n🔧 ACTION REQUIRED: Please fix the issues above and call browser_verify_ui again to confirm the fix worked.\n`;
                }

                // Also do pixel comparison if visual service available and baseline exists
                if (this.visualService && this.visualService.hasBaseline(category)) {
                    const comparison = await this.visualService.compareAgainstBaseline(
                        screenshotResult.path,
                        category
                    );
                    if (comparison) {
                        result += `\n📐 Pixel Comparison: ${comparison.diffPercentage}% different from baseline`;
                        if (comparison.diffImagePath) {
                            result += ` (diff: ${comparison.diffImagePath})`;
                        }
                        result += '\n';
                    }
                } else if (this.visualService) {
                    // Save as new baseline
                    await this.visualService.saveBaseline(screenshotResult.path, category);
                    result += `\n📌 Saved as baseline for future comparisons.\n`;
                }

                return result;
            } else {
                // Fallback: Basic analysis without vision AI
                let result = `UI Verification for "${category}":\n`;
                result += `- Screenshot taken: ${screenshotResult.path}\n`;
                result += `- Expected: ${description}\n`;
                result += `- Note: No AI vision available for semantic analysis. `;
                result += `Please visually inspect the screenshot.\n`;

                if (this.visualService) {
                    const issues = await this.visualService.analyzeScreenshotForIssues(screenshotResult.path);
                    if (issues.length > 0) {
                        result += `- Basic issues detected:\n  ${issues.join('\n  ')}\n`;
                    }
                }

                return result;
            }
        } catch (error: any) {
            return `Error during UI verification: ${error.message}`;
        }
    }

    /**
     * Check if browser is currently running
     */
    isBrowserRunning(): boolean {
        return this.browserService?.isRunning() ?? false;
    }

    /**
     * Check if currently recording video
     */
    isBrowserRecording(): boolean {
        return this.browserService?.isRecordingVideo() ?? false;
    }
}
