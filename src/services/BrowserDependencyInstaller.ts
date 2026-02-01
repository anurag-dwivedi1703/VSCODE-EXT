/**
 * BrowserDependencyInstaller - Auto-install browser automation dependencies
 * 
 * This module handles the installation of:
 * - playwright-core (browser automation)
 * - pixelmatch (image comparison)
 * - pngjs (PNG handling)
 * 
 * It installs them into the extension's directory, not the user's workspace.
 * 
 * @module BrowserDependencyInstaller
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';

// ============================================
// TYPES
// ============================================

export interface DependencyStatus {
    name: string;
    installed: boolean;
    version?: string;
    required: boolean;
}

export interface InstallResult {
    success: boolean;
    installedPackages: string[];
    failedPackages: string[];
    error?: string;
}

// ============================================
// CONSTANTS
// ============================================

const REQUIRED_PACKAGES = [
    { name: 'playwright-core', required: true },
    { name: 'pixelmatch', required: false },  // Optional - for visual comparison
    { name: 'pngjs', required: false },       // Optional - for screenshot comparison
];

// ============================================
// DEPENDENCY INSTALLER CLASS
// ============================================

export class BrowserDependencyInstaller {
    private static instance: BrowserDependencyInstaller;
    private extensionPath: string = '';

    private constructor() {}

    public static getInstance(): BrowserDependencyInstaller {
        if (!BrowserDependencyInstaller.instance) {
            BrowserDependencyInstaller.instance = new BrowserDependencyInstaller();
        }
        return BrowserDependencyInstaller.instance;
    }

    /**
     * Set the extension path (called during activation)
     */
    public setExtensionPath(extensionPath: string): void {
        this.extensionPath = extensionPath;
    }

    /**
     * Check if all required dependencies are installed
     */
    public async checkDependencies(): Promise<DependencyStatus[]> {
        const statuses: DependencyStatus[] = [];

        for (const pkg of REQUIRED_PACKAGES) {
            const status = await this.checkPackage(pkg.name);
            statuses.push({
                ...status,
                required: pkg.required
            });
        }

        return statuses;
    }

    /**
     * Check if a specific package is installed by checking file system
     * (Dynamic import doesn't work reliably with webpack externals)
     */
    private async checkPackage(packageName: string): Promise<{ name: string; installed: boolean; version?: string }> {
        try {
            // Check multiple possible locations for the package
            const possiblePaths = [
                // Extension's node_modules
                this.extensionPath ? path.join(this.extensionPath, 'node_modules', packageName) : null,
                // Global node_modules (for npm global installs)
                path.join(process.env.APPDATA || '', 'npm', 'node_modules', packageName),
                // User's home node_modules
                path.join(os.homedir(), 'node_modules', packageName),
            ].filter(Boolean) as string[];

            for (const pkgPath of possiblePaths) {
                const pkgJsonPath = path.join(pkgPath, 'package.json');
                
                if (fs.existsSync(pkgJsonPath)) {
                    try {
                        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
                        return { 
                            name: packageName, 
                            installed: true, 
                            version: pkgJson.version 
                        };
                    } catch {
                        // package.json exists but couldn't read - still counts as installed
                        return { name: packageName, installed: true };
                    }
                }
            }

            // Also try to actually require the module as a last resort
            try {
                // Use require.resolve which throws if not found
                const resolved = require.resolve(packageName, { 
                    paths: possiblePaths.concat(module.paths) 
                });
                if (resolved) {
                    return { name: packageName, installed: true };
                }
            } catch {
                // Not found via require either
            }

            return { name: packageName, installed: false };
        } catch {
            return { name: packageName, installed: false };
        }
    }

    /**
     * Check if browser automation is available
     */
    public async isBrowserAutomationAvailable(): Promise<boolean> {
        const statuses = await this.checkDependencies();
        const playwrightStatus = statuses.find(s => s.name === 'playwright-core');
        return playwrightStatus?.installed ?? false;
    }

    /**
     * Install missing dependencies
     */
    public async installDependencies(packages?: string[]): Promise<InstallResult> {
        const packagesToInstall = packages || REQUIRED_PACKAGES.map(p => p.name);
        
        // Check which are missing
        const statuses = await this.checkDependencies();
        const missing = statuses
            .filter(s => !s.installed && packagesToInstall.includes(s.name))
            .map(s => s.name);

        if (missing.length === 0) {
            return {
                success: true,
                installedPackages: [],
                failedPackages: []
            };
        }

        return new Promise((resolve) => {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Installing browser automation dependencies...',
                cancellable: false
            }, async (progress) => {
                const installedPackages: string[] = [];
                const failedPackages: string[] = [];

                for (const pkg of missing) {
                    progress.report({ message: `Installing ${pkg}...` });
                    
                    try {
                        await this.installPackage(pkg);
                        installedPackages.push(pkg);
                    } catch (error: any) {
                        console.error(`[BrowserDependencyInstaller] Failed to install ${pkg}:`, error);
                        failedPackages.push(pkg);
                    }
                }

                const success = failedPackages.length === 0;
                
                if (success) {
                    vscode.window.showInformationMessage(
                        `✅ Browser automation dependencies installed: ${installedPackages.join(', ')}`
                    );
                } else {
                    vscode.window.showWarningMessage(
                        `⚠️ Some packages failed to install: ${failedPackages.join(', ')}`
                    );
                }

                resolve({
                    success,
                    installedPackages,
                    failedPackages
                });
            });
        });
    }

    /**
     * Install a single package using npm
     */
    private async installPackage(packageName: string): Promise<void> {
        return new Promise((resolve, reject) => {
            // Determine install location - prefer extension directory
            let installDir = this.extensionPath;
            
            // Fallback to workspace if extension path not set
            if (!installDir) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    installDir = workspaceFolders[0].uri.fsPath;
                } else {
                    reject(new Error('No installation directory available'));
                    return;
                }
            }

            const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            
            console.log(`[BrowserDependencyInstaller] Installing ${packageName} in ${installDir}`);

            const child = cp.spawn(npmCmd, ['install', packageName, '--save'], {
                cwd: installDir,
                shell: true,
                env: process.env
            });

            let stderr = '';
            let stdout = '';

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                if (code === 0) {
                    console.log(`[BrowserDependencyInstaller] Successfully installed ${packageName}`);
                    resolve();
                } else {
                    console.error(`[BrowserDependencyInstaller] npm install failed:`, stderr);
                    reject(new Error(`npm install failed: ${stderr || stdout}`));
                }
            });

            child.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Show interactive setup prompt if dependencies are missing
     */
    public async promptInstallIfNeeded(): Promise<boolean> {
        const isAvailable = await this.isBrowserAutomationAvailable();
        
        if (isAvailable) {
            return true;
        }

        const choice = await vscode.window.showInformationMessage(
            'Browser automation requires additional packages (playwright-core). Would you like to install them now?',
            'Install Now',
            'Later'
        );

        if (choice === 'Install Now') {
            const result = await this.installDependencies();
            return result.success;
        }

        return false;
    }

    /**
     * Get installation instructions for manual setup
     */
    public getManualInstallInstructions(): string {
        return `
# Browser Automation Setup

Browser automation requires the following npm packages:

## Required:
npm install playwright-core

## Optional (for visual comparison):
npm install pixelmatch pngjs

## Install Chromium browser:
npx playwright install chromium

---

Alternatively, use the extension command:
> VibeArchitect: Install Browser Dependencies
        `.trim();
    }
}

// ============================================
// EXPORTS
// ============================================

export function getBrowserDependencyInstaller(): BrowserDependencyInstaller {
    return BrowserDependencyInstaller.getInstance();
}

/**
 * Register VS Code commands for dependency management
 */
export function registerDependencyCommands(context: vscode.ExtensionContext): void {
    const installer = getBrowserDependencyInstaller();
    installer.setExtensionPath(context.extensionPath);

    // Command: Install browser dependencies
    context.subscriptions.push(
        vscode.commands.registerCommand('vibearchitect.installBrowserDependencies', async () => {
            await installer.installDependencies();
        })
    );

    // Command: Check browser dependencies
    context.subscriptions.push(
        vscode.commands.registerCommand('vibearchitect.checkBrowserDependencies', async () => {
            const statuses = await installer.checkDependencies();
            
            const message = statuses.map(s => {
                const icon = s.installed ? '✅' : '❌';
                const version = s.version ? ` (v${s.version})` : '';
                const required = s.required ? ' [required]' : ' [optional]';
                return `${icon} ${s.name}${version}${required}`;
            }).join('\n');

            const allInstalled = statuses.filter(s => s.required).every(s => s.installed);
            
            if (allInstalled) {
                vscode.window.showInformationMessage(
                    `Browser Automation Ready!\n\n${message}`,
                    { modal: true }
                );
            } else {
                const choice = await vscode.window.showWarningMessage(
                    `Missing Dependencies:\n\n${message}`,
                    'Install Now',
                    'Cancel'
                );
                
                if (choice === 'Install Now') {
                    await installer.installDependencies();
                }
            }
        })
    );
}
