import * as fs from 'fs';
import * as path from 'path';

// Dynamic imports for optional dependencies
let PNG: any = null;
let pixelmatch: any = null;

async function loadImageLibs(): Promise<{ PNG: any; pixelmatch: any }> {
    if (!PNG || !pixelmatch) {
        try {
            const pngjs = await import('pngjs');
            PNG = pngjs.PNG;
            const pm = await import('pixelmatch');
            pixelmatch = pm.default || pm;
        } catch (error: any) {
            console.error('[VisualComparison] Failed to load image libraries:', error.message);
            throw new Error('Visual comparison requires pngjs and pixelmatch. Run "npm install pngjs pixelmatch" in the extension directory.');
        }
    }
    return { PNG, pixelmatch };
}

export interface ComparisonResult {
    matches: boolean;
    diffPercentage: number;
    diffImagePath?: string;
    totalPixels: number;
    differentPixels: number;
}

export interface VisualVerificationResult {
    passed: boolean;
    comparisonResult?: ComparisonResult;
    errors: string[];
    suggestions: string[];
}

/**
 * VisualComparisonService - Compares screenshots for visual regression testing
 * 
 * Features:
 * - Pixel-level comparison using pixelmatch
 * - Generates visual diff images
 * - Calculates difference percentages
 * - Stores baselines for future comparisons
 * 
 * NOTE: Dependencies are loaded dynamically to prevent extension activation failure
 */
export class VisualComparisonService {
    private baselinesDir: string;

    constructor(workspacePath: string, taskId: string) {
        this.baselinesDir = path.join(workspacePath, '.vibearchitect', 'baselines', taskId);
        this.ensureDir(this.baselinesDir);
    }

    private ensureDir(dir: string): void {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Compare two screenshots and generate a diff image
     */
    async compareScreenshots(
        baselinePath: string,
        currentPath: string,
        diffOutputPath?: string
    ): Promise<ComparisonResult> {
        const { PNG, pixelmatch } = await loadImageLibs();

        return new Promise((resolve, reject) => {
            try {
                // Read baseline image
                const baselineData = fs.readFileSync(baselinePath);
                const baseline = PNG.sync.read(baselineData);

                // Read current image
                const currentData = fs.readFileSync(currentPath);
                const current = PNG.sync.read(currentData);

                // Check dimensions match
                if (baseline.width !== current.width || baseline.height !== current.height) {
                    resolve({
                        matches: false,
                        diffPercentage: 100,
                        totalPixels: baseline.width * baseline.height,
                        differentPixels: baseline.width * baseline.height
                    });
                    return;
                }

                const { width, height } = baseline;
                const diff = new PNG({ width, height });
                const totalPixels = width * height;

                // Compare pixels
                const differentPixels = pixelmatch(
                    baseline.data,
                    current.data,
                    diff.data,
                    width,
                    height,
                    { threshold: 0.1 } // Sensitivity threshold
                );

                const diffPercentage = (differentPixels / totalPixels) * 100;
                const matches = diffPercentage < 1; // Less than 1% difference = match

                let diffImagePath: string | undefined;

                // Save diff image if there are differences and output path provided
                if (diffOutputPath && !matches) {
                    diffImagePath = diffOutputPath;
                    const diffBuffer = PNG.sync.write(diff);
                    fs.writeFileSync(diffOutputPath, diffBuffer);
                }

                resolve({
                    matches,
                    diffPercentage: parseFloat(diffPercentage.toFixed(2)),
                    diffImagePath,
                    totalPixels,
                    differentPixels
                });
            } catch (error: any) {
                reject(new Error(`Comparison failed: ${error.message}`));
            }
        });
    }

    /**
     * Save a screenshot as a baseline for future comparisons
     */
    async saveBaseline(screenshotPath: string, category: string): Promise<string> {
        const baselinePath = path.join(this.baselinesDir, `${category}_baseline.png`);
        fs.copyFileSync(screenshotPath, baselinePath);
        return baselinePath;
    }

    /**
     * Get the baseline path for a category
     */
    getBaselinePath(category: string): string | null {
        const baselinePath = path.join(this.baselinesDir, `${category}_baseline.png`);
        if (fs.existsSync(baselinePath)) {
            return baselinePath;
        }
        return null;
    }

    /**
     * Check if a baseline exists for a category
     */
    hasBaseline(category: string): boolean {
        return this.getBaselinePath(category) !== null;
    }

    /**
     * Compare current screenshot against saved baseline
     */
    async compareAgainstBaseline(
        currentPath: string,
        category: string
    ): Promise<ComparisonResult | null> {
        const baselinePath = this.getBaselinePath(category);
        if (!baselinePath) {
            return null; // No baseline to compare against
        }

        const diffPath = path.join(
            this.baselinesDir,
            `${category}_diff_${Date.now()}.png`
        );

        return this.compareScreenshots(baselinePath, currentPath, diffPath);
    }

    /**
     * Analyze screenshot for common UI issues (returns errors for AI to process)
     * This is a basic structural check - the AI will do semantic analysis
     */
    async analyzeScreenshotForIssues(screenshotPath: string): Promise<string[]> {
        const issues: string[] = [];

        try {
            const { PNG } = await loadImageLibs();
            const data = fs.readFileSync(screenshotPath);
            const png = PNG.sync.read(data);
            const { width, height, data: pixels } = png;

            // Check if image is mostly blank (white or single color)
            let sameColorCount = 0;
            const firstPixel = {
                r: pixels[0],
                g: pixels[1],
                b: pixels[2]
            };

            for (let i = 0; i < pixels.length; i += 4) {
                if (
                    pixels[i] === firstPixel.r &&
                    pixels[i + 1] === firstPixel.g &&
                    pixels[i + 2] === firstPixel.b
                ) {
                    sameColorCount++;
                }
            }

            const sameColorPercentage = (sameColorCount / (width * height)) * 100;
            if (sameColorPercentage > 95) {
                issues.push(`Page appears mostly blank or single-color (${sameColorPercentage.toFixed(1)}% same color)`);
            }

            // Check if image is very small (might indicate a rendering issue)
            if (width < 100 || height < 100) {
                issues.push(`Screenshot dimensions very small: ${width}x${height}`);
            }

            // Check for predominantly red color (might indicate error page)
            let redPixels = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i] > 200 && pixels[i + 1] < 100 && pixels[i + 2] < 100) {
                    redPixels++;
                }
            }
            const redPercentage = (redPixels / (width * height)) * 100;
            if (redPercentage > 30) {
                issues.push(`High amount of red color detected (${redPercentage.toFixed(1)}%) - possible error state`);
            }

        } catch (error: any) {
            issues.push(`Could not analyze screenshot: ${error.message}`);
        }

        return issues;
    }

    /**
     * Delete old diff images to save space
     */
    cleanupOldDiffs(maxAgeDays: number = 7): void {
        const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
        const now = Date.now();

        try {
            const files = fs.readdirSync(this.baselinesDir);
            for (const file of files) {
                if (file.includes('_diff_')) {
                    const filePath = path.join(this.baselinesDir, file);
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtimeMs > maxAgeMs) {
                        fs.unlinkSync(filePath);
                    }
                }
            }
        } catch {
            // Ignore cleanup errors
        }
    }
}
