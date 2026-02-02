/**
 * LintRuleExtractor.ts
 * 
 * Extracts coding standards from linter configuration files and converts
 * them into agent-friendly rules for the constitution.
 * 
 * Supports:
 * - ESLint (.eslintrc.json, .eslintrc.js, .eslintrc, eslint.config.js)
 * - Prettier (.prettierrc, .prettierrc.json, prettier.config.js)
 * - TypeScript (tsconfig.json strict options)
 * - EditorConfig (.editorconfig)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    CodingStandard,
    CodingStandardsCollection,
    EnforcementLevel
} from '../engine/ConstitutionSchema';

// ============================================
// ESLINT RULE TRANSLATIONS
// ============================================

/**
 * Maps ESLint rule names to human-readable descriptions
 */
const ESLINT_RULE_DESCRIPTIONS: Record<string, { 
    description: string; 
    category: 'formatting' | 'naming' | 'imports' | 'other' 
}> = {
    // Formatting
    'semi': { description: 'Semicolons', category: 'formatting' },
    'quotes': { description: 'Quote style', category: 'formatting' },
    'indent': { description: 'Indentation', category: 'formatting' },
    'max-len': { description: 'Maximum line length', category: 'formatting' },
    'comma-dangle': { description: 'Trailing commas', category: 'formatting' },
    'no-trailing-spaces': { description: 'No trailing spaces', category: 'formatting' },
    'eol-last': { description: 'Newline at end of file', category: 'formatting' },
    'no-multiple-empty-lines': { description: 'Multiple empty lines', category: 'formatting' },
    'object-curly-spacing': { description: 'Object curly spacing', category: 'formatting' },
    'array-bracket-spacing': { description: 'Array bracket spacing', category: 'formatting' },
    'space-before-function-paren': { description: 'Space before function parenthesis', category: 'formatting' },
    'arrow-parens': { description: 'Arrow function parentheses', category: 'formatting' },
    'arrow-spacing': { description: 'Arrow function spacing', category: 'formatting' },
    'brace-style': { description: 'Brace style', category: 'formatting' },
    
    // Naming
    'camelcase': { description: 'Camel case naming', category: 'naming' },
    '@typescript-eslint/naming-convention': { description: 'Naming conventions', category: 'naming' },
    'id-length': { description: 'Identifier length', category: 'naming' },
    'new-cap': { description: 'Constructor capitalization', category: 'naming' },
    
    // Imports
    'import/order': { description: 'Import order', category: 'imports' },
    'import/no-duplicates': { description: 'No duplicate imports', category: 'imports' },
    'import/newline-after-import': { description: 'Newline after imports', category: 'imports' },
    '@typescript-eslint/consistent-type-imports': { description: 'Type import style', category: 'imports' },
    'sort-imports': { description: 'Sort imports', category: 'imports' },
    'no-duplicate-imports': { description: 'No duplicate imports', category: 'imports' },
    
    // TypeScript specific
    '@typescript-eslint/explicit-function-return-type': { description: 'Explicit return types', category: 'other' },
    '@typescript-eslint/no-explicit-any': { description: 'No explicit any type', category: 'other' },
    '@typescript-eslint/no-unused-vars': { description: 'No unused variables', category: 'other' },
    '@typescript-eslint/strict-boolean-expressions': { description: 'Strict boolean expressions', category: 'other' },
    '@typescript-eslint/no-floating-promises': { description: 'Handle floating promises', category: 'other' },
    
    // Best practices
    'no-console': { description: 'Console statements', category: 'other' },
    'no-debugger': { description: 'Debugger statements', category: 'other' },
    'no-alert': { description: 'Alert/confirm/prompt', category: 'other' },
    'eqeqeq': { description: 'Strict equality', category: 'other' },
    'curly': { description: 'Curly braces for blocks', category: 'other' },
    'no-var': { description: 'No var declarations', category: 'other' },
    'prefer-const': { description: 'Prefer const', category: 'other' },
    'no-magic-numbers': { description: 'No magic numbers', category: 'other' },
    'complexity': { description: 'Cyclomatic complexity', category: 'other' },
    'max-depth': { description: 'Maximum nesting depth', category: 'other' },
    'max-lines': { description: 'Maximum file lines', category: 'other' },
    'max-params': { description: 'Maximum function parameters', category: 'other' },
};

// ============================================
// LINT RULE EXTRACTOR CLASS
// ============================================

export class LintRuleExtractor {
    private workspaceRoot: string;
    
    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }
    
    /**
     * Extract all coding standards from linter configs
     */
    async extract(): Promise<CodingStandardsCollection> {
        const collection: CodingStandardsCollection = {
            formatting: [],
            naming: [],
            imports: [],
            other: []
        };
        
        // Extract from ESLint
        const eslintRules = await this.extractEslintRules();
        this.categorizeRules(eslintRules, collection);
        
        // Extract from Prettier
        const prettierRules = await this.extractPrettierRules();
        this.categorizeRules(prettierRules, collection);
        
        // Extract from TypeScript config
        const tsRules = await this.extractTypeScriptRules();
        this.categorizeRules(tsRules, collection);
        
        // Extract from EditorConfig
        const editorRules = await this.extractEditorConfigRules();
        this.categorizeRules(editorRules, collection);
        
        return collection;
    }
    
    /**
     * Extract rules from ESLint configuration
     */
    private async extractEslintRules(): Promise<CodingStandard[]> {
        const rules: CodingStandard[] = [];
        
        // Try different ESLint config file locations
        const configFiles = [
            '.eslintrc.json',
            '.eslintrc.js',
            '.eslintrc',
            '.eslintrc.yaml',
            '.eslintrc.yml',
            'eslint.config.js',
            'eslint.config.mjs'
        ];
        
        for (const configFile of configFiles) {
            const configPath = path.join(this.workspaceRoot, configFile);
            
            if (fs.existsSync(configPath)) {
                try {
                    let config: any;
                    
                    if (configFile.endsWith('.json') || configFile === '.eslintrc') {
                        const content = fs.readFileSync(configPath, 'utf-8');
                        config = JSON.parse(content);
                    } else if (configFile.endsWith('.js') || configFile.endsWith('.mjs')) {
                        // For JS configs, try to parse as JSON-like (basic support)
                        const content = fs.readFileSync(configPath, 'utf-8');
                        config = this.parseJsConfig(content);
                    }
                    
                    if (config?.rules) {
                        for (const [ruleName, ruleValue] of Object.entries(config.rules)) {
                            const standard = this.convertEslintRule(ruleName, ruleValue, configFile);
                            if (standard) {
                                rules.push(standard);
                            }
                        }
                    }
                    
                    // Check for extends (preset rules)
                    if (config?.extends) {
                        const extendsList = Array.isArray(config.extends) ? config.extends : [config.extends];
                        for (const preset of extendsList) {
                            rules.push({
                                id: `extends-${preset}`,
                                description: `Extends ${preset} ruleset`,
                                value: 'enabled',
                                enforcement: 'warning',
                                source: configFile
                            });
                        }
                    }
                    
                    break; // Found a config, stop searching
                } catch (error) {
                    console.warn(`[LintRuleExtractor] Error parsing ${configFile}:`, error);
                }
            }
        }
        
        return rules;
    }
    
    /**
     * Convert ESLint rule to CodingStandard
     */
    private convertEslintRule(ruleName: string, ruleValue: any, source: string): CodingStandard | null {
        const ruleInfo = ESLINT_RULE_DESCRIPTIONS[ruleName];
        if (!ruleInfo) {
            return null; // Skip unknown rules
        }
        
        // Parse rule value
        let enforcement: EnforcementLevel = 'suggestion';
        let value = '';
        
        if (Array.isArray(ruleValue)) {
            const level = ruleValue[0];
            enforcement = this.eslintLevelToEnforcement(level);
            value = this.formatRuleValue(ruleValue.slice(1));
        } else {
            enforcement = this.eslintLevelToEnforcement(ruleValue);
            value = 'enabled';
        }
        
        // Skip disabled rules
        if (enforcement === 'suggestion' && (ruleValue === 'off' || ruleValue === 0)) {
            return null;
        }
        
        return {
            id: ruleName,
            description: ruleInfo.description,
            value,
            enforcement,
            source
        };
    }
    
    /**
     * Convert ESLint error level to EnforcementLevel
     */
    private eslintLevelToEnforcement(level: string | number): EnforcementLevel {
        if (level === 'error' || level === 2) {
            return 'strict';
        } else if (level === 'warn' || level === 1) {
            return 'warning';
        }
        return 'suggestion';
    }
    
    /**
     * Format rule value for display
     */
    private formatRuleValue(options: any[]): string {
        if (options.length === 0) {
            return 'enabled';
        }
        
        const formatted = options.map(opt => {
            if (typeof opt === 'string') {
                return opt;
            } else if (typeof opt === 'object') {
                return JSON.stringify(opt);
            }
            return String(opt);
        });
        
        return formatted.join(', ');
    }
    
    /**
     * Extract rules from Prettier configuration
     */
    private async extractPrettierRules(): Promise<CodingStandard[]> {
        const rules: CodingStandard[] = [];
        
        const configFiles = [
            '.prettierrc',
            '.prettierrc.json',
            '.prettierrc.js',
            'prettier.config.js',
            '.prettierrc.yaml',
            '.prettierrc.yml'
        ];
        
        for (const configFile of configFiles) {
            const configPath = path.join(this.workspaceRoot, configFile);
            
            if (fs.existsSync(configPath)) {
                try {
                    let config: any;
                    
                    if (configFile.endsWith('.json') || configFile === '.prettierrc') {
                        const content = fs.readFileSync(configPath, 'utf-8');
                        // Handle empty or whitespace-only files
                        if (content.trim()) {
                            config = JSON.parse(content);
                        }
                    } else if (configFile.endsWith('.js')) {
                        const content = fs.readFileSync(configPath, 'utf-8');
                        config = this.parseJsConfig(content);
                    }
                    
                    if (config) {
                        // Map Prettier options to coding standards
                        const prettierMappings: Record<string, string> = {
                            'semi': 'Semicolons',
                            'singleQuote': 'Single quotes',
                            'tabWidth': 'Tab width',
                            'useTabs': 'Use tabs',
                            'trailingComma': 'Trailing commas',
                            'bracketSpacing': 'Bracket spacing',
                            'arrowParens': 'Arrow function parens',
                            'printWidth': 'Print width',
                            'endOfLine': 'End of line',
                            'jsxSingleQuote': 'JSX single quotes'
                        };
                        
                        for (const [key, description] of Object.entries(prettierMappings)) {
                            if (config[key] !== undefined) {
                                rules.push({
                                    id: `prettier-${key}`,
                                    description,
                                    value: String(config[key]),
                                    enforcement: 'strict', // Prettier is auto-fix
                                    source: configFile
                                });
                            }
                        }
                    }
                    
                    break;
                } catch (error) {
                    console.warn(`[LintRuleExtractor] Error parsing ${configFile}:`, error);
                }
            }
        }
        
        return rules;
    }
    
    /**
     * Extract rules from TypeScript configuration
     */
    private async extractTypeScriptRules(): Promise<CodingStandard[]> {
        const rules: CodingStandard[] = [];
        const tsconfigPath = path.join(this.workspaceRoot, 'tsconfig.json');
        
        if (!fs.existsSync(tsconfigPath)) {
            return rules;
        }
        
        try {
            const content = fs.readFileSync(tsconfigPath, 'utf-8');
            // Remove comments (TypeScript config allows comments)
            const cleanContent = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const config = JSON.parse(cleanContent);
            
            const compilerOptions = config.compilerOptions || {};
            
            // Map strict options to coding standards
            const strictOptions: Record<string, string> = {
                'strict': 'Strict mode (all strict options)',
                'noImplicitAny': 'No implicit any types',
                'strictNullChecks': 'Strict null checks',
                'strictFunctionTypes': 'Strict function types',
                'strictBindCallApply': 'Strict bind/call/apply',
                'strictPropertyInitialization': 'Strict property initialization',
                'noImplicitReturns': 'No implicit returns',
                'noFallthroughCasesInSwitch': 'No fallthrough in switch',
                'noUncheckedIndexedAccess': 'No unchecked indexed access',
                'noImplicitOverride': 'Explicit override modifier',
                'forceConsistentCasingInFileNames': 'Consistent file name casing',
                'skipLibCheck': 'Skip library type checking'
            };
            
            for (const [option, description] of Object.entries(strictOptions)) {
                if (compilerOptions[option] !== undefined) {
                    rules.push({
                        id: `ts-${option}`,
                        description,
                        value: compilerOptions[option] ? 'enabled' : 'disabled',
                        enforcement: compilerOptions[option] ? 'strict' : 'suggestion',
                        source: 'tsconfig.json'
                    });
                }
            }
            
            // Target and module
            if (compilerOptions.target) {
                rules.push({
                    id: 'ts-target',
                    description: 'TypeScript target',
                    value: compilerOptions.target,
                    enforcement: 'warning',
                    source: 'tsconfig.json'
                });
            }
            
            if (compilerOptions.module) {
                rules.push({
                    id: 'ts-module',
                    description: 'Module system',
                    value: compilerOptions.module,
                    enforcement: 'warning',
                    source: 'tsconfig.json'
                });
            }
        } catch (error) {
            console.warn('[LintRuleExtractor] Error parsing tsconfig.json:', error);
        }
        
        return rules;
    }
    
    /**
     * Extract rules from EditorConfig
     */
    private async extractEditorConfigRules(): Promise<CodingStandard[]> {
        const rules: CodingStandard[] = [];
        const editorconfigPath = path.join(this.workspaceRoot, '.editorconfig');
        
        if (!fs.existsSync(editorconfigPath)) {
            return rules;
        }
        
        try {
            const content = fs.readFileSync(editorconfigPath, 'utf-8');
            const lines = content.split('\n');
            
            const mappings: Record<string, string> = {
                'indent_style': 'Indent style',
                'indent_size': 'Indent size',
                'end_of_line': 'End of line',
                'charset': 'Character set',
                'trim_trailing_whitespace': 'Trim trailing whitespace',
                'insert_final_newline': 'Insert final newline',
                'max_line_length': 'Maximum line length'
            };
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) {
                    continue;
                }
                
                const [key, value] = trimmed.split('=').map(s => s.trim());
                
                if (key && value && mappings[key]) {
                    rules.push({
                        id: `editor-${key}`,
                        description: mappings[key],
                        value,
                        enforcement: 'warning',
                        source: '.editorconfig'
                    });
                }
            }
        } catch (error) {
            console.warn('[LintRuleExtractor] Error parsing .editorconfig:', error);
        }
        
        return rules;
    }
    
    /**
     * Categorize rules into the collection
     */
    private categorizeRules(rules: CodingStandard[], collection: CodingStandardsCollection): void {
        for (const rule of rules) {
            // Try to categorize based on known categories
            const knownCategory = ESLINT_RULE_DESCRIPTIONS[rule.id]?.category;
            
            if (knownCategory) {
                collection[knownCategory].push(rule);
            } else if (rule.id.includes('indent') || rule.id.includes('semi') || 
                       rule.id.includes('quote') || rule.id.includes('spacing') ||
                       rule.id.includes('Width') || rule.id.includes('comma')) {
                collection.formatting.push(rule);
            } else if (rule.id.includes('naming') || rule.id.includes('camel') ||
                       rule.id.includes('cap')) {
                collection.naming.push(rule);
            } else if (rule.id.includes('import') || rule.id.includes('sort')) {
                collection.imports.push(rule);
            } else {
                collection.other.push(rule);
            }
        }
    }
    
    /**
     * Basic JS config parser (extracts object literals)
     */
    private parseJsConfig(content: string): any {
        try {
            // Try to extract module.exports or export default object
            const exportMatch = content.match(/(?:module\.exports\s*=|export\s+default)\s*({[\s\S]*})/);
            if (exportMatch) {
                // Very basic - try to parse as JSON after cleaning
                const cleaned = exportMatch[1]
                    .replace(/\/\/.*$/gm, '')  // Remove single-line comments
                    .replace(/\/\*[\s\S]*?\*\//g, '')  // Remove multi-line comments
                    .replace(/,(\s*[}\]])/g, '$1')  // Remove trailing commas
                    .replace(/(['"])?([a-zA-Z_$][a-zA-Z0-9_$]*)\1\s*:/g, '"$2":');  // Quote keys
                
                return JSON.parse(cleaned);
            }
        } catch {
            // Parsing failed, return null
        }
        return null;
    }
}

/**
 * Create a LintRuleExtractor instance
 */
export function createLintRuleExtractor(workspaceRoot: string): LintRuleExtractor {
    return new LintRuleExtractor(workspaceRoot);
}

/**
 * Get all coding standards as a flat list
 */
export function flattenCodingStandards(collection: CodingStandardsCollection): CodingStandard[] {
    return [
        ...collection.formatting,
        ...collection.naming,
        ...collection.imports,
        ...collection.other
    ];
}
