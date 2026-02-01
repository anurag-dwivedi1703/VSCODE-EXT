/**
 * ContextSkeletonizer.ts
 * Generates skeleton/signature-only context from codebase files.
 * Reduces token usage by ~80% while preserving architectural information.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Supported file extensions and their skeleton extractors.
 */
const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cs'];

/**
 * Directories to exclude from skeletonization.
 */
const EXCLUDED_DIRECTORIES = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    'coverage',
    'vendor',
    'tmp',
    'temp',
    '.cache',
    '.vscode',
    '.idea',
    '__pycache__',
    '.pytest_cache',
    'venv',
    'env',
    '.env',
    '.vibearchitect',
    '.antigravity',
    '.specify',
    'test',
    'tests',
    '__tests__',
    'spec',
    'specs'
]);

/**
 * Files to exclude from skeletonization.
 */
const EXCLUDED_FILES = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '.DS_Store',
    'Thumbs.db'
]);

/**
 * Extract skeleton (signatures only) from TypeScript/JavaScript code.
 */
function skeletonizeTypeScript(content: string, filePath: string): string {
    const lines = content.split('\n');
    const skeleton: string[] = [];
    const fileName = path.basename(filePath);

    skeleton.push(`// ${fileName}`);

    let inClassBlock = false;
    let currentClassName = '';
    let braceCount = 0;

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and single-line comments in output
        if (!trimmed || trimmed.startsWith('//')) {
            continue;
        }

        // Import statements - keep them
        if (trimmed.startsWith('import ') || trimmed.startsWith('export * from')) {
            skeleton.push(trimmed);
            continue;
        }

        // Interface/Type definitions - keep full signature
        if (trimmed.startsWith('export interface ') ||
            trimmed.startsWith('interface ') ||
            trimmed.startsWith('export type ') ||
            trimmed.startsWith('type ')) {
            // Extract just the name and extends/implements
            const match = trimmed.match(/(export\s+)?(interface|type)\s+(\w+)/);
            if (match) {
                skeleton.push(`${match[1] || ''}${match[2]} ${match[3]} { ... }`);
            }
            continue;
        }

        // Class declarations
        if (trimmed.startsWith('export class ') ||
            trimmed.startsWith('class ') ||
            trimmed.startsWith('abstract class ')) {
            const match = trimmed.match(/(export\s+)?(abstract\s+)?class\s+(\w+)(\s+extends\s+\w+)?(\s+implements\s+[\w,\s]+)?/);
            if (match) {
                currentClassName = match[3];
                skeleton.push(`${match[1] || ''}${match[2] || ''}class ${match[3]}${match[4] || ''}${match[5] || ''} {`);
                inClassBlock = true;
                braceCount = 1;
            }
            continue;
        }

        // Track braces when inside a class
        if (inClassBlock) {
            braceCount += (trimmed.match(/{/g) || []).length;
            braceCount -= (trimmed.match(/}/g) || []).length;

            if (braceCount === 0) {
                skeleton.push('}');
                inClassBlock = false;
                currentClassName = '';
                continue;
            }

            // Method signatures within class
            const methodMatch = trimmed.match(/^(public|private|protected|static|async|\s)*\s*(\w+)\s*\(([^)]*)\)\s*:\s*([^{]+)/);
            if (methodMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while')) {
                const visibility = methodMatch[1]?.trim() || 'public';
                const methodName = methodMatch[2];
                const params = methodMatch[3];
                const returnType = methodMatch[4].trim().replace('{', '');
                skeleton.push(`  ${visibility} ${methodName}(${params}): ${returnType};`);
                continue;
            }

            // Property declarations
            const propMatch = trimmed.match(/^(public|private|protected|readonly|\s)*\s*(\w+)\s*:\s*([^=;]+)/);
            if (propMatch && !trimmed.includes('(')) {
                skeleton.push(`  ${propMatch[1]?.trim() || ''} ${propMatch[2]}: ${propMatch[3].trim()};`);
            }
        }

        // Top-level function exports
        if (!inClassBlock && (trimmed.startsWith('export function ') ||
            trimmed.startsWith('export async function ') ||
            trimmed.startsWith('function '))) {
            const match = trimmed.match(/(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*:\s*([^{]+)/);
            if (match) {
                skeleton.push(`${match[1] || ''}${match[2] || ''}function ${match[3]}(${match[4]}): ${match[5].trim()};`);
            }
            continue;
        }

        // Const/Let exports (arrow functions or objects)
        if (!inClassBlock && (trimmed.startsWith('export const ') || trimmed.startsWith('export let '))) {
            const match = trimmed.match(/(export\s+)(const|let)\s+(\w+)\s*[=:]/);
            if (match) {
                skeleton.push(`${match[1]}${match[2]} ${match[3]}: /* ... */;`);
            }
        }
    }

    return skeleton.join('\n');
}

/**
 * Extract skeleton from Python code.
 */
function skeletonizePython(content: string, filePath: string): string {
    const lines = content.split('\n');
    const skeleton: string[] = [];
    const fileName = path.basename(filePath);

    skeleton.push(`# ${fileName}`);

    for (const line of lines) {
        const trimmed = line.trim();

        // Import statements
        if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
            skeleton.push(trimmed);
            continue;
        }

        // Class definitions
        if (trimmed.startsWith('class ')) {
            skeleton.push(trimmed);
            continue;
        }

        // Function/method definitions
        if (trimmed.startsWith('def ') || trimmed.startsWith('async def ')) {
            // Include the signature line
            skeleton.push(line);  // Keep indentation
            continue;
        }
    }

    return skeleton.join('\n');
}

/**
 * Generate skeleton context from a single file.
 */
export function skeletonizeFile(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();

    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');

        switch (ext) {
            case '.ts':
            case '.tsx':
            case '.js':
            case '.jsx':
                return skeletonizeTypeScript(content, filePath);
            case '.py':
                return skeletonizePython(content, filePath);
            default:
                return null;
        }
    } catch (error) {
        console.warn(`[ContextSkeletonizer] Failed to read ${filePath}:`, error);
        return null;
    }
}

/**
 * Generate skeleton context from multiple files.
 */
export function skeletonizeFiles(filePaths: string[]): string {
    const skeletons: string[] = [];

    for (const filePath of filePaths) {
        const skeleton = skeletonizeFile(filePath);
        if (skeleton) {
            skeletons.push(skeleton);
        }
    }

    return skeletons.join('\n\n---\n\n');
}

/**
 * Check if a directory should be excluded from skeletonization.
 */
function isExcludedDirectory(dirName: string): boolean {
    return EXCLUDED_DIRECTORIES.has(dirName.toLowerCase());
}

/**
 * Check if a file should be excluded from skeletonization.
 */
function isExcludedFile(fileName: string): boolean {
    const lowerName = fileName.toLowerCase();
    
    // Check explicit exclusions
    if (EXCLUDED_FILES.has(fileName)) {
        return true;
    }
    
    // Exclude minified files
    if (lowerName.endsWith('.min.js') || lowerName.endsWith('.min.css')) {
        return true;
    }
    
    // Exclude map files
    if (lowerName.endsWith('.map')) {
        return true;
    }
    
    // Exclude lock files
    if (lowerName.includes('lock')) {
        return true;
    }
    
    return false;
}

/**
 * Generate skeleton context from a directory.
 * 
 * @param dirPath - Directory path to skeletonize
 * @param includeSubdirs - Whether to recursively process subdirectories
 * @param skipExclusions - If true, process all directories (for targeted use)
 */
export function skeletonizeDirectory(
    dirPath: string, 
    includeSubdirs: boolean = false,
    skipExclusions: boolean = false
): string {
    const skeletons: string[] = [];

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isFile()) {
                // Skip excluded files
                if (!skipExclusions && isExcludedFile(entry.name)) {
                    continue;
                }
                
                const skeleton = skeletonizeFile(fullPath);
                if (skeleton) {
                    skeletons.push(skeleton);
                }
            } else if (entry.isDirectory() && includeSubdirs) {
                // Skip excluded directories
                if (!skipExclusions && isExcludedDirectory(entry.name)) {
                    continue;
                }
                
                // Recursive call for subdirectories
                const subSkeleton = skeletonizeDirectory(fullPath, true, skipExclusions);
                if (subSkeleton) {
                    skeletons.push(`## ${entry.name}/\n${subSkeleton}`);
                }
            }
        }
    } catch (error) {
        console.warn(`[ContextSkeletonizer] Failed to read directory ${dirPath}:`, error);
    }

    return skeletons.join('\n\n');
}

/**
 * Estimate token savings from skeletonization.
 */
export function estimateTokenSavings(originalChars: number, skeletonChars: number): number {
    if (originalChars === 0) return 0;
    return Math.round((1 - (skeletonChars / originalChars)) * 100);
}
