import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getSessionStorageManager } from './SessionStorageManager';

/**
 * AuthSessionManager - Handles browser session persistence and SSO authentication
 * 
 * Features:
 * - Persistent browser profile in ~/.vibearchitect/browser-profile/
 * - Okta/SSO login detection with intelligent pattern matching
 * - Human-in-the-loop authentication flow with VS Code popup
 * - Integration with SessionStorageManager for selective cookie saving
 * 
 * Security:
 * - No credentials stored or exposed to AI
 * - Session cookies encrypted by browser at OS level
 * - Works with MFA/SSO
 * - Only auth cookies saved (UI state filtered out)
 */
export class AuthSessionManager {
    private static instance: AuthSessionManager;

    // Global profile directory: ~/.vibearchitect/browser-profile/
    private readonly profileDir: string;
    
    // Session storage manager for selective save/restore
    private readonly sessionManager = getSessionStorageManager();

    // Common SSO/OAuth login page patterns (expanded)
    private readonly loginPagePatterns: RegExp[] = [
        /\.okta\.com/i,
        /\.oktapreview\.com/i,
        /login\.microsoftonline\.com/i,
        /accounts\.google\.com/i,
        /\.auth0\.com/i,
        /\.onelogin\.com/i,
        /\.ping-eng\.com/i,
        /\.pingidentity\.com/i,
        /\.duosecurity\.com/i,
        /sso\./i,
        /login\./i,
        /signin\./i,
        /auth\./i,
        /identity\./i,
        /\/login\/?$/i,
        /\/signin\/?$/i,
        /\/authenticate/i,
        /\/oauth/i,
        /\/saml/i,
    ];

    // URLs that look like login but aren't (to avoid false positives)
    private readonly notLoginPatterns: RegExp[] = [
        /\/logout/i,
        /\/signout/i,
        /\/logged-out/i,
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
        if (!url) { return false; }

        // Check for "not login" patterns first (logout pages, etc.)
        if (this.notLoginPatterns.some(pattern => pattern.test(url))) {
            return false;
        }

        return this.loginPagePatterns.some(pattern => pattern.test(url));
    }

    /**
     * Check if URL is specifically an Okta login page
     */
    public isOktaLoginPage(url: string): boolean {
        if (!url) { return false; }
        return /\.okta\.com|\.oktapreview\.com/i.test(url);
    }

    /**
     * Get the SSO provider name from URL
     */
    public getSsoProvider(url: string): string | null {
        if (!url) { return null; }

        if (/okta/i.test(url)) { return 'Okta'; }
        if (/microsoftonline|azure/i.test(url)) { return 'Microsoft/Azure AD'; }
        if (/accounts\.google\.com/i.test(url)) { return 'Google'; }
        if (/auth0/i.test(url)) { return 'Auth0'; }
        if (/onelogin/i.test(url)) { return 'OneLogin'; }
        if (/ping/i.test(url)) { return 'Ping Identity'; }
        if (/duo/i.test(url)) { return 'Duo Security'; }

        return null;
    }

    /**
     * Show VS Code notification for manual authentication
     * Returns a promise that resolves when user clicks "I've Logged In" or times out
     */
    public async promptUserForAuth(loginUrl: string): Promise<'completed' | 'cancelled' | 'timeout'> {
        const provider = this.getSsoProvider(loginUrl);
        const providerText = provider ? ` (${provider})` : '';

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve('timeout');
            }, 5 * 60 * 1000); // 5 minute timeout

            vscode.window.showWarningMessage(
                `🔐 Authentication Required${providerText}\n\nPlease complete the login in the browser window.\n\nAfter logging in, click "I've Logged In" below.`,
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
        _originalLoginUrl: string,
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
                } catch (_error) {
                    // Page might be navigating, continue checking
                }
            }, 1000); // Check every second
        });
    }

    /**
     * Get context options for persistent browser session
     * @deprecated Use SessionStorageManager.getContextOptionsWithSession instead
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
     * Now uses SessionStorageManager for selective (auth-only) saving
     */
    public async saveContextState(context: any, domain?: string): Promise<void> {
        try {
            // Try to get domain from context if not provided
            let targetDomain = domain;
            if (!targetDomain) {
                try {
                    const pages = context.pages();
                    if (pages.length > 0) {
                        const url = pages[0].url();
                        targetDomain = new URL(url).hostname;
                    }
                } catch {
                    targetDomain = 'unknown';
                }
            }

            // Save using SessionStorageManager (filters auth cookies only)
            await this.sessionManager.saveSession(
                context,
                `${targetDomain} session`,
                targetDomain || 'unknown',
                true // filterAuthOnly = true
            );

            console.log(`[AuthSessionManager] Saved filtered session for: ${targetDomain}`);

            // Also save full state to legacy location for backward compatibility
            const stateFile = path.join(this.profileDir, 'storage-state.json');
            await context.storageState({ path: stateFile });

        } catch (error: any) {
            console.error(`[AuthSessionManager] Failed to save session state: ${error.message}`);
        }
    }

    /**
     * Check if we have a saved session that might be valid
     */
    public hasSavedSession(domain?: string): boolean {
        if (domain) {
            const session = this.sessionManager.getSessionForDomain(domain);
            return session !== null && this.sessionManager.isSessionValid(session.id);
        }

        // Fall back to legacy check
        const stateFile = path.join(this.profileDir, 'storage-state.json');
        return fs.existsSync(stateFile);
    }

    /**
     * Clear saved session (useful if session is corrupted or expired)
     */
    public clearSession(domain?: string): void {
        if (domain) {
            const count = this.sessionManager.deleteSessionsForDomain(domain);
            console.log(`[AuthSessionManager] Cleared ${count} sessions for ${domain}`);
        }

        // Also clear legacy session
        const stateFile = path.join(this.profileDir, 'storage-state.json');
        if (fs.existsSync(stateFile)) {
            fs.unlinkSync(stateFile);
            console.log('[AuthSessionManager] Cleared legacy browser session');
        }
    }

    /**
     * Clear all expired sessions
     */
    public clearExpiredSessions(): number {
        return this.sessionManager.clearExpiredSessions();
    }

    /**
     * Get session health status for a domain
     */
    public async getSessionHealth(domain: string): Promise<{
        hasSession: boolean;
        isValid: boolean;
        recommendations: string[];
    }> {
        const session = this.sessionManager.getSessionForDomain(domain);

        if (!session) {
            return {
                hasSession: false,
                isValid: false,
                recommendations: ['No saved session found. Please log in.']
            };
        }

        const health = await this.sessionManager.analyzeSessionHealth(session.id);

        return {
            hasSession: true,
            isValid: health.isValid,
            recommendations: health.recommendations
        };
    }
}
