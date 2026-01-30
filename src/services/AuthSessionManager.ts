import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * AuthSessionManager - Handles browser session persistence and SSO authentication
 * 
 * Features:
 * - Persistent browser profile in ~/.vibearchitect/browser-profile/
 * - Okta/SSO login detection
 * - Human-in-the-loop authentication flow with VS Code popup
 * 
 * Security:
 * - No credentials stored or exposed to AI
 * - Session cookies encrypted by browser at OS level
 * - Works with MFA/SSO
 */
export class AuthSessionManager {
    private static instance: AuthSessionManager;

    // Global profile directory: ~/.vibearchitect/browser-profile/
    private readonly profileDir: string;

    // Common SSO/OAuth login page patterns
    private readonly loginPagePatterns: RegExp[] = [
        /\.okta\.com/i,
        /login\.microsoftonline\.com/i,
        /accounts\.google\.com/i,
        /auth0\.com/i,
        /login\./i,
        /signin\./i,
        /sso\./i
    ];

    private constructor() {
        this.profileDir = path.join(os.homedir(), '.vibearchitect', 'browser-profile');
        this.ensureProfileDir();
    }

    public static getInstance(): AuthSessionManager {
        if (!AuthSessionManager.instance) {
            AuthSessionManager.instance = new AuthSessionManager();
        }
        return AuthSessionManager.instance;
    }

    /**
     * Ensure the browser profile directory exists
     */
    private ensureProfileDir(): void {
        if (!fs.existsSync(this.profileDir)) {
            fs.mkdirSync(this.profileDir, { recursive: true });
            console.log(`[AuthSessionManager] Created browser profile directory: ${this.profileDir}`);
        }
    }

    /**
     * Get the path to the persistent browser profile
     */
    public getProfilePath(): string {
        return this.profileDir;
    }

    /**
     * Check if a URL is a login/SSO page
     */
    public isLoginPage(url: string): boolean {
        if (!url) {return false;}

        return this.loginPagePatterns.some(pattern => pattern.test(url));
    }

    /**
     * Check if URL is specifically an Okta login page
     */
    public isOktaLoginPage(url: string): boolean {
        if (!url) {return false;}
        return /\.okta\.com/i.test(url);
    }

    /**
     * Show VS Code notification for manual authentication
     * Returns a promise that resolves when user clicks "I've Logged In" or times out
     */
    public async promptUserForAuth(loginUrl: string): Promise<'completed' | 'cancelled' | 'timeout'> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve('timeout');
            }, 5 * 60 * 1000); // 5 minute timeout

            vscode.window.showWarningMessage(
                `🔐 Authentication Required\n\nPlease complete the login in the browser window.\nURL: ${loginUrl}`,
                { modal: false },
                'I\'ve Logged In',
                'Cancel'
            ).then(selection => {
                clearTimeout(timeout);
                if (selection === 'I\'ve Logged In') {
                    resolve('completed');
                } else {
                    resolve('cancelled');
                }
            });
        });
    }

    /**
     * Wait for the page to navigate away from the login URL
     * This is a backup detection method - waits for SSO redirect
     */
    public async waitForAuthRedirect(
        page: any,
        originalLoginUrl: string,
        timeoutMs: number = 5 * 60 * 1000
    ): Promise<boolean> {
        const startTime = Date.now();

        return new Promise((resolve) => {
            const checkInterval = setInterval(async () => {
                try {
                    const currentUrl = page.url();

                    // Check if we've navigated away from login page
                    if (!this.isLoginPage(currentUrl)) {
                        clearInterval(checkInterval);
                        console.log(`[AuthSessionManager] Auth completed - redirected to: ${currentUrl}`);
                        resolve(true);
                        return;
                    }

                    // Check timeout
                    if (Date.now() - startTime > timeoutMs) {
                        clearInterval(checkInterval);
                        console.log('[AuthSessionManager] Auth timeout - still on login page');
                        resolve(false);
                    }
                } catch (error) {
                    // Page might be navigating, continue checking
                }
            }, 1000); // Check every second
        });
    }

    /**
     * Get context options for persistent browser session
     */
    public getPersistentContextOptions(additionalOptions: any = {}): any {
        return {
            ...additionalOptions,
            // Use persistent storage for cookies, localStorage, etc.
            storageState: path.join(this.profileDir, 'storage-state.json'),
        };
    }

    /**
     * Save current browser context state for future sessions
     */
    public async saveContextState(context: any): Promise<void> {
        try {
            const stateFile = path.join(this.profileDir, 'storage-state.json');
            await context.storageState({ path: stateFile });
            console.log(`[AuthSessionManager] Saved browser session state to: ${stateFile}`);
        } catch (error: any) {
            console.error(`[AuthSessionManager] Failed to save session state: ${error.message}`);
        }
    }

    /**
     * Check if we have a saved session that might be valid
     */
    public hasSavedSession(): boolean {
        const stateFile = path.join(this.profileDir, 'storage-state.json');
        return fs.existsSync(stateFile);
    }

    /**
     * Clear saved session (useful if session is corrupted or expired)
     */
    public clearSession(): void {
        const stateFile = path.join(this.profileDir, 'storage-state.json');
        if (fs.existsSync(stateFile)) {
            fs.unlinkSync(stateFile);
            console.log('[AuthSessionManager] Cleared saved browser session');
        }
    }
}
