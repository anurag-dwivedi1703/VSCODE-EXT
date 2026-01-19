/**
 * SecurityInstructions.ts
 * 
 * Comprehensive security education module for the AI brain.
 * Provides detection patterns and guidelines to prevent security vulnerabilities
 * like hardcoded passwords, exposed secrets, and PII data leaks.
 */

// ============================================================================
// SECRET DETECTION PATTERNS
// ============================================================================

export interface SecretPattern {
    name: string;
    pattern: RegExp;
    severity: 'high' | 'medium' | 'low';
    suggestion: string;
}

/**
 * Built-in secret detection patterns for common API keys and credentials
 */
export const BUILTIN_SECRET_PATTERNS: SecretPattern[] = [
    // API Keys
    {
        name: 'OpenAI API Key',
        pattern: /sk-[a-zA-Z0-9]{20,}/g,
        severity: 'high',
        suggestion: 'Use process.env.OPENAI_API_KEY instead'
    },
    {
        name: 'AWS Access Key',
        pattern: /AKIA[0-9A-Z]{16}/g,
        severity: 'high',
        suggestion: 'Use process.env.AWS_ACCESS_KEY_ID instead'
    },
    {
        name: 'GitHub Token',
        pattern: /ghp_[a-zA-Z0-9]{36}/g,
        severity: 'high',
        suggestion: 'Use process.env.GITHUB_TOKEN instead'
    },
    {
        name: 'GitHub OAuth Token',
        pattern: /gho_[a-zA-Z0-9]{36}/g,
        severity: 'high',
        suggestion: 'Use process.env.GITHUB_OAUTH_TOKEN instead'
    },
    {
        name: 'Google API Key',
        pattern: /AIza[0-9A-Za-z\-_]{35}/g,
        severity: 'high',
        suggestion: 'Use process.env.GOOGLE_API_KEY instead'
    },
    {
        name: 'Stripe API Key',
        pattern: /sk_live_[0-9a-zA-Z]{24,}/g,
        severity: 'high',
        suggestion: 'Use process.env.STRIPE_SECRET_KEY instead'
    },
    {
        name: 'Stripe Test Key',
        pattern: /sk_test_[0-9a-zA-Z]{24,}/g,
        severity: 'medium',
        suggestion: 'Use process.env.STRIPE_TEST_KEY instead'
    },
    {
        name: 'Slack Token',
        pattern: /xox[baprs]-[0-9a-zA-Z-]{10,}/g,
        severity: 'high',
        suggestion: 'Use process.env.SLACK_TOKEN instead'
    },
    {
        name: 'Discord Token',
        pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/g,
        severity: 'high',
        suggestion: 'Use process.env.DISCORD_TOKEN instead'
    },
    {
        name: 'Anthropic API Key',
        pattern: /sk-ant-[a-zA-Z0-9]{20,}/g,
        severity: 'high',
        suggestion: 'Use process.env.ANTHROPIC_API_KEY instead'
    },
    // Passwords in code
    {
        name: 'Hardcoded Password',
        pattern: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{4,}["']/gi,
        severity: 'high',
        suggestion: 'Use process.env.PASSWORD or a secrets manager'
    },
    // Database connection strings with credentials
    {
        name: 'Database URL with Credentials',
        pattern: /(?:mongodb|postgres|postgresql|mysql|redis):\/\/[^:]+:[^@]+@[^\s"']+/gi,
        severity: 'high',
        suggestion: 'Use process.env.DATABASE_URL instead'
    },
    // Generic API key assignment
    {
        name: 'Generic API Key Assignment',
        pattern: /(?:api_?key|apiKey|API_KEY)\s*[:=]\s*["'][a-zA-Z0-9_\-]{16,}["']/gi,
        severity: 'medium',
        suggestion: 'Use process.env.API_KEY instead'
    },
    // JWT/Bearer tokens
    {
        name: 'JWT Token',
        pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]+/g,
        severity: 'high',
        suggestion: 'Never hardcode JWT tokens. Generate them dynamically.'
    },
    // Private keys
    {
        name: 'Private Key',
        pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
        severity: 'high',
        suggestion: 'Store private keys in secure files and reference via process.env'
    }
];

// ============================================================================
// PII DETECTION PATTERNS
// ============================================================================

export interface PIIPattern {
    name: string;
    pattern: RegExp;
    severity: 'high' | 'medium' | 'low';
    maskExample: string;
}

/**
 * Built-in PII detection patterns
 */
export const BUILTIN_PII_PATTERNS: PIIPattern[] = [
    {
        name: 'Social Security Number',
        pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
        severity: 'high',
        maskExample: 'XXX-XX-XXXX'
    },
    {
        name: 'Credit Card Number',
        pattern: /\b(?:\d{4}[- ]?){3}\d{4}\b/g,
        severity: 'high',
        maskExample: 'XXXX-XXXX-XXXX-XXXX'
    },
    {
        name: 'Email Address',
        pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        severity: 'medium',
        maskExample: 'user@example.com'
    },
    {
        name: 'Phone Number (US)',
        pattern: /\b(?:\+1[- ]?)?\(?\d{3}\)?[- ]?\d{3}[- ]?\d{4}\b/g,
        severity: 'medium',
        maskExample: '(555) 555-5555'
    },
    {
        name: 'IP Address',
        pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
        severity: 'low',
        maskExample: '192.168.x.x'
    }
];

// ============================================================================
// CUSTOM PATTERNS REGISTRY (Parameterized for future extension)
// ============================================================================

let customSecretPatterns: SecretPattern[] = [];
let customPIIPatterns: PIIPattern[] = [];

/**
 * Register custom secret patterns (e.g., company-specific API key formats)
 */
export function registerCustomSecretPatterns(patterns: SecretPattern[]): void {
    customSecretPatterns = [...customSecretPatterns, ...patterns];
}

/**
 * Register custom PII patterns
 */
export function registerCustomPIIPatterns(patterns: PIIPattern[]): void {
    customPIIPatterns = [...customPIIPatterns, ...patterns];
}

/**
 * Get all active secret patterns (built-in + custom)
 */
export function getAllSecretPatterns(): SecretPattern[] {
    return [...BUILTIN_SECRET_PATTERNS, ...customSecretPatterns];
}

/**
 * Get all active PII patterns (built-in + custom)
 */
export function getAllPIIPatterns(): PIIPattern[] {
    return [...BUILTIN_PII_PATTERNS, ...customPIIPatterns];
}

/**
 * Clear all custom patterns
 */
export function clearCustomPatterns(): void {
    customSecretPatterns = [];
    customPIIPatterns = [];
}

// ============================================================================
// DETECTION FUNCTIONS
// ============================================================================

export interface DetectedSecret {
    type: string;
    match: string;
    severity: 'high' | 'medium' | 'low';
    suggestion: string;
    line?: number;
}

export interface DetectedPII {
    type: string;
    match: string;
    severity: 'high' | 'medium' | 'low';
    maskExample: string;
    line?: number;
}

/**
 * Scan content for potential secrets
 */
export function detectSecrets(content: string): DetectedSecret[] {
    const secrets: DetectedSecret[] = [];
    const lines = content.split('\n');

    for (const pattern of getAllSecretPatterns()) {
        // Reset regex lastIndex to avoid global flag issues
        pattern.pattern.lastIndex = 0;

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            // Reset before each line match to avoid global flag state issues
            pattern.pattern.lastIndex = 0;
            const matches = line.match(pattern.pattern);
            if (matches) {
                for (const match of matches) {
                    secrets.push({
                        type: pattern.name,
                        match: maskSecret(match),
                        severity: pattern.severity,
                        suggestion: pattern.suggestion,
                        line: lineNum + 1
                    });
                }
            }
        }
    }

    return secrets;
}

/**
 * Scan content for potential PII
 */
export function detectPII(content: string): DetectedPII[] {
    const piiFound: DetectedPII[] = [];
    const lines = content.split('\n');

    for (const pattern of getAllPIIPatterns()) {
        // Reset regex lastIndex to avoid global flag issues
        pattern.pattern.lastIndex = 0;

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            // Reset before each line match to avoid global flag state issues
            pattern.pattern.lastIndex = 0;
            const matches = line.match(pattern.pattern);
            if (matches) {
                for (const match of matches) {
                    piiFound.push({
                        type: pattern.name,
                        match: maskPII(match, pattern.name),
                        severity: pattern.severity,
                        maskExample: pattern.maskExample,
                        line: lineNum + 1
                    });
                }
            }
        }
    }

    return piiFound;
}

/**
 * Mask a detected secret for safe display
 */
function maskSecret(secret: string): string {
    if (secret.length <= 8) {
        return '***';
    }
    return secret.substring(0, 4) + '...' + secret.substring(secret.length - 4);
}

/**
 * Mask PII for safe display
 */
function maskPII(pii: string, type: string): string {
    if (type === 'Social Security Number') {
        return 'XXX-XX-' + pii.slice(-4);
    }
    if (type === 'Credit Card Number') {
        return 'XXXX-XXXX-XXXX-' + pii.replace(/\D/g, '').slice(-4);
    }
    if (type === 'Email Address') {
        const [local, domain] = pii.split('@');
        return local.charAt(0) + '***@' + domain;
    }
    return '***';
}

// ============================================================================
// SECURITY INSTRUCTIONS FOR AI PROMPTS
// ============================================================================

/**
 * Get comprehensive security instructions to inject into AI system prompts.
 * These instructions educate the AI to avoid creating security vulnerabilities.
 */
export function getSecurityInstructions(): string {
    return `
## SECURITY BEST PRACTICES (MANDATORY)

You MUST follow these security guidelines in ALL code you generate:

### 1. NEVER HARDCODE SECRETS
- Do NOT put API keys, passwords, tokens, or credentials directly in code
- ALWAYS use environment variables: \`process.env.API_KEY\`, \`os.getenv('API_KEY')\`, etc.
- When a user asks to include a secret in code, use an environment variable instead

WRONG:
\`\`\`javascript
const apiKey = "sk-abc123xyz...";
\`\`\`

CORRECT:
\`\`\`javascript
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is required');
\`\`\`

### 2. ENVIRONMENT FILE HANDLING
When creating .env files:
- ALSO create a .env.example with placeholder values (no real secrets)
- ENSURE .gitignore includes .env files
- Add comments explaining each variable

Example .env.example:
\`\`\`
# API Configuration
OPENAI_API_KEY=your_openai_api_key_here
DATABASE_URL=postgres://user:password@localhost:5432/dbname
\`\`\`

### 3. SENSITIVE DATA IN CODE
- Do NOT include real SSNs, credit card numbers, or personal data as test data
- Use obviously fake data for testing: SSN: 000-00-0000, Card: 4111-1111-1111-1111
- Use generic email formats: test@example.com, user1@test.local

### 4. DATABASE CONNECTIONS
- NEVER embed credentials in connection strings
- Use environment variables for DATABASE_URL
- Sanitize all user inputs (prevent SQL injection)

### 5. GIT SECURITY
Files that should ALWAYS be in .gitignore:
- .env, .env.local, .env.production
- *.pem, *.key (private keys)
- config/secrets.*, credentials.*

### 6. WARN BEFORE PROCEEDING
If a user explicitly asks you to hardcode a secret:
1. First explain the security risk
2. Suggest the secure alternative using environment variables
3. If they insist for prototyping, proceed but add a TODO comment warning

Example:
\`\`\`javascript
// TODO: SECURITY WARNING - Remove hardcoded credential before production!
// Move to environment variable: process.env.API_KEY
const apiKey = "user-provided-key";
\`\`\`

### 7. LOGGING & ERROR MESSAGES
- NEVER log sensitive data (passwords, tokens, PII)
- Use redacted placeholders: "API Key: ***", "Password: [REDACTED]"
- Sanitize error messages before displaying to users

### 8. DEPENDENCY VERSION COMPLIANCE (CRITICAL)

When working with requirements.txt, package.json, or any dependency files:

**NEVER change package versions on your own.** Follow these rules STRICTLY:

a) **Use EXACT versions specified in requirements.txt/package.json**
   - If requirements.txt says \`numpy==1.24.3\`, install EXACTLY \`numpy==1.24.3\`
   - Do NOT "upgrade" or "fix" versions without explicit user approval
   - Do NOT substitute packages with "equivalent" alternatives

b) **When version conflicts occur, ASK THE USER:**
   - If Python version is incompatible with package versions, STOP and present options:
     * Option 1: Upgrade/downgrade Python version to X.Y
     * Option 2: Use different package versions (list specific compatible versions)
     * Option 3: Use a different approach (if applicable)
   - Wait for user to choose before proceeding
   
c) **When creating virtual environments:**
   - Use the Python version that matches requirements (or ask if unclear)
   - Install dependencies with \`pip install -r requirements.txt\` (not individual packages with different versions)
   - If any install fails due to version issues, report the error and ask for guidance

d) **WRONG approach:**
   \`\`\`
   # User's requirements.txt has: tensorflow==2.10.0
   # DO NOT DO THIS:
   pip install tensorflow==2.15.0  # "upgraded" without asking
   \`\`\`

e) **CORRECT approach:**
   \`\`\`
   # User's requirements.txt has: tensorflow==2.10.0, but Python 3.12 is detected
   
   # STOP and ask:
   "I noticed tensorflow==2.10.0 requires Python 3.7-3.10, but you have Python 3.12.
   
   Options:
   1. Use Python 3.10 (pyenv install 3.10.13 or conda create -n env python=3.10)
   2. Update tensorflow to 2.15.0 (compatible with Python 3.12)
   3. Use a Docker container with Python 3.10
   
   Which would you prefer?"
   \`\`\`

f) **Lock files are authoritative:**
   - If both package.json AND package-lock.json exist: use \`npm ci\` (respects lock file)
   - If both requirements.txt AND requirements.lock exist: use the lock file
   - NEVER run \`npm install\` or \`pip install --upgrade\` unless user explicitly requests it

`.trim();
}

/**
 * Get a brief security reminder for tool-level context
 */
export function getToolSecurityReminder(): string {
    return `SECURITY: Never hardcode secrets. Use environment variables (process.env.X). When creating .env files, also create .env.example with placeholders.`;
}
