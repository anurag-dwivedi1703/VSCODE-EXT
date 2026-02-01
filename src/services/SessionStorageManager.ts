/**
 * SessionStorageManager - Selective session save/restore with auth/cache separation
 * 
 * This module solves the critical problem of Okta/SSO session caching causing
 * UI rendering issues. It separates authentication state from UI cache.
 * 
 * Features:
 * - Save only authentication-related cookies
 * - Filter out UI state and cached data
 * - Domain-based cookie filtering
 * - Session health checking (detect expired sessions)
 * - Fresh session mode for debugging
 * 
 * @module SessionStorageManager
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ============================================
// TYPES
// ============================================

export interface Cookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
}

export interface LocalStorageEntry {
    name: string;
    value: string;
}

export interface SessionOrigin {
    origin: string;
    localStorage: LocalStorageEntry[];
}

export interface StorageState {
    cookies: Cookie[];
    origins: SessionOrigin[];
}

export interface SavedSession {
    id: string;
    name: string;
    domain: string;
    savedAt: number;
    expiresAt?: number;
    cookieCount: number;
    localStorageKeys: string[];
}

export interface SessionFilterConfig {
    /** Domains to include (regex patterns) */
    includeDomains?: RegExp[];
    /** Domains to exclude (regex patterns) */
    excludeDomains?: RegExp[];
    /** Cookie name patterns to include */
    includeCookies?: RegExp[];
    /** Cookie name patterns to exclude */
    excludeCookies?: RegExp[];
    /** localStorage keys to include */
    includeLocalStorage?: RegExp[];
    /** localStorage keys to exclude */
    excludeLocalStorage?: RegExp[];
}

// ============================================
// CONSTANTS
// ============================================

const SESSION_DIR = path.join(os.homedir(), '.vibearchitect', 'sessions');

// Common auth cookie patterns (keep these)
const AUTH_COOKIE_PATTERNS: RegExp[] = [
    /^sid$/i,                       // Session ID
    /session/i,                     // Session cookies
    /^auth/i,                       // Auth cookies
    /token/i,                       // Token cookies
    /^jwt/i,                        // JWT cookies
    /^access/i,                     // Access tokens
    /^refresh/i,                    // Refresh tokens
    /^id_token/i,                   // ID tokens
    /^oauth/i,                      // OAuth cookies
    /^oidc/i,                       // OIDC cookies
    /^okta/i,                       // Okta-specific
    /^DT$/,                         // Okta device token
    /^idx$/i,                       // Okta idx
    /^XSRF/i,                       // CSRF tokens
    /^csrf/i,                       // CSRF tokens
    /^__Host-/i,                    // Secure host-prefix cookies
    /^__Secure-/i,                  // Secure prefix cookies
];

// Auth-related localStorage keys (keep these)
const AUTH_LOCALSTORAGE_PATTERNS: RegExp[] = [
    /token/i,
    /auth/i,
    /session/i,
    /user/i,
    /^okta/i,
    /^oidc/i,
];

// Cache/UI state patterns to exclude
const CACHE_COOKIE_PATTERNS: RegExp[] = [
    /^_ga/i,                        // Google Analytics
    /^_gid/i,                       // Google Analytics
    /^_fbp/i,                       // Facebook Pixel
    /^_hjid/i,                      // Hotjar
    /^intercom/i,                   // Intercom
    /^ajs/i,                        // Segment
    /^amplitude/i,                  // Amplitude
    /^mp_/i,                        // Mixpanel
    /^optimizely/i,                 // Optimizely
    /^__utm/i,                      // UTM tracking
    /^_gcl/i,                       // Google Click ID
    /preference/i,                  // UI preferences (often cause issues)
    /^theme/i,                      // Theme preferences
    /^locale/i,                     // Locale preferences
    /collapsed/i,                   // UI state
    /expanded/i,                    // UI state
    /scroll/i,                      // Scroll position
    /sidebar/i,                     // Sidebar state
    /modal/i,                       // Modal state
];

// LocalStorage keys to exclude (UI state, not auth)
const CACHE_LOCALSTORAGE_PATTERNS: RegExp[] = [
    /^redux/i,                      // Redux state
    /^persist/i,                    // Persist state
    /^cache/i,                      // Cache
    /^draft/i,                      // Draft content
    /^temp/i,                       // Temporary data
    /history/i,                     // History
    /^recent/i,                     // Recent items
    /^last/i,                       // Last viewed
    /^ui\./i,                       // UI state
    /^state\./i,                    // State
    /preference/i,                  // Preferences
    /setting/i,                     // Settings (UI)
    /collapsed/i,                   // Collapsed state
    /expanded/i,                    // Expanded state
    /scroll/i,                      // Scroll position
    /viewport/i,                    // Viewport state
    /position/i,                    // Position state
    /size/i,                        // Size state
];

// Okta/SSO specific domains
const SSO_DOMAINS: RegExp[] = [
    /\.okta\.com$/i,
    /\.oktapreview\.com$/i,
    /login\.microsoftonline\.com$/i,
    /\.auth0\.com$/i,
    /accounts\.google\.com$/i,
    /\.onelogin\.com$/i,
    /\.ping-eng\.com$/i,
];

// ============================================
// SESSION STORAGE MANAGER CLASS
// ============================================

export class SessionStorageManager {
    private static instance: SessionStorageManager;
    private sessions: Map<string, SavedSession> = new Map();

    private constructor() {
        this.ensureSessionDir();
        this.loadSessionIndex();
    }

    public static getInstance(): SessionStorageManager {
        if (!SessionStorageManager.instance) {
            SessionStorageManager.instance = new SessionStorageManager();
        }
        return SessionStorageManager.instance;
    }

    // ============================================
    // DIRECTORY MANAGEMENT
    // ============================================

    private ensureSessionDir(): void {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
        }
    }

    private getSessionFilePath(sessionId: string): string {
        return path.join(SESSION_DIR, `${sessionId}.json`);
    }

    private getIndexFilePath(): string {
        return path.join(SESSION_DIR, 'index.json');
    }

    // ============================================
    // INDEX MANAGEMENT
    // ============================================

    private loadSessionIndex(): void {
        try {
            const indexPath = this.getIndexFilePath();
            if (fs.existsSync(indexPath)) {
                const data = fs.readFileSync(indexPath, 'utf8');
                const sessions: SavedSession[] = JSON.parse(data);
                this.sessions.clear();
                for (const session of sessions) {
                    this.sessions.set(session.id, session);
                }
            }
        } catch (error) {
            console.warn('[SessionStorageManager] Failed to load session index:', error);
        }
    }

    private saveSessionIndex(): void {
        try {
            const sessions = Array.from(this.sessions.values());
            fs.writeFileSync(this.getIndexFilePath(), JSON.stringify(sessions, null, 2));
        } catch (error) {
            console.error('[SessionStorageManager] Failed to save session index:', error);
        }
    }

    // ============================================
    // FILTERING LOGIC
    // ============================================

    /**
     * Check if a cookie should be saved (is auth-related)
     */
    private isAuthCookie(cookie: Cookie): boolean {
        // Check if it's an SSO domain cookie
        const isSSoDomain = SSO_DOMAINS.some(pattern => pattern.test(cookie.domain));
        if (isSSoDomain) {
            return true; // Keep all SSO domain cookies
        }

        // Check cookie name against auth patterns
        const isAuthPattern = AUTH_COOKIE_PATTERNS.some(pattern => pattern.test(cookie.name));
        if (isAuthPattern) {
            return true;
        }

        // Exclude known cache/tracking cookies
        const isCachePattern = CACHE_COOKIE_PATTERNS.some(pattern => pattern.test(cookie.name));
        if (isCachePattern) {
            return false;
        }

        // For non-matching cookies, keep HttpOnly cookies (often auth-related)
        // but exclude preference/settings cookies
        if (cookie.httpOnly && cookie.secure) {
            return true;
        }

        return false;
    }

    /**
     * Check if a localStorage entry should be saved
     */
    private isAuthLocalStorage(key: string): boolean {
        // Check against auth patterns
        const isAuthPattern = AUTH_LOCALSTORAGE_PATTERNS.some(pattern => pattern.test(key));
        if (isAuthPattern) {
            return true;
        }

        // Check against cache/UI state patterns
        const isCachePattern = CACHE_LOCALSTORAGE_PATTERNS.some(pattern => pattern.test(key));
        if (isCachePattern) {
            return false;
        }

        // Default: don't save (most localStorage is UI state)
        return false;
    }

    /**
     * Filter storage state to keep only auth-related data
     */
    public filterAuthOnly(state: StorageState): StorageState {
        const filteredCookies = state.cookies.filter(cookie => this.isAuthCookie(cookie));
        
        const filteredOrigins = state.origins.map(origin => ({
            origin: origin.origin,
            localStorage: origin.localStorage.filter(entry => this.isAuthLocalStorage(entry.name))
        })).filter(origin => origin.localStorage.length > 0); // Remove empty origins

        console.log(`[SessionStorageManager] Filtered cookies: ${state.cookies.length} -> ${filteredCookies.length}`);
        console.log(`[SessionStorageManager] Filtered origins: ${state.origins.length} -> ${filteredOrigins.length}`);

        return {
            cookies: filteredCookies,
            origins: filteredOrigins
        };
    }

    /**
     * Filter storage state with custom config
     */
    public filterWithConfig(state: StorageState, config: SessionFilterConfig): StorageState {
        let filteredCookies = state.cookies;

        // Apply domain filters
        if (config.includeDomains) {
            filteredCookies = filteredCookies.filter(c => 
                config.includeDomains!.some(p => p.test(c.domain))
            );
        }
        if (config.excludeDomains) {
            filteredCookies = filteredCookies.filter(c => 
                !config.excludeDomains!.some(p => p.test(c.domain))
            );
        }

        // Apply cookie name filters
        if (config.includeCookies) {
            filteredCookies = filteredCookies.filter(c => 
                config.includeCookies!.some(p => p.test(c.name))
            );
        }
        if (config.excludeCookies) {
            filteredCookies = filteredCookies.filter(c => 
                !config.excludeCookies!.some(p => p.test(c.name))
            );
        }

        // Apply localStorage filters
        const filteredOrigins = state.origins.map(origin => {
            let localStorage = origin.localStorage;

            if (config.includeLocalStorage) {
                localStorage = localStorage.filter(e =>
                    config.includeLocalStorage!.some(p => p.test(e.name))
                );
            }
            if (config.excludeLocalStorage) {
                localStorage = localStorage.filter(e =>
                    !config.excludeLocalStorage!.some(p => p.test(e.name))
                );
            }

            return { origin: origin.origin, localStorage };
        }).filter(o => o.localStorage.length > 0);

        return { cookies: filteredCookies, origins: filteredOrigins };
    }

    // ============================================
    // SAVE / RESTORE
    // ============================================

    /**
     * Save session from browser context (filtered for auth only)
     */
    public async saveSession(
        context: any,
        name: string,
        domain: string,
        filterAuthOnly: boolean = true
    ): Promise<SavedSession> {
        // Get full storage state from context
        const fullState: StorageState = await context.storageState();

        // Filter if requested
        const stateToSave = filterAuthOnly 
            ? this.filterAuthOnly(fullState)
            : fullState;

        // Generate session ID
        const sessionId = `${domain.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`;

        // Find earliest expiry in cookies
        const expiringCookies = stateToSave.cookies.filter(c => c.expires > 0);
        const earliestExpiry = expiringCookies.length > 0
            ? Math.min(...expiringCookies.map(c => c.expires * 1000))
            : undefined;

        // Save to file
        const filePath = this.getSessionFilePath(sessionId);
        fs.writeFileSync(filePath, JSON.stringify(stateToSave, null, 2));

        // Create session record
        const session: SavedSession = {
            id: sessionId,
            name,
            domain,
            savedAt: Date.now(),
            expiresAt: earliestExpiry,
            cookieCount: stateToSave.cookies.length,
            localStorageKeys: stateToSave.origins.flatMap(o => o.localStorage.map(e => e.name))
        };

        this.sessions.set(sessionId, session);
        this.saveSessionIndex();

        console.log(`[SessionStorageManager] Saved session: ${name} (${stateToSave.cookies.length} cookies)`);
        return session;
    }

    /**
     * Load session into browser context
     */
    public async loadSession(sessionId: string): Promise<StorageState | null> {
        const filePath = this.getSessionFilePath(sessionId);
        
        if (!fs.existsSync(filePath)) {
            console.warn(`[SessionStorageManager] Session file not found: ${sessionId}`);
            return null;
        }

        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const state: StorageState = JSON.parse(data);
            
            console.log(`[SessionStorageManager] Loaded session: ${sessionId} (${state.cookies.length} cookies)`);
            return state;
        } catch (error) {
            console.error(`[SessionStorageManager] Failed to load session: ${sessionId}`, error);
            return null;
        }
    }

    /**
     * Get session for a specific domain
     */
    public getSessionForDomain(domain: string): SavedSession | null {
        // Find most recent non-expired session for domain
        const domainSessions = Array.from(this.sessions.values())
            .filter(s => s.domain === domain || domain.includes(s.domain) || s.domain.includes(domain))
            .filter(s => !s.expiresAt || s.expiresAt > Date.now())
            .sort((a, b) => b.savedAt - a.savedAt);

        return domainSessions[0] || null;
    }

    /**
     * Get all saved sessions
     */
    public getAllSessions(): SavedSession[] {
        return Array.from(this.sessions.values()).sort((a, b) => b.savedAt - a.savedAt);
    }

    /**
     * Delete a session
     */
    public deleteSession(sessionId: string): boolean {
        const filePath = this.getSessionFilePath(sessionId);
        
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            this.sessions.delete(sessionId);
            this.saveSessionIndex();
            return true;
        } catch (error) {
            console.error(`[SessionStorageManager] Failed to delete session: ${sessionId}`, error);
            return false;
        }
    }

    /**
     * Delete all sessions for a domain
     */
    public deleteSessionsForDomain(domain: string): number {
        const toDelete = Array.from(this.sessions.values())
            .filter(s => s.domain === domain || domain.includes(s.domain));

        for (const session of toDelete) {
            this.deleteSession(session.id);
        }

        return toDelete.length;
    }

    /**
     * Clear all expired sessions
     */
    public clearExpiredSessions(): number {
        const now = Date.now();
        const expired = Array.from(this.sessions.values())
            .filter(s => s.expiresAt && s.expiresAt < now);

        for (const session of expired) {
            this.deleteSession(session.id);
        }

        return expired.length;
    }

    // ============================================
    // SESSION HEALTH
    // ============================================

    /**
     * Check if a session is likely still valid
     */
    public isSessionValid(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return false;

        // Check expiry
        if (session.expiresAt && session.expiresAt < Date.now()) {
            return false;
        }

        // Check file exists
        const filePath = this.getSessionFilePath(sessionId);
        if (!fs.existsSync(filePath)) {
            return false;
        }

        return true;
    }

    /**
     * Check session health by analyzing cookie expiry
     */
    public async analyzeSessionHealth(sessionId: string): Promise<{
        isValid: boolean;
        expiredCookies: number;
        validCookies: number;
        recommendations: string[];
    }> {
        const state = await this.loadSession(sessionId);
        
        if (!state) {
            return {
                isValid: false,
                expiredCookies: 0,
                validCookies: 0,
                recommendations: ['Session file not found. Please log in again.']
            };
        }

        const now = Date.now() / 1000;
        const expiredCookies = state.cookies.filter(c => c.expires > 0 && c.expires < now);
        const validCookies = state.cookies.filter(c => c.expires <= 0 || c.expires >= now);

        const recommendations: string[] = [];

        if (expiredCookies.length > 0) {
            recommendations.push(`${expiredCookies.length} cookies have expired. Re-authenticate recommended.`);
        }

        if (validCookies.length === 0) {
            recommendations.push('No valid cookies found. Please log in again.');
        }

        // Check for specific auth cookies
        const hasOktaCookies = state.cookies.some(c => /okta/i.test(c.name));
        const hasSessionCookies = state.cookies.some(c => /session|sid/i.test(c.name));

        if (!hasSessionCookies && !hasOktaCookies) {
            recommendations.push('No session/auth cookies found. Authentication may have failed.');
        }

        return {
            isValid: validCookies.length > 0 && expiredCookies.length === 0,
            expiredCookies: expiredCookies.length,
            validCookies: validCookies.length,
            recommendations
        };
    }

    // ============================================
    // CONTEXT CREATION HELPERS
    // ============================================

    /**
     * Create context options with session loaded
     */
    public async getContextOptionsWithSession(
        sessionId: string,
        additionalOptions: any = {}
    ): Promise<any> {
        const state = await this.loadSession(sessionId);
        
        if (!state) {
            return additionalOptions;
        }

        return {
            ...additionalOptions,
            storageState: state
        };
    }

    /**
     * Create fresh context options (no session, cache disabled)
     */
    public getFreshContextOptions(additionalOptions: any = {}): any {
        return {
            ...additionalOptions,
            storageState: undefined,
            // These help with fresh starts
            bypassCSP: true,
            ignoreHTTPSErrors: true
        };
    }
}

// Export singleton getter
export function getSessionStorageManager(): SessionStorageManager {
    return SessionStorageManager.getInstance();
}
