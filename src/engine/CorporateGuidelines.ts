/**
 * CorporateGuidelines.ts
 * 
 * Built-in best practice rules based on industry standards:
 * - OWASP Security Guidelines
 * - SOLID Principles
 * - Clean Code Practices
 * - Performance Best Practices
 * 
 * Users can enable/disable these guidelines via VS Code settings.
 * These rules are injected into the constitution when enabled.
 */

import { AgentRule, EnforcementLevel } from './ConstitutionSchema';

// ============================================
// GUIDELINE CATEGORIES
// ============================================

export type GuidelineCategory = 'security' | 'performance' | 'maintainability' | 'testing' | 'accessibility';

export interface GuidelineRule extends AgentRule {
    /** OWASP/SOLID/etc reference ID */
    referenceId?: string;
    /** External documentation link */
    documentationUrl?: string;
    /** Code examples of what to avoid */
    badExample?: string;
    /** Code examples of what to do */
    goodExample?: string;
}

// ============================================
// SECURITY GUIDELINES (OWASP-inspired)
// ============================================

export const SECURITY_GUIDELINES: GuidelineRule[] = [
    // A01:2021 - Broken Access Control
    {
        id: 'SEC-001',
        referenceId: 'OWASP-A01',
        description: 'Never commit secrets to version control',
        enforcement: 'strict',
        autoDetect: true,
        pattern: 'api[_-]?key|password|secret|token|private[_-]?key',
        reason: 'Exposed secrets can lead to unauthorized access and data breaches',
        category: 'security',
        documentationUrl: 'https://owasp.org/Top10/A01_2021-Broken_Access_Control/'
    },
    {
        id: 'SEC-002',
        referenceId: 'OWASP-A03',
        description: 'Use parameterized queries for database access',
        enforcement: 'strict',
        autoDetect: true,
        pattern: '\\$\\{.*\\}.*(?:SELECT|INSERT|UPDATE|DELETE)',
        reason: 'String interpolation in SQL queries allows SQL injection attacks',
        category: 'security',
        badExample: 'db.query(`SELECT * FROM users WHERE id = ${userId}`)',
        goodExample: 'db.query("SELECT * FROM users WHERE id = ?", [userId])',
        documentationUrl: 'https://owasp.org/Top10/A03_2021-Injection/'
    },
    {
        id: 'SEC-003',
        referenceId: 'OWASP-A03',
        description: 'Validate all user input before processing',
        enforcement: 'strict',
        autoDetect: false,
        reason: 'Unvalidated input can lead to injection attacks and data corruption',
        category: 'security'
    },
    {
        id: 'SEC-004',
        referenceId: 'OWASP-A07',
        description: 'Never use eval() or Function() with user input',
        enforcement: 'strict',
        autoDetect: true,
        pattern: '\\beval\\s*\\(|new\\s+Function\\s*\\(',
        reason: 'eval() allows arbitrary code execution',
        category: 'security'
    },
    {
        id: 'SEC-005',
        referenceId: 'OWASP-A02',
        description: 'Use strong password hashing (bcrypt, argon2)',
        enforcement: 'strict',
        autoDetect: false,
        reason: 'Weak hashing allows attackers to recover passwords from breaches',
        category: 'security'
    },
    {
        id: 'SEC-006',
        referenceId: 'XSS',
        description: 'Sanitize HTML content before rendering',
        enforcement: 'strict',
        autoDetect: true,
        pattern: '\\.innerHTML\\s*=',
        reason: 'Unsanitized HTML can lead to XSS attacks',
        category: 'security',
        badExample: 'element.innerHTML = userContent',
        goodExample: 'element.textContent = userContent; // or use DOMPurify'
    },
    {
        id: 'SEC-007',
        referenceId: 'CORS',
        description: 'Configure CORS properly - do not use wildcard (*) in production',
        enforcement: 'warning',
        autoDetect: true,
        pattern: 'Access-Control-Allow-Origin.*\\*|cors\\s*:\\s*true',
        reason: 'Wildcard CORS allows any domain to access your API',
        category: 'security'
    },
    {
        id: 'SEC-008',
        referenceId: 'HTTPS',
        description: 'Always use HTTPS for external requests',
        enforcement: 'warning',
        autoDetect: true,
        pattern: '[\'"]http:\\/\\/(?!localhost|127\\.0\\.0\\.1)',
        reason: 'HTTP traffic can be intercepted and modified',
        category: 'security'
    },
];

// ============================================
// PERFORMANCE GUIDELINES
// ============================================

export const PERFORMANCE_GUIDELINES: GuidelineRule[] = [
    {
        id: 'PERF-001',
        description: 'Avoid N+1 queries in loops',
        enforcement: 'warning',
        autoDetect: false,
        reason: 'N+1 queries cause database performance issues at scale',
        category: 'performance',
        badExample: 'users.forEach(user => db.query("SELECT * FROM orders WHERE user_id = ?", user.id))',
        goodExample: 'db.query("SELECT * FROM orders WHERE user_id IN (?)", userIds)'
    },
    {
        id: 'PERF-002',
        description: 'Use pagination for large data sets',
        enforcement: 'warning',
        autoDetect: false,
        reason: 'Loading all data at once causes memory issues and slow responses',
        category: 'performance'
    },
    {
        id: 'PERF-003',
        description: 'Memoize expensive computations',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Repeated expensive calculations waste CPU cycles',
        category: 'performance'
    },
    {
        id: 'PERF-004',
        description: 'Use lazy loading for large imports',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Loading everything upfront increases initial load time',
        category: 'performance',
        badExample: 'import { heavyModule } from "./heavy"',
        goodExample: 'const heavyModule = await import("./heavy")'
    },
    {
        id: 'PERF-005',
        description: 'Avoid synchronous file operations in async code',
        enforcement: 'warning',
        autoDetect: true,
        pattern: 'fs\\.(?:readFileSync|writeFileSync|readdirSync)',
        reason: 'Sync file operations block the event loop',
        category: 'performance'
    },
    {
        id: 'PERF-006',
        description: 'Use connection pooling for databases',
        enforcement: 'warning',
        autoDetect: false,
        reason: 'Creating new connections per request is slow and resource-intensive',
        category: 'performance'
    },
    {
        id: 'PERF-007',
        description: 'Debounce or throttle frequent events',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Processing every event can overwhelm the system',
        category: 'performance'
    },
];

// ============================================
// MAINTAINABILITY GUIDELINES (SOLID-inspired)
// ============================================

export const MAINTAINABILITY_GUIDELINES: GuidelineRule[] = [
    // Single Responsibility Principle
    {
        id: 'MAINT-001',
        referenceId: 'SOLID-S',
        description: 'Functions should do one thing (Single Responsibility)',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Functions with multiple responsibilities are hard to test and maintain',
        category: 'maintainability'
    },
    // Open/Closed Principle
    {
        id: 'MAINT-002',
        referenceId: 'SOLID-O',
        description: 'Extend behavior through composition, not modification',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Modifying existing code risks breaking existing functionality',
        category: 'maintainability'
    },
    // Dependency Inversion
    {
        id: 'MAINT-003',
        referenceId: 'SOLID-D',
        description: 'Depend on abstractions, not concrete implementations',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Tight coupling makes code hard to test and change',
        category: 'maintainability'
    },
    // DRY
    {
        id: 'MAINT-004',
        referenceId: 'DRY',
        description: 'Avoid code duplication - extract common logic',
        enforcement: 'warning',
        autoDetect: false,
        reason: 'Duplicated code must be updated in multiple places, leading to bugs',
        category: 'maintainability'
    },
    // Avoid deep nesting
    {
        id: 'MAINT-005',
        description: 'Avoid deeply nested callbacks or conditionals (max 3 levels)',
        enforcement: 'warning',
        autoDetect: false,
        reason: 'Deep nesting is hard to read and understand',
        category: 'maintainability',
        badExample: 'if (a) { if (b) { if (c) { if (d) { ... } } } }',
        goodExample: 'if (!a || !b || !c) return; // early returns'
    },
    // Meaningful names
    {
        id: 'MAINT-006',
        description: 'Use meaningful variable and function names',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Good names make code self-documenting',
        category: 'maintainability',
        badExample: 'const x = getUsersByAge(25).filter(u => u.status === "a")',
        goodExample: 'const activeUsers = getUsersByAge(25).filter(user => user.status === "active")'
    },
    // File size
    {
        id: 'MAINT-007',
        description: 'Keep files under 500 lines - split if larger',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Large files are hard to navigate and understand',
        category: 'maintainability'
    },
    // Function length
    {
        id: 'MAINT-008',
        description: 'Keep functions under 50 lines',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Long functions usually do too much and are hard to test',
        category: 'maintainability'
    },
    // Magic numbers
    {
        id: 'MAINT-009',
        description: 'Use named constants instead of magic numbers',
        enforcement: 'warning',
        autoDetect: false,
        reason: 'Magic numbers are unclear and hard to change consistently',
        category: 'maintainability',
        badExample: 'if (response.status === 200)',
        goodExample: 'const HTTP_OK = 200; if (response.status === HTTP_OK)'
    },
    // Comments
    {
        id: 'MAINT-010',
        description: 'Comment "why", not "what" - code should be self-explanatory',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Comments that describe obvious code become outdated and misleading',
        category: 'maintainability'
    },
];

// ============================================
// TESTING GUIDELINES
// ============================================

export const TESTING_GUIDELINES: GuidelineRule[] = [
    {
        id: 'TEST-001',
        description: 'Write unit tests for business logic',
        enforcement: 'warning',
        autoDetect: false,
        reason: 'Tests catch regressions and document expected behavior',
        category: 'testing'
    },
    {
        id: 'TEST-002',
        description: 'Tests should be independent - no shared state',
        enforcement: 'warning',
        autoDetect: false,
        reason: 'Shared state causes flaky tests and order dependencies',
        category: 'testing'
    },
    {
        id: 'TEST-003',
        description: 'Mock external dependencies (APIs, databases)',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Real dependencies make tests slow and unreliable',
        category: 'testing'
    },
    {
        id: 'TEST-004',
        description: 'Test edge cases and error conditions',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Edge cases are where bugs often hide',
        category: 'testing'
    },
    {
        id: 'TEST-005',
        description: 'Use descriptive test names that explain the scenario',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Good test names serve as documentation',
        category: 'testing',
        badExample: 'test("test1", () => ...)',
        goodExample: 'test("should return empty array when no users match filter", () => ...)'
    },
    {
        id: 'TEST-006',
        description: 'MUST attempt automated browser testing before falling back to manual verification',
        enforcement: 'strict',
        autoDetect: false,
        reason: 'User may have secrets configured and can complete auth via LoginCheckpoint. Never assume testing will fail - try first and report specific errors.',
        category: 'testing',
        badExample: 'Skipping browser testing because auth is required',
        goodExample: 'Attempted browser testing, got AUTH_REQUIRED at /login. Waiting for user to complete LoginCheckpoint.'
    },
];

// ============================================
// ACCESSIBILITY GUIDELINES
// ============================================

export const ACCESSIBILITY_GUIDELINES: GuidelineRule[] = [
    {
        id: 'A11Y-001',
        referenceId: 'WCAG-1.1.1',
        description: 'All images must have alt text',
        enforcement: 'warning',
        autoDetect: true,
        pattern: '<img(?![^>]*alt=)[^>]*>',
        reason: 'Screen readers need alt text to describe images',
        category: 'accessibility'
    },
    {
        id: 'A11Y-002',
        referenceId: 'WCAG-2.4.6',
        description: 'Use semantic HTML elements (nav, main, article, etc.)',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Semantic elements help assistive technologies understand page structure',
        category: 'accessibility'
    },
    {
        id: 'A11Y-003',
        referenceId: 'WCAG-1.4.3',
        description: 'Ensure sufficient color contrast (4.5:1 for text)',
        enforcement: 'suggestion',
        autoDetect: false,
        reason: 'Low contrast makes text hard to read for many users',
        category: 'accessibility'
    },
    {
        id: 'A11Y-004',
        referenceId: 'WCAG-2.1.1',
        description: 'All interactive elements must be keyboard accessible',
        enforcement: 'warning',
        autoDetect: false,
        reason: 'Some users cannot use a mouse',
        category: 'accessibility'
    },
];

// ============================================
// CORPORATE GUIDELINES AGGREGATION
// ============================================

export interface CorporateGuidelinesConfig {
    security: boolean;
    performance: boolean;
    maintainability: boolean;
    testing: boolean;
    accessibility: boolean;
}

export const DEFAULT_GUIDELINES_CONFIG: CorporateGuidelinesConfig = {
    security: true,
    performance: true,
    maintainability: false,  // Off by default as these are more subjective
    testing: false,          // Off by default
    accessibility: false     // Off by default
};

/**
 * Get all enabled guidelines based on configuration
 */
export function getEnabledGuidelines(config: Partial<CorporateGuidelinesConfig>): GuidelineRule[] {
    const mergedConfig = { ...DEFAULT_GUIDELINES_CONFIG, ...config };
    const rules: GuidelineRule[] = [];

    if (mergedConfig.security) {
        rules.push(...SECURITY_GUIDELINES);
    }
    if (mergedConfig.performance) {
        rules.push(...PERFORMANCE_GUIDELINES);
    }
    if (mergedConfig.maintainability) {
        rules.push(...MAINTAINABILITY_GUIDELINES);
    }
    if (mergedConfig.testing) {
        rules.push(...TESTING_GUIDELINES);
    }
    if (mergedConfig.accessibility) {
        rules.push(...ACCESSIBILITY_GUIDELINES);
    }

    return rules;
}

/**
 * Convert guidelines to agent constraints
 */
export function guidelinesToAgentConstraints(guidelines: GuidelineRule[]): {
    must: AgentRule[];
    mustNot: AgentRule[];
    should: AgentRule[];
} {
    const must: AgentRule[] = [];
    const mustNot: AgentRule[] = [];
    const should: AgentRule[] = [];

    for (const rule of guidelines) {
        const agentRule: AgentRule = {
            id: rule.id,
            description: rule.description,
            enforcement: rule.enforcement,
            autoDetect: rule.autoDetect,
            pattern: rule.pattern,
            reason: rule.reason,
            category: rule.category
        };

        // Categorize based on enforcement and description
        if (rule.enforcement === 'strict') {
            // Check if it's a "don't do" rule
            if (rule.description.toLowerCase().startsWith('never') ||
                rule.description.toLowerCase().startsWith('avoid') ||
                rule.description.toLowerCase().includes('do not')) {
                mustNot.push(agentRule);
            } else {
                must.push(agentRule);
            }
        } else if (rule.enforcement === 'warning') {
            if (rule.description.toLowerCase().startsWith('never') ||
                rule.description.toLowerCase().startsWith('avoid')) {
                mustNot.push(agentRule);
            } else {
                should.push(agentRule);
            }
        } else {
            should.push(agentRule);
        }
    }

    return { must, mustNot, should };
}

/**
 * Get guideline by ID
 */
export function getGuidelineById(id: string): GuidelineRule | undefined {
    const allGuidelines = [
        ...SECURITY_GUIDELINES,
        ...PERFORMANCE_GUIDELINES,
        ...MAINTAINABILITY_GUIDELINES,
        ...TESTING_GUIDELINES,
        ...ACCESSIBILITY_GUIDELINES
    ];

    return allGuidelines.find(g => g.id === id);
}

/**
 * Get all guidelines for a category
 */
export function getGuidelinesByCategory(category: GuidelineCategory): GuidelineRule[] {
    switch (category) {
        case 'security':
            return SECURITY_GUIDELINES;
        case 'performance':
            return PERFORMANCE_GUIDELINES;
        case 'maintainability':
            return MAINTAINABILITY_GUIDELINES;
        case 'testing':
            return TESTING_GUIDELINES;
        case 'accessibility':
            return ACCESSIBILITY_GUIDELINES;
        default:
            return [];
    }
}

/**
 * Format guidelines for display in UI
 */
export function formatGuidelineForDisplay(rule: GuidelineRule): string {
    const icon = rule.enforcement === 'strict' ? '🔴' :
        rule.enforcement === 'warning' ? '🟡' : '🟢';

    let text = `${icon} **${rule.id}**: ${rule.description}`;

    if (rule.referenceId) {
        text += ` (${rule.referenceId})`;
    }

    if (rule.reason) {
        text += `\n   *${rule.reason}*`;
    }

    return text;
}
