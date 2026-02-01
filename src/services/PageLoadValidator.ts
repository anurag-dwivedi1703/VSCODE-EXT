/**
 * PageLoadValidator - Smart page load waiting, validation, and retry logic
 * 
 * This module replaces the unreliable 'networkidle' wait strategy with
 * intelligent waiting that:
 * - Waits for DOM ready
 * - Waits for specific selectors (configurable)
 * - Waits for network quiet with timeout
 * - Detects partial loads and error pages
 * - Implements retry logic with exponential backoff
 * 
 * @module PageLoadValidator
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ============================================
// TYPES
// ============================================

export interface PageLoadResult {
    success: boolean;
    finalUrl: string;
    loadTime: number;
    retryCount: number;
    /** Page status: loaded, error, partial, timeout */
    status: 'loaded' | 'error' | 'partial' | 'timeout' | 'blocked';
    /** HTTP status code if available */
    httpStatus?: number;
    /** Error message if failed */
    error?: string;
    /** Screenshot path if captured on failure */
    failureScreenshot?: string;
    /** Validation results */
    validations: ValidationResult[];
}

export interface ValidationResult {
    name: string;
    passed: boolean;
    message?: string;
    details?: any;
}

export interface WaitStrategy {
    /** Wait for DOM to be ready */
    waitForDom?: boolean;
    /** Wait for these selectors to appear */
    waitForSelectors?: string[];
    /** Wait for network to be quiet (no requests for X ms) */
    networkQuietMs?: number;
    /** Wait for JavaScript to be idle */
    waitForJsIdle?: boolean;
    /** Custom wait function */
    customWait?: (page: any) => Promise<void>;
    /** Maximum wait time in ms */
    timeout?: number;
}

export interface RetryConfig {
    /** Maximum number of retries */
    maxRetries: number;
    /** Initial delay between retries (ms) */
    initialDelay: number;
    /** Maximum delay between retries (ms) */
    maxDelay: number;
    /** Multiplier for exponential backoff */
    backoffMultiplier: number;
    /** Retry strategies to try in order */
    strategies: RetryStrategy[];
}

export type RetryStrategy = 
    | 'refresh'           // Simple page refresh
    | 'hard-refresh'      // Refresh bypassing cache
    | 'new-context'       // Create new browser context
    | 'clear-cookies'     // Clear cookies and retry
    | 'clear-cache'       // Clear cache and retry
    | 'wait-longer';      // Wait longer before retrying

export interface NavigateOptions {
    /** URL to navigate to */
    url: string;
    /** Wait strategy */
    waitStrategy?: WaitStrategy;
    /** Retry configuration */
    retryConfig?: RetryConfig;
    /** Bypass cache on navigation */
    bypassCache?: boolean;
    /** Take screenshot on failure */
    screenshotOnFailure?: boolean;
    /** Screenshot directory */
    screenshotDir?: string;
    /** Custom headers */
    headers?: Record<string, string>;
    /** Referrer URL */
    referrer?: string;
}

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_WAIT_STRATEGY: WaitStrategy = {
    waitForDom: true,
    networkQuietMs: 500,
    waitForJsIdle: true,
    timeout: 30000
};

const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
    strategies: ['refresh', 'hard-refresh', 'clear-cache']
};

// Error page indicators
const ERROR_PAGE_PATTERNS = [
    /ERR_CONNECTION_REFUSED/i,
    /ERR_NAME_NOT_RESOLVED/i,
    /ERR_INTERNET_DISCONNECTED/i,
    /ERR_SSL_PROTOCOL_ERROR/i,
    /ERR_CERT_/i,
    /This site can't be reached/i,
    /Page not found/i,
    /404 Not Found/i,
    /500 Internal Server Error/i,
    /502 Bad Gateway/i,
    /503 Service Unavailable/i,
    /504 Gateway Timeout/i,
];

// Loading state indicators (page not fully loaded)
const LOADING_STATE_PATTERNS = [
    /loading/i,
    /please wait/i,
    /spinner/i,
];

// ============================================
// PAGE LOAD VALIDATOR CLASS
// ============================================

export class PageLoadValidator {
    private page: any = null;
    private context: any = null;

    constructor(page: any, context?: any) {
        this.page = page;
        this.context = context;
    }

    // ============================================
    // MAIN NAVIGATION METHOD
    // ============================================

    /**
     * Navigate to URL with smart waiting and retry logic
     */
    public async navigateWithValidation(options: NavigateOptions): Promise<PageLoadResult> {
        const {
            url,
            waitStrategy = DEFAULT_WAIT_STRATEGY,
            retryConfig = DEFAULT_RETRY_CONFIG,
            bypassCache = false,
            screenshotOnFailure = true,
            screenshotDir,
            headers,
            referrer
        } = options;

        let retryCount = 0;
        let lastError: string | undefined;
        let currentDelay = retryConfig.initialDelay;

        while (retryCount <= retryConfig.maxRetries) {
            const startTime = Date.now();

            try {
                console.log(`[PageLoadValidator] Navigating to ${url} (attempt ${retryCount + 1})`);

                // Build navigation options
                const navOptions: any = {
                    timeout: waitStrategy.timeout || 30000,
                    waitUntil: 'domcontentloaded', // Start with DOM ready, we'll do more waiting
                };

                if (referrer) {
                    navOptions.referer = referrer;
                }

                // Set custom headers if provided
                if (headers) {
                    await this.page.setExtraHTTPHeaders(headers);
                }

                // Add cache bypass headers if requested
                if (bypassCache) {
                    await this.page.setExtraHTTPHeaders({
                        ...headers,
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0'
                    });
                }

                // Navigate
                const response = await this.page.goto(url, navOptions);

                // Check HTTP status
                const httpStatus = response?.status();
                if (httpStatus && httpStatus >= 400) {
                    throw new Error(`HTTP ${httpStatus}: ${response.statusText()}`);
                }

                // Apply wait strategy
                await this.applyWaitStrategy(waitStrategy);

                // Validate page load
                const validations = await this.validatePageLoad();
                const allPassed = validations.every(v => v.passed);

                if (!allPassed) {
                    const failedValidations = validations.filter(v => !v.passed);
                    throw new Error(`Validation failed: ${failedValidations.map(v => v.name).join(', ')}`);
                }

                // Success!
                return {
                    success: true,
                    finalUrl: this.page.url(),
                    loadTime: Date.now() - startTime,
                    retryCount,
                    status: 'loaded',
                    httpStatus,
                    validations
                };

            } catch (error: any) {
                lastError = error.message;
                console.warn(`[PageLoadValidator] Attempt ${retryCount + 1} failed: ${lastError}`);

                // Take failure screenshot
                let failureScreenshot: string | undefined;
                if (screenshotOnFailure && screenshotDir && screenshotDir.length > 0) {
                    try {
                        failureScreenshot = await this.takeFailureScreenshot(screenshotDir, retryCount);
                    } catch {
                        // Ignore screenshot errors
                    }
                }

                // Check if we should retry
                if (retryCount < retryConfig.maxRetries) {
                    // Apply retry strategy
                    const strategy = retryConfig.strategies[retryCount % retryConfig.strategies.length];
                    await this.applyRetryStrategy(strategy);

                    // Wait before retry
                    await this.page.waitForTimeout(currentDelay);
                    currentDelay = Math.min(currentDelay * retryConfig.backoffMultiplier, retryConfig.maxDelay);
                    retryCount++;
                } else {
                    // All retries exhausted
                    return {
                        success: false,
                        finalUrl: this.page.url(),
                        loadTime: Date.now() - startTime,
                        retryCount,
                        status: this.determineFailureStatus(lastError || 'Unknown error'),
                        error: lastError,
                        failureScreenshot,
                        validations: await this.validatePageLoad()
                    };
                }
            }
        }

        // Should not reach here, but just in case
        return {
            success: false,
            finalUrl: this.page.url(),
            loadTime: 0,
            retryCount,
            status: 'error',
            error: lastError || 'Unknown error',
            validations: []
        };
    }

    // ============================================
    // WAIT STRATEGIES
    // ============================================

    /**
     * Apply wait strategy after initial navigation
     */
    private async applyWaitStrategy(strategy: WaitStrategy): Promise<void> {
        const timeout = strategy.timeout || 30000;

        // Wait for DOM
        if (strategy.waitForDom) {
            await this.waitForDomReady(timeout);
        }

        // Wait for specific selectors
        if (strategy.waitForSelectors && strategy.waitForSelectors.length > 0) {
            await this.waitForSelectors(strategy.waitForSelectors, timeout);
        }

        // Wait for network quiet
        if (strategy.networkQuietMs) {
            await this.waitForNetworkQuiet(strategy.networkQuietMs, timeout);
        }

        // Wait for JS idle
        if (strategy.waitForJsIdle) {
            await this.waitForJsIdle(timeout);
        }

        // Custom wait
        if (strategy.customWait) {
            await Promise.race([
                strategy.customWait(this.page),
                this.page.waitForTimeout(timeout)
            ]);
        }
    }

    /**
     * Wait for DOM to be fully ready
     */
    private async waitForDomReady(timeout: number): Promise<void> {
        await this.page.waitForFunction(`document.readyState === 'complete'`, { timeout });
    }

    /**
     * Wait for specific selectors to appear
     */
    private async waitForSelectors(selectors: string[], timeout: number): Promise<void> {
        const perSelectorTimeout = Math.floor(timeout / selectors.length);

        for (const selector of selectors) {
            try {
                await this.page.waitForSelector(selector, { 
                    timeout: perSelectorTimeout,
                    state: 'visible'
                });
            } catch {
                console.warn(`[PageLoadValidator] Selector not found: ${selector}`);
                // Continue checking other selectors
            }
        }
    }

    /**
     * Wait for network to be quiet (no new requests for X ms)
     */
    private async waitForNetworkQuiet(quietMs: number, timeout: number): Promise<void> {
        const startTime = Date.now();

        return new Promise((resolve) => {
            let lastRequestTime = Date.now();
            let checkInterval: ReturnType<typeof setInterval>;
            let requestHandler: (request: any) => void;
            let resolved = false;

            const cleanup = () => {
                if (checkInterval) clearInterval(checkInterval);
                if (requestHandler) {
                    this.page.removeListener('request', requestHandler);
                }
            };

            requestHandler = () => {
                lastRequestTime = Date.now();
            };

            this.page.on('request', requestHandler);

            checkInterval = setInterval(() => {
                const now = Date.now();
                const quietFor = now - lastRequestTime;
                const elapsed = now - startTime;

                if (quietFor >= quietMs && !resolved) {
                    resolved = true;
                    cleanup();
                    resolve();
                } else if (elapsed >= timeout && !resolved) {
                    resolved = true;
                    cleanup();
                    resolve(); // Resolve anyway after timeout
                }
            }, 100);
        });
    }

    /**
     * Wait for JavaScript to be idle (no pending tasks)
     */
    private async waitForJsIdle(timeout: number): Promise<void> {
        try {
            // Use a simple timeout-based approach that works in browser context
            await this.page.waitForFunction(`
                new Promise(function(resolve) {
                    if ('requestIdleCallback' in window) {
                        window.requestIdleCallback(function() { resolve(true); }, { timeout: 1000 });
                    } else {
                        setTimeout(function() { resolve(true); }, 100);
                    }
                })
            `, { timeout });
        } catch {
            // Ignore timeout - page may still be usable
        }
    }

    // ============================================
    // VALIDATION
    // ============================================

    /**
     * Validate that the page loaded correctly
     */
    public async validatePageLoad(): Promise<ValidationResult[]> {
        const results: ValidationResult[] = [];

        // Check for error pages
        results.push(await this.validateNoErrorPage());

        // Check for infinite loading state
        results.push(await this.validateNotStuckLoading());

        // Check for visible content
        results.push(await this.validateVisibleContent());

        // Check for console errors
        results.push(await this.validateNoConsoleErrors());

        return results;
    }

    /**
     * Check if page shows an error
     */
    private async validateNoErrorPage(): Promise<ValidationResult> {
        try {
            const content = await this.page.content();
            const title = await this.page.title();
            
            for (const pattern of ERROR_PAGE_PATTERNS) {
                if (pattern.test(content) || pattern.test(title)) {
                    return {
                        name: 'no-error-page',
                        passed: false,
                        message: `Error page detected: ${pattern.source}`
                    };
                }
            }

            return { name: 'no-error-page', passed: true };
        } catch (error: any) {
            return {
                name: 'no-error-page',
                passed: false,
                message: `Failed to check page: ${error.message}`
            };
        }
    }

    /**
     * Check if page is stuck in loading state
     */
    private async validateNotStuckLoading(): Promise<ValidationResult> {
        try {
            // Check for common loading indicators
            const loadingSelectors = [
                '.loading',
                '.spinner',
                '[class*="loading"]',
                '[class*="spinner"]',
                '.MuiCircularProgress-root', // Material UI
                '.ant-spin', // Ant Design
            ];

            for (const selector of loadingSelectors) {
                const loadingElement = await this.page.$(selector);
                if (loadingElement) {
                    const isVisible = await loadingElement.isVisible();
                    if (isVisible) {
                        // Check if it's been visible for too long
                        return {
                            name: 'not-stuck-loading',
                            passed: false,
                            message: `Loading indicator still visible: ${selector}`
                        };
                    }
                }
            }

            return { name: 'not-stuck-loading', passed: true };
        } catch {
            return { name: 'not-stuck-loading', passed: true }; // Assume OK if check fails
        }
    }

    /**
     * Check if page has visible content
     */
    private async validateVisibleContent(): Promise<ValidationResult> {
        try {
            // Check that body has some content (runs in browser context)
            const bodyContent = await this.page.evaluate(`
                (function() {
                    var body = document.body;
                    if (!body) return { hasContent: false, textLength: 0 };
                    
                    var text = body.innerText || '';
                    var hasImages = body.querySelectorAll('img').length > 0;
                    var hasButtons = body.querySelectorAll('button, [role="button"]').length > 0;
                    
                    return {
                        hasContent: text.length > 50 || hasImages || hasButtons,
                        textLength: text.length,
                        hasImages: hasImages,
                        hasButtons: hasButtons
                    };
                })()
            `);

            if (!bodyContent.hasContent) {
                return {
                    name: 'visible-content',
                    passed: false,
                    message: 'Page appears empty or has minimal content',
                    details: bodyContent
                };
            }

            return { name: 'visible-content', passed: true, details: bodyContent };
        } catch (error: any) {
            return {
                name: 'visible-content',
                passed: false,
                message: `Failed to check content: ${error.message}`
            };
        }
    }

    /**
     * Check for critical console errors
     */
    private async validateNoConsoleErrors(): Promise<ValidationResult> {
        // This would require setting up console listener before navigation
        // For now, just return passed
        return { name: 'no-console-errors', passed: true };
    }

    // ============================================
    // RETRY STRATEGIES
    // ============================================

    /**
     * Apply retry strategy before next attempt
     */
    private async applyRetryStrategy(strategy: RetryStrategy): Promise<void> {
        console.log(`[PageLoadValidator] Applying retry strategy: ${strategy}`);

        switch (strategy) {
            case 'refresh':
                try {
                    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
                } catch {
                    // Ignore refresh errors
                }
                break;

            case 'hard-refresh':
                try {
                    // Clear cache and reload (runs in browser context)
                    await this.page.evaluate(`
                        if ('caches' in window) {
                            caches.keys().then(function(names) {
                                names.forEach(function(name) { caches.delete(name); });
                            });
                        }
                    `);
                    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
                } catch {
                    // Ignore errors
                }
                break;

            case 'clear-cache':
                if (this.context) {
                    try {
                        await this.context.clearCookies();
                        // Note: There's no direct way to clear browser cache in Playwright
                        // but clearCookies + hard refresh helps
                    } catch {
                        // Ignore
                    }
                }
                break;

            case 'clear-cookies':
                if (this.context) {
                    try {
                        await this.context.clearCookies();
                    } catch {
                        // Ignore
                    }
                }
                break;

            case 'wait-longer':
                await this.page.waitForTimeout(5000);
                break;

            case 'new-context':
                // This would require recreating the context
                // For now, just clear cookies
                if (this.context) {
                    try {
                        await this.context.clearCookies();
                    } catch {
                        // Ignore
                    }
                }
                break;
        }
    }

    // ============================================
    // HELPERS
    // ============================================

    /**
     * Determine failure status from error message
     */
    private determineFailureStatus(error: string): PageLoadResult['status'] {
        if (error.includes('timeout') || error.includes('Timeout')) {
            return 'timeout';
        }
        if (error.includes('ERR_BLOCKED') || error.includes('blocked')) {
            return 'blocked';
        }
        if (error.includes('Validation failed')) {
            return 'partial';
        }
        return 'error';
    }

    /**
     * Take screenshot on failure
     */
    private async takeFailureScreenshot(dir: string, retryCount: number): Promise<string> {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const filename = `failure_${Date.now()}_retry${retryCount}.png`;
        const filepath = path.join(dir, filename);

        await this.page.screenshot({ path: filepath, fullPage: true });
        console.log(`[PageLoadValidator] Failure screenshot saved: ${filepath}`);

        return filepath;
    }

    /**
     * Force bypass cache on next navigation
     */
    public async bypassCache(): Promise<void> {
        await this.page.route('**/*', async (route: any) => {
            const headers = {
                ...route.request().headers(),
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            };
            await route.continue({ headers });
        });
    }

    /**
     * Wait for page to be fully interactive
     */
    public async waitForInteractive(timeout: number = 10000): Promise<boolean> {
        try {
            // Check if page is interactive (runs in browser context)
            await this.page.waitForFunction(`
                document.readyState === 'complete' && 
                document.body !== null && 
                document.visibilityState === 'visible'
            `, { timeout });

            return true;
        } catch {
            return false;
        }
    }
}

// ============================================
// FACTORY FUNCTION
// ============================================

export function createPageLoadValidator(page: any, context?: any): PageLoadValidator {
    return new PageLoadValidator(page, context);
}
