/**
 * NetworkInterceptor - Request interception and cache control for browser automation
 * 
 * Features:
 * - Intercept and modify HTTP requests/responses
 * - Force cache bypass for specific resources
 * - Block tracking/analytics requests
 * - Mock API responses for testing
 * - Network logging for debugging
 * 
 * @module NetworkInterceptor
 */

// ============================================
// TYPES
// ============================================

export interface InterceptionRule {
    /** Unique identifier for this rule */
    id: string;
    /** Name for display purposes */
    name: string;
    /** URL pattern to match (glob or regex) */
    urlPattern: string | RegExp;
    /** Type of interception */
    type: 'block' | 'modify-headers' | 'mock-response' | 'log-only';
    /** Whether rule is enabled */
    enabled: boolean;
    /** Headers to add/modify (for 'modify-headers') */
    headers?: Record<string, string>;
    /** Mock response (for 'mock-response') */
    mockResponse?: MockResponse;
    /** Priority (higher = processed first) */
    priority?: number;
}

export interface MockResponse {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Delay before responding (ms) */
    delay?: number;
}

export interface NetworkLogEntry {
    timestamp: number;
    url: string;
    method: string;
    resourceType: string;
    status?: number;
    duration?: number;
    blocked?: boolean;
    modified?: boolean;
    mocked?: boolean;
    error?: string;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    size?: number;
}

export interface NetworkStats {
    totalRequests: number;
    blockedRequests: number;
    modifiedRequests: number;
    mockedRequests: number;
    failedRequests: number;
    totalBytes: number;
    avgResponseTime: number;
}

// ============================================
// CONSTANTS
// ============================================

// Common tracking/analytics domains to block
const TRACKING_PATTERNS: RegExp[] = [
    /google-analytics\.com/i,
    /googletagmanager\.com/i,
    /doubleclick\.net/i,
    /facebook\.net/i,
    /facebook\.com\/tr/i,
    /connect\.facebook\.net/i,
    /analytics\./i,
    /hotjar\.com/i,
    /mixpanel\.com/i,
    /segment\.io/i,
    /segment\.com/i,
    /amplitude\.com/i,
    /intercom\.io/i,
    /crisp\.chat/i,
    /zendesk\.com/i,
    /fullstory\.com/i,
    /heap\.io/i,
    /pendo\.io/i,
    /optimizely\.com/i,
    /mouseflow\.com/i,
    /clarity\.ms/i,
    /newrelic\.com/i,
    /datadoghq\.com/i,
    /sentry\.io/i,
];

// Resource types that can be cached (don't force bypass)
const CACHEABLE_TYPES = new Set([
    'font',
    'image',
    'media',
    'stylesheet',
]);

// Resource types to always force fresh
const FORCE_FRESH_TYPES = new Set([
    'document',
    'xhr',
    'fetch',
    'script',
]);

// Cache bypass headers
const CACHE_BYPASS_HEADERS: Record<string, string> = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
};

// ============================================
// NETWORK INTERCEPTOR CLASS
// ============================================

export class NetworkInterceptor {
    private page: any = null;
    private rules: Map<string, InterceptionRule> = new Map();
    private logs: NetworkLogEntry[] = [];
    private maxLogEntries: number = 1000;
    private isIntercepting: boolean = false;
    private pendingRequests: Map<string, { startTime: number; entry: Partial<NetworkLogEntry> }> = new Map();
    
    // Stats
    private stats: NetworkStats = {
        totalRequests: 0,
        blockedRequests: 0,
        modifiedRequests: 0,
        mockedRequests: 0,
        failedRequests: 0,
        totalBytes: 0,
        avgResponseTime: 0,
    };

    constructor(page?: any) {
        if (page) {
            this.setPage(page);
        }
    }

    /**
     * Set the page to intercept
     */
    public setPage(page: any): void {
        this.page = page;
    }

    // ============================================
    // RULE MANAGEMENT
    // ============================================

    /**
     * Add an interception rule
     */
    public addRule(rule: InterceptionRule): void {
        this.rules.set(rule.id, rule);
        console.log(`[NetworkInterceptor] Added rule: ${rule.name} (${rule.type})`);
    }

    /**
     * Remove an interception rule
     */
    public removeRule(ruleId: string): boolean {
        const removed = this.rules.delete(ruleId);
        if (removed) {
            console.log(`[NetworkInterceptor] Removed rule: ${ruleId}`);
        }
        return removed;
    }

    /**
     * Enable/disable a rule
     */
    public setRuleEnabled(ruleId: string, enabled: boolean): void {
        const rule = this.rules.get(ruleId);
        if (rule) {
            rule.enabled = enabled;
        }
    }

    /**
     * Get all rules
     */
    public getRules(): InterceptionRule[] {
        return Array.from(this.rules.values());
    }

    /**
     * Add default tracking blocker rules
     */
    public addTrackingBlockerRules(): void {
        this.addRule({
            id: 'block-tracking',
            name: 'Block Tracking & Analytics',
            urlPattern: '.*',  // Will be checked against TRACKING_PATTERNS
            type: 'block',
            enabled: true,
            priority: 100,
        });
    }

    /**
     * Add cache bypass rules for dynamic content
     */
    public addCacheBypassRules(): void {
        this.addRule({
            id: 'cache-bypass-api',
            name: 'Bypass Cache for API Calls',
            urlPattern: /\/api\//i,
            type: 'modify-headers',
            enabled: true,
            headers: CACHE_BYPASS_HEADERS,
            priority: 90,
        });

        this.addRule({
            id: 'cache-bypass-documents',
            name: 'Bypass Cache for Documents',
            urlPattern: /\.(html|htm)(\?|$)/i,
            type: 'modify-headers',
            enabled: true,
            headers: CACHE_BYPASS_HEADERS,
            priority: 80,
        });
    }

    // ============================================
    // INTERCEPTION
    // ============================================

    /**
     * Start intercepting network requests
     */
    public async startInterception(options: {
        blockTracking?: boolean;
        bypassCache?: boolean;
        logAll?: boolean;
    } = {}): Promise<void> {
        if (!this.page) {
            throw new Error('Page not set. Call setPage() first.');
        }

        if (this.isIntercepting) {
            console.log('[NetworkInterceptor] Already intercepting');
            return;
        }

        const { blockTracking = true, bypassCache = true, logAll = true } = options;

        // Add default rules if requested
        if (blockTracking) {
            this.addTrackingBlockerRules();
        }
        if (bypassCache) {
            this.addCacheBypassRules();
        }

        // Set up request interception
        await this.page.route('**/*', async (route: any) => {
            const request = route.request();
            const url = request.url();
            const method = request.method();
            const resourceType = request.resourceType();
            const requestId = `${method}-${url}-${Date.now()}`;

            // Start tracking
            const startTime = Date.now();
            this.pendingRequests.set(requestId, {
                startTime,
                entry: {
                    timestamp: startTime,
                    url,
                    method,
                    resourceType,
                    requestHeaders: request.headers(),
                }
            });

            this.stats.totalRequests++;

            try {
                // Check against rules
                const matchingRule = this.findMatchingRule(url, resourceType);

                if (matchingRule) {
                    switch (matchingRule.type) {
                        case 'block':
                            // Check if this is a tracking request
                            if (matchingRule.id === 'block-tracking') {
                                if (this.isTrackingRequest(url)) {
                                    this.stats.blockedRequests++;
                                    this.logRequest(requestId, { blocked: true });
                                    await route.abort('blockedbyclient');
                                    return;
                                }
                            } else {
                                this.stats.blockedRequests++;
                                this.logRequest(requestId, { blocked: true });
                                await route.abort('blockedbyclient');
                                return;
                            }
                            break;

                        case 'modify-headers':
                            this.stats.modifiedRequests++;
                            const headers = {
                                ...request.headers(),
                                ...matchingRule.headers,
                            };
                            this.logRequest(requestId, { modified: true });
                            await route.continue({ headers });
                            return;

                        case 'mock-response':
                            if (matchingRule.mockResponse) {
                                this.stats.mockedRequests++;
                                const mock = matchingRule.mockResponse;
                                
                                if (mock.delay) {
                                    await new Promise(r => setTimeout(r, mock.delay));
                                }

                                this.logRequest(requestId, { 
                                    mocked: true, 
                                    status: mock.status 
                                });

                                await route.fulfill({
                                    status: mock.status,
                                    headers: mock.headers || { 'Content-Type': 'application/json' },
                                    body: mock.body || '',
                                });
                                return;
                            }
                            break;

                        case 'log-only':
                            // Just log, continue normally
                            break;
                    }
                }

                // Apply cache bypass for dynamic resources if enabled
                if (bypassCache && FORCE_FRESH_TYPES.has(resourceType)) {
                    const headers = {
                        ...request.headers(),
                        ...CACHE_BYPASS_HEADERS,
                    };
                    await route.continue({ headers });
                    return;
                }

                // Continue normally
                await route.continue();

            } catch (error: any) {
                this.stats.failedRequests++;
                this.logRequest(requestId, { error: error.message });
                
                // Try to continue anyway
                try {
                    await route.continue();
                } catch {
                    // Request may have been aborted
                }
            }
        });

        // Set up response listener for logging
        if (logAll) {
            this.page.on('response', async (response: any) => {
                const request = response.request();
                const url = request.url();
                const method = request.method();
                
                // Find pending request
                for (const [requestId, pending] of this.pendingRequests) {
                    if (requestId.includes(url) && requestId.includes(method)) {
                        const duration = Date.now() - pending.startTime;
                        
                        try {
                            const headers = await response.headers();
                            const size = parseInt(headers['content-length'] || '0', 10);
                            
                            this.logRequest(requestId, {
                                status: response.status(),
                                duration,
                                responseHeaders: headers,
                                size,
                            });

                            this.stats.totalBytes += size;
                            
                            // Update average response time
                            const completedCount = this.stats.totalRequests - this.pendingRequests.size;
                            if (completedCount > 0) {
                                this.stats.avgResponseTime = 
                                    (this.stats.avgResponseTime * (completedCount - 1) + duration) / completedCount;
                            }
                        } catch {
                            // Response may be incomplete
                        }

                        this.pendingRequests.delete(requestId);
                        break;
                    }
                }
            });
        }

        this.isIntercepting = true;
        console.log('[NetworkInterceptor] Started interception');
    }

    /**
     * Stop intercepting (remove all routes)
     */
    public async stopInterception(): Promise<void> {
        if (!this.page || !this.isIntercepting) {
            return;
        }

        try {
            await this.page.unroute('**/*');
        } catch {
            // May fail if page is closed
        }

        this.isIntercepting = false;
        console.log('[NetworkInterceptor] Stopped interception');
    }

    // ============================================
    // HELPER METHODS
    // ============================================

    /**
     * Check if URL matches tracking patterns
     */
    private isTrackingRequest(url: string): boolean {
        return TRACKING_PATTERNS.some(pattern => pattern.test(url));
    }

    /**
     * Find the highest priority matching rule
     */
    private findMatchingRule(url: string, resourceType: string): InterceptionRule | null {
        const enabledRules = Array.from(this.rules.values())
            .filter(r => r.enabled)
            .sort((a, b) => (b.priority || 0) - (a.priority || 0));

        for (const rule of enabledRules) {
            if (this.urlMatchesPattern(url, rule.urlPattern)) {
                return rule;
            }
        }

        return null;
    }

    /**
     * Check if URL matches a pattern
     */
    private urlMatchesPattern(url: string, pattern: string | RegExp): boolean {
        if (pattern instanceof RegExp) {
            return pattern.test(url);
        }
        
        // Convert glob to regex
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        
        return new RegExp(regexPattern, 'i').test(url);
    }

    /**
     * Log a request
     */
    private logRequest(requestId: string, updates: Partial<NetworkLogEntry>): void {
        const pending = this.pendingRequests.get(requestId);
        
        if (pending) {
            const entry: NetworkLogEntry = {
                ...pending.entry,
                ...updates,
            } as NetworkLogEntry;

            this.logs.push(entry);

            // Trim logs if too many
            if (this.logs.length > this.maxLogEntries) {
                this.logs = this.logs.slice(-this.maxLogEntries);
            }
        }
    }

    // ============================================
    // LOG ACCESS
    // ============================================

    /**
     * Get network logs
     */
    public getLogs(filter?: {
        urlPattern?: string | RegExp;
        method?: string;
        minStatus?: number;
        maxStatus?: number;
        blocked?: boolean;
        limit?: number;
    }): NetworkLogEntry[] {
        let filtered = [...this.logs];

        if (filter) {
            if (filter.urlPattern) {
                filtered = filtered.filter(e => this.urlMatchesPattern(e.url, filter.urlPattern!));
            }
            if (filter.method) {
                filtered = filtered.filter(e => e.method === filter.method);
            }
            if (filter.minStatus !== undefined) {
                filtered = filtered.filter(e => e.status && e.status >= filter.minStatus!);
            }
            if (filter.maxStatus !== undefined) {
                filtered = filtered.filter(e => e.status && e.status <= filter.maxStatus!);
            }
            if (filter.blocked !== undefined) {
                filtered = filtered.filter(e => e.blocked === filter.blocked);
            }
            if (filter.limit) {
                filtered = filtered.slice(-filter.limit);
            }
        }

        return filtered;
    }

    /**
     * Get network statistics
     */
    public getStats(): NetworkStats {
        return { ...this.stats };
    }

    /**
     * Clear logs
     */
    public clearLogs(): void {
        this.logs = [];
        this.pendingRequests.clear();
    }

    /**
     * Reset statistics
     */
    public resetStats(): void {
        this.stats = {
            totalRequests: 0,
            blockedRequests: 0,
            modifiedRequests: 0,
            mockedRequests: 0,
            failedRequests: 0,
            totalBytes: 0,
            avgResponseTime: 0,
        };
    }

    /**
     * Export logs to JSON
     */
    public exportLogs(): string {
        return JSON.stringify({
            stats: this.stats,
            logs: this.logs,
            exportedAt: Date.now(),
        }, null, 2);
    }

    // ============================================
    // CONVENIENCE METHODS
    // ============================================

    /**
     * Block a specific URL pattern
     */
    public blockUrl(pattern: string | RegExp, name?: string): string {
        const id = `block-${Date.now()}`;
        this.addRule({
            id,
            name: name || `Block ${typeof pattern === 'string' ? pattern : pattern.source}`,
            urlPattern: pattern,
            type: 'block',
            enabled: true,
        });
        return id;
    }

    /**
     * Mock an API endpoint
     */
    public mockApi(
        urlPattern: string | RegExp,
        response: { status?: number; body?: any; delay?: number },
        name?: string
    ): string {
        const id = `mock-${Date.now()}`;
        this.addRule({
            id,
            name: name || `Mock ${typeof urlPattern === 'string' ? urlPattern : urlPattern.source}`,
            urlPattern,
            type: 'mock-response',
            enabled: true,
            mockResponse: {
                status: response.status || 200,
                body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
                headers: { 'Content-Type': 'application/json' },
                delay: response.delay,
            },
        });
        return id;
    }

    /**
     * Add custom headers to requests matching pattern
     */
    public addHeaders(urlPattern: string | RegExp, headers: Record<string, string>, name?: string): string {
        const id = `headers-${Date.now()}`;
        this.addRule({
            id,
            name: name || `Headers for ${typeof urlPattern === 'string' ? urlPattern : urlPattern.source}`,
            urlPattern,
            type: 'modify-headers',
            enabled: true,
            headers,
        });
        return id;
    }

    /**
     * Check if currently intercepting
     */
    public isActive(): boolean {
        return this.isIntercepting;
    }
}

// ============================================
// FACTORY FUNCTION
// ============================================

export function createNetworkInterceptor(page?: any): NetworkInterceptor {
    return new NetworkInterceptor(page);
}
