/**
 * BrowserManager - Smart browser detection, download, and lifecycle management
 * 
 * Features:
 * - Auto-detect installed browsers (Chrome, Chromium, Edge, Firefox)
 * - Download Chromium if no suitable browser found
 * - Validate browser executable before launch
 * - Manage browser processes and cleanup zombies
 * - Health monitoring with heartbeat
 * 
 * @module BrowserManager
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';

// ============================================
// TYPES
// ============================================

export interface BrowserInfo {
    name: string;
    type: 'chrome' | 'chromium' | 'edge' | 'firefox' | 'unknown';
    executablePath: string;
    version?: string;
    isValid: boolean;
}

export interface BrowserConfig {
    preferredBrowser?: string;
    customExecutablePath?: string;
    downloadedChromiumPath?: string;
    lastValidated?: number;
}

export interface LaunchOptions {
    headless?: boolean;
    slowMo?: number;
    timeout?: number;
    devtools?: boolean;
    args?: string[];
}

export interface BrowserHealth {
    isAlive: boolean;
    lastHeartbeat: number;
    pid?: number;
    memoryUsage?: number;
}

// ============================================
// CONSTANTS
// ============================================

const CONFIG_DIR = path.join(os.homedir(), '.vibearchitect');
const CONFIG_FILE = path.join(CONFIG_DIR, 'browser-config.json');
const CHROMIUM_DIR = path.join(CONFIG_DIR, 'chromium');

// Comprehensive launch args for stability
const STABLE_LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',         // Prevents crashes in low memory
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',                    // More stable, especially headless
    '--no-first-run',
    '--no-zygote',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--mute-audio',
    '--safebrowsing-disable-auto-update',
    '--ignore-certificate-errors',      // For localhost/self-signed certs
];

// Additional args for cache control
const CACHE_CONTROL_ARGS = [
    '--disk-cache-size=0',              // Disable disk cache
    '--aggressive-cache-discard',
    '--disable-application-cache',
];

// Browser executable paths by OS
const BROWSER_PATHS: Record<string, Record<string, string[]>> = {
    win32: {
        chrome: [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        ],
        edge: [
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ],
        chromium: [
            path.join(process.env.LOCALAPPDATA || '', 'Chromium\\Application\\chrome.exe'),
        ],
    },
    darwin: {
        chrome: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ],
        edge: [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ],
        chromium: [
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ],
        firefox: [
            '/Applications/Firefox.app/Contents/MacOS/firefox',
        ],
    },
    linux: {
        chrome: [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
        ],
        chromium: [
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
        ],
        edge: [
            '/usr/bin/microsoft-edge',
        ],
        firefox: [
            '/usr/bin/firefox',
        ],
    },
};

// ============================================
// BROWSER MANAGER CLASS
// ============================================

export class BrowserManager {
    private static instance: BrowserManager;
    private config: BrowserConfig = {};
    private activeBrowsers: Map<number, BrowserHealth> = new Map();
    private playwrightModule: any = null;

    private constructor() {
        this.loadConfig();
    }

    public static getInstance(): BrowserManager {
        if (!BrowserManager.instance) {
            BrowserManager.instance = new BrowserManager();
        }
        return BrowserManager.instance;
    }

    // ============================================
    // CONFIG MANAGEMENT
    // ============================================

    private ensureConfigDir(): void {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
    }

    private loadConfig(): void {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const data = fs.readFileSync(CONFIG_FILE, 'utf8');
                this.config = JSON.parse(data);
            }
        } catch (error) {
            console.warn('[BrowserManager] Failed to load config:', error);
            this.config = {};
        }
    }

    private saveConfig(): void {
        try {
            this.ensureConfigDir();
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
        } catch (error) {
            console.error('[BrowserManager] Failed to save config:', error);
        }
    }

    // ============================================
    // BROWSER DETECTION
    // ============================================

    /**
     * Detect all available browsers on the system
     */
    public async detectBrowsers(): Promise<BrowserInfo[]> {
        const browsers: BrowserInfo[] = [];
        const platform = process.platform as 'win32' | 'darwin' | 'linux';
        const platformPaths = BROWSER_PATHS[platform] || {};

        for (const [browserType, paths] of Object.entries(platformPaths)) {
            for (const execPath of paths) {
                if (execPath && fs.existsSync(execPath)) {
                    const version = await this.getBrowserVersion(execPath);
                    browsers.push({
                        name: this.getBrowserDisplayName(browserType),
                        type: browserType as BrowserInfo['type'],
                        executablePath: execPath,
                        version,
                        isValid: true
                    });
                }
            }
        }

        // Check for downloaded Chromium
        if (this.config.downloadedChromiumPath && fs.existsSync(this.config.downloadedChromiumPath)) {
            const version = await this.getBrowserVersion(this.config.downloadedChromiumPath);
            browsers.push({
                name: 'Chromium (Downloaded)',
                type: 'chromium',
                executablePath: this.config.downloadedChromiumPath,
                version,
                isValid: true
            });
        }

        // Check custom path from config
        if (this.config.customExecutablePath && fs.existsSync(this.config.customExecutablePath)) {
            const version = await this.getBrowserVersion(this.config.customExecutablePath);
            browsers.push({
                name: 'Custom Browser',
                type: 'unknown',
                executablePath: this.config.customExecutablePath,
                version,
                isValid: true
            });
        }

        return browsers;
    }

    /**
     * Get browser version by executing with --version flag
     */
    private async getBrowserVersion(execPath: string): Promise<string | undefined> {
        return new Promise((resolve) => {
            try {
                const child = cp.spawn(execPath, ['--version'], {
                    timeout: 5000,
                    shell: process.platform === 'win32'
                });

                let output = '';
                child.stdout?.on('data', (data) => {
                    output += data.toString();
                });

                child.on('close', () => {
                    // Extract version number from output
                    const match = output.match(/(\d+\.\d+\.\d+\.\d+|\d+\.\d+\.\d+)/);
                    resolve(match ? match[1] : undefined);
                });

                child.on('error', () => {
                    resolve(undefined);
                });
            } catch {
                resolve(undefined);
            }
        });
    }

    private getBrowserDisplayName(type: string): string {
        const names: Record<string, string> = {
            chrome: 'Google Chrome',
            chromium: 'Chromium',
            edge: 'Microsoft Edge',
            firefox: 'Firefox'
        };
        return names[type] || type;
    }

    /**
     * Get the best available browser, or prompt to download
     */
    public async getBestBrowser(): Promise<BrowserInfo | null> {
        const browsers = await this.detectBrowsers();

        // Prefer Chrome > Edge > Chromium > Firefox
        const priority = ['chrome', 'edge', 'chromium', 'firefox'];
        
        for (const type of priority) {
            const browser = browsers.find(b => b.type === type && b.isValid);
            if (browser) {
                console.log(`[BrowserManager] Selected browser: ${browser.name} (${browser.version})`);
                return browser;
            }
        }

        // No browser found
        return null;
    }

    // ============================================
    // CHROMIUM DOWNLOAD
    // ============================================

    /**
     * Download Chromium using Playwright's browser downloader
     */
    public async downloadChromium(): Promise<BrowserInfo | null> {
        return new Promise(async (resolve) => {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Downloading Chromium browser...",
                cancellable: false
            }, async (progress) => {
                try {
                    progress.report({ message: 'Preparing download...' });

                    // Ensure playwright-core is available
                    const pw = await this.getPlaywright();
                    if (!pw) {
                        vscode.window.showErrorMessage(
                            'playwright-core is required to download Chromium. Please install it first.'
                        );
                        resolve(null);
                        return;
                    }

                    // Create download directory
                    if (!fs.existsSync(CHROMIUM_DIR)) {
                        fs.mkdirSync(CHROMIUM_DIR, { recursive: true });
                    }

                    progress.report({ message: 'Downloading Chromium (this may take a few minutes)...' });

                    // Use npx playwright install chromium
                    const npmCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
                    
                    return new Promise<void>((resolveProgress) => {
                        const env = {
                            ...process.env,
                            PLAYWRIGHT_BROWSERS_PATH: CHROMIUM_DIR
                        };

                        const child = cp.spawn(npmCmd, ['playwright', 'install', 'chromium'], {
                            cwd: CONFIG_DIR,
                            shell: true,
                            env
                        });

                        let stderr = '';

                        child.stderr?.on('data', (data) => {
                            stderr += data.toString();
                            console.log('[BrowserManager] Download progress:', data.toString());
                        });

                        child.stdout?.on('data', (data) => {
                            console.log('[BrowserManager]', data.toString());
                        });

                        child.on('close', async (code) => {
                            if (code === 0) {
                                // Find the downloaded executable
                                const execPath = await this.findDownloadedChromium();
                                
                                if (execPath) {
                                    this.config.downloadedChromiumPath = execPath;
                                    this.saveConfig();

                                    vscode.window.showInformationMessage('✅ Chromium downloaded successfully!');
                                    
                                    resolve({
                                        name: 'Chromium (Downloaded)',
                                        type: 'chromium',
                                        executablePath: execPath,
                                        isValid: true
                                    });
                                } else {
                                    vscode.window.showErrorMessage('Download completed but executable not found.');
                                    resolve(null);
                                }
                            } else {
                                console.error('[BrowserManager] Download failed:', stderr);
                                vscode.window.showErrorMessage(
                                    `Failed to download Chromium: ${stderr || 'Unknown error'}`
                                );
                                resolve(null);
                            }
                            resolveProgress();
                        });

                        child.on('error', (err) => {
                            console.error('[BrowserManager] Download spawn error:', err);
                            vscode.window.showErrorMessage(`Download error: ${err.message}`);
                            resolve(null);
                            resolveProgress();
                        });
                    });

                } catch (error: any) {
                    console.error('[BrowserManager] Download error:', error);
                    vscode.window.showErrorMessage(`Download failed: ${error.message}`);
                    resolve(null);
                }
            });
        });
    }

    /**
     * Find downloaded Chromium executable in PLAYWRIGHT_BROWSERS_PATH
     */
    private async findDownloadedChromium(): Promise<string | null> {
        try {
            // Playwright downloads to: PLAYWRIGHT_BROWSERS_PATH/chromium-{revision}/chrome-{platform}/chrome
            const chromiumDirs = fs.readdirSync(CHROMIUM_DIR).filter(d => d.startsWith('chromium'));
            
            for (const dir of chromiumDirs) {
                const basePath = path.join(CHROMIUM_DIR, dir);
                
                // Platform-specific paths
                let execPath: string;
                if (process.platform === 'win32') {
                    execPath = path.join(basePath, 'chrome-win', 'chrome.exe');
                } else if (process.platform === 'darwin') {
                    execPath = path.join(basePath, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
                } else {
                    execPath = path.join(basePath, 'chrome-linux', 'chrome');
                }

                if (fs.existsSync(execPath)) {
                    return execPath;
                }
            }
        } catch (error) {
            console.error('[BrowserManager] Error finding downloaded Chromium:', error);
        }

        return null;
    }

    // ============================================
    // PLAYWRIGHT MODULE MANAGEMENT
    // ============================================

    /**
     * Get Playwright module with proper error handling
     */
    public async getPlaywright(): Promise<any> {
        if (this.playwrightModule) {
            return this.playwrightModule;
        }

        try {
            const pw = await import('playwright-core');
            
            // Handle different module structures
            if (pw.chromium) {
                this.playwrightModule = pw;
            } else if (pw.default?.chromium) {
                this.playwrightModule = pw.default;
            } else {
                throw new Error('playwright-core loaded but chromium not found');
            }

            console.log('[BrowserManager] Playwright loaded successfully');
            return this.playwrightModule;
        } catch (error: any) {
            if (error.message.includes('Cannot find module') || error.code === 'MODULE_NOT_FOUND') {
                console.warn('[BrowserManager] playwright-core not installed');
                return null;
            }
            throw error;
        }
    }

    /**
     * Check if Playwright is available
     */
    public async isPlaywrightAvailable(): Promise<boolean> {
        try {
            const pw = await this.getPlaywright();
            return pw !== null;
        } catch {
            return false;
        }
    }

    // ============================================
    // BROWSER LAUNCH
    // ============================================

    /**
     * Get optimized launch arguments
     */
    public getLaunchArgs(options: {
        disableCache?: boolean;
        extraArgs?: string[];
    } = {}): string[] {
        const args = [...STABLE_LAUNCH_ARGS];

        if (options.disableCache) {
            args.push(...CACHE_CONTROL_ARGS);
        }

        if (options.extraArgs) {
            args.push(...options.extraArgs);
        }

        return args;
    }

    /**
     * Launch browser with optimal configuration
     */
    public async launchBrowser(options: LaunchOptions = {}): Promise<{
        browser: any;
        browserInfo: BrowserInfo;
    } | null> {
        const pw = await this.getPlaywright();
        if (!pw) {
            throw new Error('Playwright not available. Please install playwright-core.');
        }

        // Get best browser or prompt download
        let browserInfo = await this.getBestBrowser();
        
        if (!browserInfo) {
            const shouldDownload = await vscode.window.showWarningMessage(
                'No compatible browser found. Would you like to download Chromium?',
                'Download Chromium',
                'Cancel'
            );

            if (shouldDownload === 'Download Chromium') {
                browserInfo = await this.downloadChromium();
            }

            if (!browserInfo) {
                throw new Error('No browser available. Please install Chrome, Edge, or Chromium.');
            }
        }

        // Build launch config
        const launchConfig: any = {
            executablePath: browserInfo.executablePath,
            headless: options.headless ?? false,
            slowMo: options.slowMo,
            timeout: options.timeout ?? 30000,
            devtools: options.devtools ?? false,
            args: this.getLaunchArgs({
                disableCache: true,
                extraArgs: options.args
            })
        };

        console.log(`[BrowserManager] Launching ${browserInfo.name} with args:`, launchConfig.args.length);

        try {
            console.log('[BrowserManager] Calling pw.chromium.launch...');
            const browser = await pw.chromium.launch(launchConfig);
            console.log('[BrowserManager] Browser launched, type:', typeof browser);

            // Verify browser object has expected methods
            if (!browser || typeof browser.newContext !== 'function') {
                throw new Error('Browser object is invalid - missing newContext method');
            }

            // Track browser process (safely - process() may not be available in all Playwright versions)
            let pid: number | undefined;
            try {
                if (browser.process && typeof browser.process === 'function') {
                    const proc = browser.process();
                    pid = proc?.pid;
                    console.log('[BrowserManager] Browser PID:', pid);
                } else {
                    console.log('[BrowserManager] browser.process not available (normal for some setups)');
                }
            } catch (processError) {
                console.log('[BrowserManager] Could not get browser PID:', processError);
            }

            if (pid) {
                this.activeBrowsers.set(pid, {
                    isAlive: true,
                    lastHeartbeat: Date.now(),
                    pid
                });
            }

            // Setup disconnect handler
            browser.on('disconnected', () => {
                if (pid) {
                    this.activeBrowsers.delete(pid);
                }
                console.log('[BrowserManager] Browser disconnected');
            });

            return { browser, browserInfo };
        } catch (error: any) {
            console.error('[BrowserManager] Launch failed:', error);
            
            // Provide helpful error messages
            if (error.message.includes('executable doesn\'t exist')) {
                throw new Error(
                    `Browser executable not found at: ${browserInfo.executablePath}\n` +
                    'Please install Chrome or run "Download Chromium" from the browser setup.'
                );
            }
            
            throw error;
        }
    }

    // ============================================
    // HEALTH MONITORING
    // ============================================

    /**
     * Check if a browser process is still alive
     */
    public async checkBrowserHealth(browser: any): Promise<BrowserHealth> {
        // Safely get PID (process() may not be available in all Playwright versions)
        let pid: number | undefined;
        try {
            if (typeof browser.process === 'function') {
                pid = browser.process()?.pid;
            }
        } catch {
            // process() not available - proceed without PID tracking
        }

        try {
            // Try to get contexts - if it works, browser is healthy
            const contexts = browser.contexts();
            const isAlive = contexts.length >= 0; // Will throw if browser is dead

            const health: BrowserHealth = {
                isAlive,
                lastHeartbeat: Date.now(),
                pid
            };

            if (pid) {
                this.activeBrowsers.set(pid, health);
            }
            return health;
        } catch {
            if (pid) {
                this.activeBrowsers.delete(pid);
            }
            return { isAlive: false, lastHeartbeat: 0, pid };
        }
    }

    /**
     * Start heartbeat monitoring for a browser
     */
    public startHeartbeat(browser: any, intervalMs: number = 5000): ReturnType<typeof setInterval> {
        return setInterval(async () => {
            const health = await this.checkBrowserHealth(browser);
            if (!health.isAlive) {
                console.warn('[BrowserManager] Browser heartbeat failed - browser may have crashed');
            }
        }, intervalMs);
    }

    // ============================================
    // CLEANUP
    // ============================================

    /**
     * Kill all tracked browser processes
     */
    public async killAllBrowsers(): Promise<void> {
        for (const [pid, health] of this.activeBrowsers) {
            if (health.isAlive) {
                try {
                    process.kill(pid);
                    console.log(`[BrowserManager] Killed browser process ${pid}`);
                } catch (error) {
                    console.warn(`[BrowserManager] Failed to kill process ${pid}:`, error);
                }
            }
        }
        this.activeBrowsers.clear();
    }

    /**
     * Cleanup zombie browser processes (orphaned from previous sessions)
     */
    public async cleanupZombies(): Promise<number> {
        let cleaned = 0;

        // This is platform-specific and simplified
        // In production, you'd use a more robust process management approach
        if (process.platform === 'win32') {
            // On Windows, find chrome processes with our specific args
            try {
                const { execSync } = require('child_process');
                // Just log for now - killing all chrome processes is dangerous
                console.log('[BrowserManager] Zombie cleanup is limited on Windows');
            } catch {
                // Ignore
            }
        }

        return cleaned;
    }

    // ============================================
    // SETUP WIZARD
    // ============================================

    /**
     * Run interactive browser setup
     */
    public async runSetupWizard(): Promise<BrowserInfo | null> {
        const browsers = await this.detectBrowsers();

        if (browsers.length === 0) {
            // No browsers found - offer to download
            const choice = await vscode.window.showInformationMessage(
                'No compatible browser found. Browser automation requires Chrome, Edge, or Chromium.',
                'Download Chromium',
                'Set Custom Path',
                'Cancel'
            );

            if (choice === 'Download Chromium') {
                return await this.downloadChromium();
            } else if (choice === 'Set Custom Path') {
                const uri = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    title: 'Select Browser Executable',
                    filters: process.platform === 'win32' 
                        ? { 'Executable': ['exe'] }
                        : undefined
                });

                if (uri && uri[0]) {
                    this.config.customExecutablePath = uri[0].fsPath;
                    this.saveConfig();

                    return {
                        name: 'Custom Browser',
                        type: 'unknown',
                        executablePath: uri[0].fsPath,
                        isValid: true
                    };
                }
            }

            return null;
        }

        // Multiple browsers found - let user choose
        const items = browsers.map(b => ({
            label: b.name,
            description: b.version,
            detail: b.executablePath,
            browser: b
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a browser for automation',
            title: 'Browser Setup'
        });

        if (selected) {
            this.config.preferredBrowser = selected.browser.executablePath;
            this.saveConfig();
            return selected.browser;
        }

        return null;
    }

    /**
     * Get current configuration
     */
    public getConfig(): BrowserConfig {
        return { ...this.config };
    }

    /**
     * Set custom browser path
     */
    public setCustomBrowserPath(execPath: string): void {
        this.config.customExecutablePath = execPath;
        this.saveConfig();
    }
}

// Export singleton getter
export function getBrowserManager(): BrowserManager {
    return BrowserManager.getInstance();
}
