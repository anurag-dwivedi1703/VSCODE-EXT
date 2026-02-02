/**
 * BrowserAutomationService - Controls browser instances for automated UI testing
 * 
 * This module provides robust browser automation with:
 * - Smart browser detection and automatic Chromium download
 * - Selective session management (auth cookies separated from UI cache)
 * - Intelligent page load validation with retry logic
 * - Health monitoring and zombie process cleanup
 * 
 * NOTE: Dependencies (playwright-core) are loaded dynamically
 * 
 * @module BrowserAutomationService
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getBrowserManager, BrowserInfo, LaunchOptions } from './BrowserManager';
import { getSessionStorageManager, SavedSession } from './SessionStorageManager';
import { createPageLoadValidator, PageLoadValidator, NavigateOptions, PageLoadResult, WaitStrategy } from './PageLoadValidator';
import { AuthSessionManager } from './AuthSessionManager';

// ============================================
// TYPES
// ============================================

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

export interface BrowserLaunchOptions {
    /** Show browser window (default: true) */
    headless?: boolean;
    /** Record video of session */
    recordVideo?: boolean;
    /** Load saved session for domain */
    sessionDomain?: string;
    /** Start with fresh session (no cookies/cache) */
    freshSession?: boolean;
    /** Disable cache completely */
    disableCache?: boolean;
    /** Custom viewport size */
    viewport?: { width: number; height: number };
    /** Slow down operations by X ms */
    slowMo?: number;
}

export interface NavigationResult {
    success: boolean;
    url: string;
    loadTime: number;
    retryCount: number;
    error?: string;
    authRequired?: boolean;
    screenshotPath?: string;
}

// ============================================
// BROWSER AUTOMATION SERVICE CLASS
// ============================================

/**
 * Callback for requesting login checkpoint from TaskRunner
 */
export type LoginCheckpointCallback = (taskId: string, loginUrl: string, ssoProvider?: string) => Promise<boolean>;

/**
 * BrowserAutomationService - Main class for browser automation
 */
export class BrowserAutomationService {
    private browser: any = null;
    private context: any = null;
    private page: any = null;
    private pageValidator: PageLoadValidator | null = null;
    private isRecording: boolean = false;
    private recordingStartTime: number = 0;
    private currentRecordingPath: string = '';
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private currentBrowserInfo: BrowserInfo | null = null;

    private readonly browserManager = getBrowserManager();
    private readonly sessionManager = getSessionStorageManager();
    private readonly authManager: AuthSessionManager;
    
    // Login checkpoint callback - set by TaskRunner/AgentTools
    private loginCheckpointCallback: LoginCheckpointCallback | null = null;

    constructor(
        private readonly taskId: string,
        private readonly workspacePath: string
    ) {
        this.authManager = AuthSessionManager.getInstance();
    }
    
    /**
     * Set the callback for requesting login checkpoints.
     * This is called by AgentTools when creating the service.
     */
    setLoginCheckpointCallback(callback: LoginCheckpointCallback) {
        this.loginCheckpointCallback = callback;
    }

    // ============================================
    // RECORDINGS DIRECTORY
    // ============================================

    /**
     * Get the recordings directory path
     */
    private getRecordingsDir(): string {
        const config = vscode.workspace.getConfiguration('vibearchitect');
        const customPath = config.get<string>('browserRecordingsPath');

        if (customPath && customPath.trim() !== '') {
            return path.join(customPath, this.taskId);
        }

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

    // ============================================
    // BROWSER LAUNCH
    // ============================================

    /**
     * Launch browser with smart configuration
     */
    async launchBrowser(options: BrowserLaunchOptions = {}): Promise<string> {
        try {
            if (this.browser) {
                return 'Browser already running. Close it first or use the existing instance.';
            }

            const {
                headless = false,
                recordVideo = false,
                sessionDomain,
                freshSession = false,
                disableCache = false,
                viewport = { width: 1280, height: 720 },
                slowMo
            } = options;

            // Check if playwright is available
            const isAvailable = await this.browserManager.isPlaywrightAvailable();
            if (!isAvailable) {
                return this.getPlaywrightInstallMessage();
            }

            // Launch browser using BrowserManager
            const launchOptions: LaunchOptions = {
                headless,
                slowMo,
                timeout: 30000,
                args: disableCache ? ['--disk-cache-size=0'] : undefined
            };

            let launchResult;
            try {
                launchResult = await this.browserManager.launchBrowser(launchOptions);
            } catch (launchError: any) {
                console.error('[BrowserAutomation] Launch error:', launchError);
                return `Failed to launch browser: ${launchError.message}`;
            }
            
            if (!launchResult) {
                return 'Failed to launch browser. Please run the browser setup wizard.';
            }

            if (!launchResult.browser) {
                return 'Browser launch returned null browser object. Please check browser setup.';
            }

            this.browser = launchResult.browser;
            this.currentBrowserInfo = launchResult.browserInfo;

            // Build context options
            const contextOptions: any = {
                viewport,
                ignoreHTTPSErrors: true,
                bypassCSP: true // Helps with some problematic pages
            };

            // Configure video recording
            if (recordVideo) {
                const recordingsDir = this.ensureRecordingsDir();
                this.currentRecordingPath = recordingsDir;
                contextOptions.recordVideo = {
                    dir: recordingsDir,
                    size: viewport
                };
                this.isRecording = true;
                this.recordingStartTime = Date.now();
            }

            // Load session if requested (and not fresh session)
            if (!freshSession && sessionDomain) {
                const session = this.sessionManager.getSessionForDomain(sessionDomain);
                if (session) {
                    const sessionState = await this.sessionManager.loadSession(session.id);
                    if (sessionState) {
                        contextOptions.storageState = sessionState;
                        console.log(`[BrowserAutomation] Loaded session for ${sessionDomain}`);
                    }
                }
            }

            // Create context and page
            this.context = await this.browser.newContext(contextOptions);
            this.page = await this.context.newPage();

            // Create page validator
            this.pageValidator = createPageLoadValidator(this.page, this.context);

            // Start health monitoring
            this.heartbeatInterval = this.browserManager.startHeartbeat(this.browser, 10000);

            // Build success message
            let message = `✅ Browser launched: ${this.currentBrowserInfo.name}`;
            if (this.currentBrowserInfo.version) {
                message += ` (v${this.currentBrowserInfo.version})`;
            }
            if (recordVideo) {
                message += `\n📹 Recording to: ${this.currentRecordingPath}`;
            }
            if (!freshSession && sessionDomain) {
                message += `\n🔐 Session loaded for: ${sessionDomain}`;
            }
            if (freshSession) {
                message += `\n🆕 Fresh session (no cached data)`;
            }

            return message;

        } catch (error: any) {
            console.error('[BrowserAutomation] Launch failed:', error);
            return `❌ Failed to launch browser: ${error.message}`;
        }
    }

    /**
     * Get playwright installation instructions
     */
    private getPlaywrightInstallMessage(): string {
        return `⚠️ BROWSER AUTOMATION NOT AVAILABLE

playwright-core is required but not installed.

👉 Quick fix:
   1. Open VS Code terminal
   2. Navigate to extension folder
   3. Run: npm install playwright-core

📦 Or use the setup wizard:
   Command Palette → "VibeArchitect: Browser Setup"

🔄 After installing, reload VS Code and try again.`;
    }

    // ============================================
    // NAVIGATION
    // ============================================

    /**
     * Navigate to URL with smart waiting and retry
     */
    async navigateTo(
        url: string,
        options: {
            bypassCache?: boolean;
            waitForSelector?: string;
            timeout?: number;
        } = {}
    ): Promise<NavigationResult> {
        if (!this.page || !this.pageValidator) {
            return {
                success: false,
                url: url,
                loadTime: 0,
                retryCount: 0,
                error: 'Browser not launched. Call launchBrowser() first.'
            };
        }

        const { bypassCache = false, waitForSelector, timeout = 30000 } = options;

        try {
            // Build wait strategy
            const waitStrategy: WaitStrategy = {
                waitForDom: true,
                networkQuietMs: 500,
                waitForJsIdle: true,
                timeout,
                waitForSelectors: waitForSelector ? [waitForSelector] : undefined
            };

            // Navigate with validation
            const navOptions: NavigateOptions = {
                url,
                waitStrategy,
                bypassCache,
                screenshotOnFailure: true,
                screenshotDir: this.getRecordingsDir(),
                retryConfig: {
                    maxRetries: 3,
                    initialDelay: 1000,
                    maxDelay: 5000,
                    backoffMultiplier: 2,
                    strategies: ['refresh', 'hard-refresh', 'clear-cache']
                }
            };

            const result = await this.pageValidator.navigateWithValidation(navOptions);

            // Check if we landed on a login page
            const currentUrl = this.page.url();
            if (this.authManager.isLoginPage(currentUrl)) {
                console.log(`[BrowserAutomation] Login page detected: ${currentUrl}`);

                // Use the login checkpoint callback if available (preferred method)
                // This shows a clear button in the chat UI and waits indefinitely
                const ssoProvider = this.authManager.getSsoProvider(currentUrl) || undefined;
                let userConfirmed = false;
                
                if (this.loginCheckpointCallback) {
                    console.log('[BrowserAutomation] Using login checkpoint callback...');
                    userConfirmed = await this.loginCheckpointCallback(this.taskId, currentUrl, ssoProvider);
                } else {
                    // Fallback to VS Code notification if callback not set
                    console.log('[BrowserAutomation] Falling back to VS Code notification...');
                    const authResult = await this.authManager.promptUserForAuth(currentUrl);
                    userConfirmed = authResult === 'completed';
                }

                if (userConfirmed) {
                    // User clicked "I've Logged In" - now check if we're off the login page
                    console.log(`[BrowserAutomation] User confirmed login. Checking current URL...`);
                    
                    // Give a moment for any final redirects to complete
                    await this.page.waitForTimeout(2000);
                    
                    // Check current URL - user may have already been redirected
                    let finalUrl = this.page.url();
                    
                    // If still on login page, wait a bit more with longer timeout
                    if (this.authManager.isLoginPage(finalUrl)) {
                        console.log('[BrowserAutomation] Still on login page after confirmation, waiting for redirect...');
                        try {
                            // Wait up to 60 seconds for redirect after user confirms
                            await this.page.waitForURL(
                                (pageUrl: URL) => !this.authManager.isLoginPage(pageUrl.href),
                                { timeout: 60000 }
                            );
                            finalUrl = this.page.url();
                        } catch {
                            // Still on login - maybe auth failed
                            console.log('[BrowserAutomation] Timeout waiting for redirect after login confirmation');
                        }
                    }
                    
                    // Final check
                    if (this.authManager.isLoginPage(finalUrl)) {
                        console.log(`[BrowserAutomation] Still on login page after auth: ${finalUrl}`);
                        return {
                            success: false,
                            url: finalUrl,
                            loadTime: result.loadTime,
                            retryCount: result.retryCount,
                            error: 'Authentication may have failed - still on login page. Please check your credentials and try again.',
                            authRequired: true
                        };
                    }
                    
                    // Save session for future use (filtered for auth only)
                    await this.saveCurrentSession(new URL(url).hostname);
                    console.log(`[BrowserAutomation] Auth complete, redirected to: ${finalUrl}`);

                    return {
                        success: true,
                        url: finalUrl,
                        loadTime: result.loadTime,
                        retryCount: result.retryCount,
                        authRequired: true
                    };
                } else {
                    return {
                        success: false,
                        url: currentUrl,
                        loadTime: result.loadTime,
                        retryCount: result.retryCount,
                        error: 'Login cancelled by user.',
                        authRequired: true
                    };
                }
            }

            return {
                success: result.success,
                url: result.finalUrl,
                loadTime: result.loadTime,
                retryCount: result.retryCount,
                error: result.error,
                screenshotPath: result.failureScreenshot
            };

        } catch (error: any) {
            return {
                success: false,
                url: url,
                loadTime: 0,
                retryCount: 0,
                error: error.message
            };
        }
    }

    /**
     * Navigate with cache bypass (for debugging stale cache issues)
     */
    async navigateFresh(url: string): Promise<NavigationResult> {
        return this.navigateTo(url, { bypassCache: true });
    }

    // ============================================
    // SESSION MANAGEMENT
    // ============================================

    /**
     * Save current session (filtered for auth cookies only)
     */
    async saveCurrentSession(domain: string): Promise<string> {
        if (!this.context) {
            return 'Error: Browser not launched.';
        }

        try {
            const session = await this.sessionManager.saveSession(
                this.context,
                `${domain} session`,
                domain,
                true // Filter auth only
            );

            return `✅ Session saved: ${session.cookieCount} auth cookies for ${domain}`;
        } catch (error: any) {
            return `Error saving session: ${error.message}`;
        }
    }

    /**
     * Clear current session and start fresh
     */
    async clearSession(): Promise<string> {
        if (!this.context) {
            return 'Error: Browser not launched.';
        }

        try {
            await this.context.clearCookies();
            
            // Also clear localStorage (runs in browser context)
            if (this.page) {
                await this.page.evaluate(`
                    localStorage.clear();
                    sessionStorage.clear();
                `);
            }

            return '✅ Session cleared. Browser is now in fresh state.';
        } catch (error: any) {
            return `Error clearing session: ${error.message}`;
        }
    }

    /**
     * List all saved sessions
     */
    listSavedSessions(): SavedSession[] {
        return this.sessionManager.getAllSessions();
    }

    /**
     * Delete saved sessions for a domain
     */
    deleteSavedSessions(domain: string): string {
        const count = this.sessionManager.deleteSessionsForDomain(domain);
        return `Deleted ${count} session(s) for ${domain}`;
    }

    // ============================================
    // SCREENSHOT & RECORDING
    // ============================================

    /**
     * Take a screenshot
     * Also checks for login page and handles authentication if needed
     */
    async takeScreenshot(name?: string): Promise<ScreenshotResult | string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }

        try {
            // Check if we're on a login page - handle auth first
            const currentUrl = this.page.url();
            if (this.authManager.isLoginPage(currentUrl)) {
                console.log(`[BrowserAutomation] Login page detected during screenshot: ${currentUrl}`);
                
                // Use the login checkpoint callback if available
                const ssoProvider = this.authManager.getSsoProvider(currentUrl) || undefined;
                let userConfirmed = false;
                
                if (this.loginCheckpointCallback) {
                    userConfirmed = await this.loginCheckpointCallback(this.taskId, currentUrl, ssoProvider);
                } else {
                    const authResult = await this.authManager.promptUserForAuth(currentUrl);
                    userConfirmed = authResult === 'completed';
                }
                
                if (userConfirmed) {
                    // Wait for redirect after login confirmation
                    console.log(`[BrowserAutomation] User confirmed login, waiting for redirect...`);
                    await this.page.waitForTimeout(2000);
                    
                    // Check if still on login page
                    if (this.authManager.isLoginPage(this.page.url())) {
                        try {
                            await this.page.waitForURL(
                                (pageUrl: URL) => !this.authManager.isLoginPage(pageUrl.href),
                                { timeout: 60000 }
                            );
                        } catch {
                            // Timeout
                        }
                    }
                    
                    // Final check
                    if (this.authManager.isLoginPage(this.page.url())) {
                        return 'Error: Still on login page after authentication. Please check your credentials.';
                    }
                    
                    // Save session
                    await this.saveCurrentSession(new URL(currentUrl).hostname);
                } else {
                    return 'Error: Login cancelled. Cannot take screenshot of login page.';
                }
            }

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
                timestamp
            };
        } catch (error: any) {
            return `Error taking screenshot: ${error.message}`;
        }
    }

    // ============================================
    // PAGE INTERACTIONS
    // ============================================

    /**
     * Click on an element with retry
     */
    async click(selector: string, options: { timeout?: number; force?: boolean } = {}): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }

        const { timeout = 5000, force = false } = options;

        try {
            await this.page.click(selector, { timeout, force });
            return `✅ Clicked: ${selector}`;
        } catch (error: any) {
            // Try with force if normal click failed
            if (!force) {
                try {
                    await this.page.click(selector, { timeout, force: true });
                    return `✅ Clicked (forced): ${selector}`;
                } catch {
                    // Fall through to error
                }
            }
            return `❌ Click failed on ${selector}: ${error.message}`;
        }
    }

    /**
     * Type text into an element
     */
    async type(selector: string, text: string, options: { clear?: boolean } = {}): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }

        try {
            if (options.clear) {
                await this.page.fill(selector, text);
            } else {
                await this.page.type(selector, text);
            }
            return `✅ Typed into ${selector}`;
        } catch (error: any) {
            return `❌ Type failed: ${error.message}`;
        }
    }

    /**
     * Wait for element
     */
    async waitForSelector(selector: string, timeout: number = 5000): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }

        try {
            await this.page.waitForSelector(selector, { timeout, state: 'visible' });
            return `✅ Found: ${selector}`;
        } catch (error: any) {
            return `❌ Not found: ${selector} (${error.message})`;
        }
    }

    /**
     * Get page content (HTML)
     */
    async getPageContent(): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }

        try {
            const content = await this.page.content();
            const maxLength = 50000;
            if (content.length > maxLength) {
                return content.substring(0, maxLength) + '\n... [TRUNCATED]';
            }
            return content;
        } catch (error: any) {
            return `Error: ${error.message}`;
        }
    }

    /**
     * Get current URL
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
     * Evaluate JavaScript
     */
    async evaluate(script: string): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }

        try {
            const result = await this.page.evaluate(script);
            return JSON.stringify(result, null, 2);
        } catch (error: any) {
            return `Error: ${error.message}`;
        }
    }

    /**
     * Reload page
     */
    async reload(bypassCache: boolean = false): Promise<string> {
        if (!this.page) {
            return 'Error: Browser not launched.';
        }

        try {
            if (bypassCache) {
                // Clear cache and reload (runs in browser context)
                await this.page.evaluate(`
                    if ('caches' in window) {
                        caches.keys().then(function(names) { 
                            names.forEach(function(name) { caches.delete(name); });
                        });
                    }
                `);
            }
            
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            return bypassCache ? '✅ Hard reload completed' : '✅ Page reloaded';
        } catch (error: any) {
            return `Error: ${error.message}`;
        }
    }

    // ============================================
    // BROWSER LIFECYCLE
    // ============================================

    /**
     * Close browser
     */
    async closeBrowser(): Promise<RecordingResult | string> {
        try {
            let recordingResult: RecordingResult | undefined;

            // Stop heartbeat
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }

            // Handle recording
            if (this.context && this.isRecording && this.page) {
                await this.page.close();
                
                const video = this.page?.video();
                if (video) {
                    const videoPath = await video.path();
                    recordingResult = {
                        path: videoPath,
                        duration: Date.now() - this.recordingStartTime,
                        timestamp: this.recordingStartTime
                    };
                }
            }

            // Save session before closing
            if (this.context) {
                try {
                    const currentUrl = this.page?.url();
                    if (currentUrl) {
                        const domain = new URL(currentUrl).hostname;
                        await this.sessionManager.saveSession(this.context, `Auto-save ${domain}`, domain, true);
                    }
                } catch {
                    // Non-critical
                }
                await this.context.close();
            }

            if (this.browser) {
                await this.browser.close();
            }

            // Reset state
            this.page = null;
            this.pageValidator = null;
            this.context = null;
            this.browser = null;
            this.currentBrowserInfo = null;
            this.isRecording = false;
            this.recordingStartTime = 0;

            if (recordingResult) {
                return recordingResult;
            }
            return '✅ Browser closed';

        } catch (error: any) {
            return `Error closing browser: ${error.message}`;
        }
    }

    /**
     * Check if browser is running
     */
    isRunning(): boolean {
        return this.browser !== null && this.page !== null;
    }

    /**
     * Check if recording
     */
    isRecordingVideo(): boolean {
        return this.isRecording;
    }

    /**
     * Get current browser info
     */
    getBrowserInfo(): BrowserInfo | null {
        return this.currentBrowserInfo;
    }

    // ============================================
    // SETUP & DIAGNOSTICS
    // ============================================

    /**
     * Run browser setup wizard
     */
    async runSetup(): Promise<string> {
        const browser = await this.browserManager.runSetupWizard();
        
        if (browser) {
            return `✅ Browser configured: ${browser.name}\nPath: ${browser.executablePath}`;
        }
        
        return '❌ Browser setup cancelled or failed.';
    }

    /**
     * Get browser health status
     */
    async getHealthStatus(): Promise<string> {
        if (!this.browser) {
            return 'Browser not running.';
        }

        const health = await this.browserManager.checkBrowserHealth(this.browser);
        
        if (health.isAlive) {
            return `✅ Browser healthy (PID: ${health.pid})`;
        } else {
            return '❌ Browser is unresponsive or crashed.';
        }
    }

    /**
     * Check session health
     */
    async checkSessionHealth(domain: string): Promise<string> {
        const session = this.sessionManager.getSessionForDomain(domain);
        
        if (!session) {
            return `No saved session found for ${domain}`;
        }

        const health = await this.sessionManager.analyzeSessionHealth(session.id);
        
        let message = `Session: ${session.name}\n`;
        message += `Valid cookies: ${health.validCookies}\n`;
        message += `Expired cookies: ${health.expiredCookies}\n`;
        message += `Status: ${health.isValid ? '✅ Valid' : '⚠️ May need re-authentication'}\n`;
        
        if (health.recommendations.length > 0) {
            message += `\nRecommendations:\n`;
            health.recommendations.forEach(r => {
                message += `  - ${r}\n`;
            });
        }

        return message;
    }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Check if playwright is available
 */
export async function isPlaywrightAvailable(): Promise<boolean> {
    return getBrowserManager().isPlaywrightAvailable();
}
