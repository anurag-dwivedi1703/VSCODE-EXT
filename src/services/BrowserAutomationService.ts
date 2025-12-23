import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

// Dynamic imports for optional dependencies - loaded on demand
let playwrightModule: any = null;
let playwrightAvailable: boolean | null = null;
let installationInProgress: boolean = false;

/**
 * Get the extension's installation directory
 */
function getExtensionDir(): string {
    // Try to find the extension directory from vscode.extensions
    const ext = vscode.extensions.getExtension('undefined_publisher.vibearchitect');
    if (ext) {
        return ext.extensionPath;
    }
    // Fallback: use __dirname to find the extension root
    // __dirname is typically in dist/, so go up one level
    return path.resolve(__dirname, '..');
}

/**
 * Install playwright-core in the extension directory
 */
async function installPlaywrightCore(): Promise<boolean> {
    if (installationInProgress) {
        vscode.window.showInformationMessage('Installation already in progress...');
        return false;
    }

    const extensionDir = getExtensionDir();

    return new Promise((resolve) => {
        installationInProgress = true;

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Installing browser automation dependencies...",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Running npm install playwright-core...' });

            return new Promise<void>((resolveProgress) => {
                const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
                const child = cp.spawn(npmCmd, ['install', 'playwright-core', '--save'], {
                    cwd: extensionDir,
                    shell: true
                });

                let stdout = '';
                let stderr = '';

                child.stdout?.on('data', (data) => {
                    stdout += data.toString();
                });

                child.stderr?.on('data', (data) => {
                    stderr += data.toString();
                });

                child.on('close', (code) => {
                    installationInProgress = false;

                    if (code === 0) {
                        vscode.window.showInformationMessage(
                            'Browser automation installed successfully! Please reload the window.',
                            'Reload Window'
                        ).then((selection) => {
                            if (selection === 'Reload Window') {
                                vscode.commands.executeCommand('workbench.action.reloadWindow');
                            }
                        });
                        resolve(true);
                    } else {
                        console.error('[BrowserAutomation] npm install failed:', stderr);
                        vscode.window.showErrorMessage(
                            `Failed to install browser automation: ${stderr || 'Unknown error'}. ` +
                            `Try manually: cd "${extensionDir}" && npm install playwright-core`
                        );
                        resolve(false);
                    }
                    resolveProgress();
                });

                child.on('error', (err) => {
                    installationInProgress = false;
                    console.error('[BrowserAutomation] npm spawn error:', err);
                    vscode.window.showErrorMessage(`Failed to run npm: ${err.message}`);
                    resolve(false);
                    resolveProgress();
                });
            });
        });
    });
}

/**
 * Prompt user to install playwright-core (non-blocking - fires and forgets)
 */
function triggerInstallPrompt(): void {
    // Show as information message with action button - don't await
    vscode.window.showWarningMessage(
        '🌐 Browser automation requires playwright-core to be installed.',
        'Install Now',
        'Dismiss'
    ).then(async (choice) => {
        if (choice === 'Install Now') {
            const success = await installPlaywrightCore();
            if (success) {
                vscode.window.showInformationMessage(
                    '✅ playwright-core installed! Reload VS Code to use browser automation.',
                    'Reload Now'
                ).then((action) => {
                    if (action === 'Reload Now') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            }
        }
    });
}

async function getPlaywright(): Promise<any> {
    if (playwrightModule) {
        return playwrightModule;
    }

    try {
        // Try dynamic import
        const pw = await import('playwright-core');

        // Debug: Log what we got
        console.log('[BrowserAutomation] playwright-core loaded, keys:', Object.keys(pw));

        // Handle different module structures
        // ESM: default export or named exports
        // CommonJS: direct exports
        if (pw.chromium) {
            playwrightModule = pw.chromium;
        } else if (pw.default?.chromium) {
            playwrightModule = pw.default.chromium;
        } else {
            // Log available properties for debugging
            console.error('[BrowserAutomation] Unexpected module structure:', JSON.stringify(Object.keys(pw)));
            throw new Error(`playwright-core loaded but chromium not found. Module keys: ${Object.keys(pw).join(', ')}`);
        }

        if (!playwrightModule || typeof playwrightModule.launch !== 'function') {
            throw new Error('playwright-core.chromium.launch is not a function');
        }

        playwrightAvailable = true;
        console.log('[BrowserAutomation] Successfully loaded playwright-core');
        return playwrightModule;

    } catch (error: any) {
        playwrightAvailable = false;
        console.error('[BrowserAutomation] Failed to load playwright-core:', error.message);

        // Check if it's a "module not found" error
        if (error.message.includes('Cannot find module') || error.code === 'MODULE_NOT_FOUND') {
            // Trigger non-blocking install prompt (user will see VS Code notification)
            triggerInstallPrompt();

            // Return immediately with instructions (this message will show in Mission Control)
            throw new Error(
                '⚠️ BROWSER AUTOMATION NOT INSTALLED\n\n' +
                '👉 A notification has appeared in VS Code (bottom-right).\n' +
                '   Click "Install Now" to automatically install playwright-core.\n\n' +
                '📦 Manual alternative: Run this in the extension folder:\n' +
                '   npm install playwright-core\n\n' +
                '🔄 After installing, reload VS Code window and try again.'
            );
        }

        // Other error - provide detailed info
        throw new Error(`Browser automation error: ${error.message}`);
    }
}

/**
 * Check if playwright is available without throwing
 */
export async function isPlaywrightAvailable(): Promise<boolean> {
    if (playwrightAvailable !== null) {
        return playwrightAvailable;
    }
    try {
        const pw = await import('playwright-core');
        playwrightAvailable = !!(pw.chromium || pw.default?.chromium);
        return playwrightAvailable;
    } catch {
        playwrightAvailable = false;
        return false;
    }
}

export interface ScreenshotResult {
    path: string;
    timestamp: number;
}

export interface RecordingResult {
    path: string;
    duration: number;
    timestamp: number;
}

export interface BrowserTestResult {
    success: boolean;
    screenshots: ScreenshotResult[];
    recording?: RecordingResult;
    errors: string[];
    domSnapshot?: string;
}

/**
 * BrowserAutomationService - Controls browser instances for automated UI testing
 * 
 * Features:
 * - Launch/close Chrome browser via Playwright
 * - Navigate to URLs
 * - Take screenshots
 * - Record video sessions (MP4 format)
 * - Interact with page elements (click, type)
 * - Capture DOM snapshots for AI analysis
 * 
 * NOTE: Dependencies are loaded dynamically to prevent extension activation failure
 */
export class BrowserAutomationService {
    private browser: any = null;
    private context: any = null;
    private page: any = null;
    private isRecording: boolean = false;
    private recordingStartTime: number = 0;
    private currentRecordingPath: string = '';

    constructor(
        private readonly taskId: string,
        private readonly workspacePath: string
    ) { }

    /**
     * Get the recordings directory path based on user settings or default
     */
    private getRecordingsDir(): string {
        const config = vscode.workspace.getConfiguration('vibearchitect');
        const customPath = config.get<string>('browserRecordingsPath');

        if (customPath && customPath.trim() !== '') {
            // Use custom path with taskId subfolder
            return path.join(customPath, this.taskId);
        }

        // Default: workspace/.vibearchitect/recordings/[taskId]
        return path.join(this.workspacePath, '.vibearchitect', 'recordings', this.taskId);
    }

    /**
     * Ensure the recordings directory exists
     */
    private ensureRecordingsDir(): string {
        const dir = this.getRecordingsDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    /**
     * Launch a new browser instance
     */
    async launchBrowser(recordVideo: boolean = false): Promise<string> {
        try {
            if (this.browser) {
                return 'Browser already running.';
            }

            // Dynamically load playwright
            const pw = await getPlaywright();

            // Find Chrome/Chromium executable
            const executablePath = await this.findChromePath(pw);
            if (!executablePath) {
                return 'Error: Chrome/Chromium not found. Please install Chrome or run "npm run install-browsers".';
            }

            this.browser = await pw.launch({
                headless: false, // Show browser for visual verification
                executablePath: executablePath,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            const contextOptions: any = {
                viewport: { width: 1280, height: 720 }
            };

            // Configure video recording if requested
            if (recordVideo) {
                const recordingsDir = this.ensureRecordingsDir();
                this.currentRecordingPath = recordingsDir;
                contextOptions.recordVideo = {
                    dir: recordingsDir,
                    size: { width: 1280, height: 720 }
                };
                this.isRecording = true;
                this.recordingStartTime = Date.now();
            }

            this.context = await this.browser.newContext(contextOptions);
            this.page = await this.context.newPage();

            return recordVideo
                ? `Browser launched with video recording. Recording to: ${this.currentRecordingPath}`
                : 'Browser launched successfully.';
        } catch (error: any) {
            return `Error launching browser: ${error.message}`;
        }
    }

    /**
     * Find Chrome executable path on the system
     */
    private async findChromePath(pw: any): Promise<string | undefined> {
        const possiblePaths = [
            // Windows
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
            // macOS
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            // Linux
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium'
        ];

        for (const chromePath of possiblePaths) {
            if (chromePath && fs.existsSync(chromePath)) {
                return chromePath;
            }
        }

        // Try to find via Playwright's bundled browser
        try {
            const browsers = pw.executablePath();
            if (fs.existsSync(browsers)) {
                return browsers;
            }
        } catch {
            // Playwright browser not installed
        }

        return undefined;
    }

    /**
     * Navigate to a URL
     */
    async navigateTo(url: string): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched. Call launchBrowser() first.';
        }

        try {
            await this.page.goto(url, { waitUntil: 'networkidle' });
            return `Navigated to: ${url}`;
        } catch (error: any) {
            return `Error navigating to ${url}: ${error.message}`;
        }
    }

    /**
     * Take a screenshot
     */
    async takeScreenshot(name?: string): Promise<ScreenshotResult | string> {
        if (!this.page) {
            return 'Error: Browser not launched. Call launchBrowser() first.';
        }

        try {
            const recordingsDir = this.ensureRecordingsDir();
            const timestamp = Date.now();
            const filename = name ? `${name}_${timestamp}.png` : `screenshot_${timestamp}.png`;
            const screenshotPath = path.join(recordingsDir, filename);

            await this.page.screenshot({
                path: screenshotPath,
                fullPage: true
            });

            return {
                path: screenshotPath,
                timestamp: timestamp
            };
        } catch (error: any) {
            return `Error taking screenshot: ${error.message}`;
        }
    }

    /**
     * Click on an element
     */
    async click(selector: string): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched. Call launchBrowser() first.';
        }

        try {
            await this.page.click(selector, { timeout: 5000 });
            return `Clicked on: ${selector}`;
        } catch (error: any) {
            return `Error clicking on ${selector}: ${error.message}`;
        }
    }

    /**
     * Type text into an element
     */
    async type(selector: string, text: string): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched. Call launchBrowser() first.';
        }

        try {
            await this.page.fill(selector, text);
            return `Typed "${text}" into: ${selector}`;
        } catch (error: any) {
            return `Error typing into ${selector}: ${error.message}`;
        }
    }

    /**
     * Wait for an element to appear
     */
    async waitForSelector(selector: string, timeout: number = 5000): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched. Call launchBrowser() first.';
        }

        try {
            await this.page.waitForSelector(selector, { timeout });
            return `Element found: ${selector}`;
        } catch (error: any) {
            return `Error waiting for ${selector}: ${error.message}`;
        }
    }

    /**
     * Get the current page's DOM content
     */
    async getPageContent(): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched. Call launchBrowser() first.';
        }

        try {
            const content = await this.page.content();
            // Truncate if too long for AI context
            const maxLength = 50000;
            if (content.length > maxLength) {
                return content.substring(0, maxLength) + '\n... [TRUNCATED]';
            }
            return content;
        } catch (error: any) {
            return `Error getting page content: ${error.message}`;
        }
    }

    /**
     * Get current page URL
     */
    async getCurrentUrl(): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }
        return this.page.url();
    }

    /**
     * Get page title
     */
    async getPageTitle(): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }
        return await this.page.title();
    }

    /**
     * Evaluate JavaScript in the page context
     */
    async evaluate(script: string): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }

        try {
            const result = await this.page.evaluate(script);
            return JSON.stringify(result, null, 2);
        } catch (error: any) {
            return `Error evaluating script: ${error.message}`;
        }
    }

    /**
     * Reload the current page
     */
    async reload(): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }

        try {
            await this.page.reload({ waitUntil: 'networkidle' });
            return 'Page reloaded successfully.';
        } catch (error: any) {
            return `Error reloading page: ${error.message}`;
        }
    }

    /**
     * Stop recording and close the browser
     */
    async closeBrowser(): Promise<RecordingResult | string> {
        try {
            let recordingResult: RecordingResult | undefined;

            if (this.context && this.isRecording) {
                // Close page first to finalize video
                if (this.page) {
                    await this.page.close();
                }

                // Get the video path
                const video = this.page?.video();
                if (video) {
                    const videoPath = await video.path();
                    const duration = Date.now() - this.recordingStartTime;

                    // Convert webm to mp4 if needed (Playwright records in webm by default)
                    // For now, we'll return the webm path - ffmpeg conversion could be added later
                    recordingResult = {
                        path: videoPath,
                        duration: duration,
                        timestamp: this.recordingStartTime
                    };
                }
            }

            if (this.context) {
                await this.context.close();
            }
            if (this.browser) {
                await this.browser.close();
            }

            this.page = null;
            this.context = null;
            this.browser = null;
            this.isRecording = false;
            this.recordingStartTime = 0;

            if (recordingResult) {
                return recordingResult;
            }
            return 'Browser closed successfully.';
        } catch (error: any) {
            return `Error closing browser: ${error.message}`;
        }
    }

    /**
     * Check if browser is currently running
     */
    isRunning(): boolean {
        return this.browser !== null && this.page !== null;
    }

    /**
     * Check if currently recording
     */
    isRecordingVideo(): boolean {
        return this.isRecording;
    }
}
