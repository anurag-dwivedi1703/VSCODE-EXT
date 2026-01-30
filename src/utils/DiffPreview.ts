/**
 * DiffPreview - Preview diff changes before applying
 * 
 * Shows a side-by-side diff view using VS Code's built-in diff editor,
 * allowing users to review changes before they're applied.
 * 
 * @module DiffPreview
 */

import * as vscode from 'vscode';
import { SearchReplaceBlock, findSearchBlock } from './SearchReplaceParser';

/**
 * TextDocumentContentProvider for virtual preview documents
 */
class DiffPreviewContentProvider implements vscode.TextDocumentContentProvider {
    private content: Map<string, string> = new Map();
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();

    readonly onDidChange = this._onDidChange.event;

    setContent(uri: vscode.Uri, content: string): void {
        this.content.set(uri.toString(), content);
        this._onDidChange.fire(uri);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.content.get(uri.toString()) || '';
    }

    clearContent(uri: vscode.Uri): void {
        this.content.delete(uri.toString());
    }
}

// Singleton provider
let _provider: DiffPreviewContentProvider | null = null;
let _disposable: vscode.Disposable | null = null;

function getProvider(): DiffPreviewContentProvider {
    if (!_provider) {
        _provider = new DiffPreviewContentProvider();
        _disposable = vscode.workspace.registerTextDocumentContentProvider(
            'diff-preview',
            _provider
        );
    }
    return _provider;
}

/**
 * Apply SEARCH/REPLACE blocks to content without modifying the actual file
 * Returns the preview content with all changes applied
 */
export function applyBlocksToContent(
    originalContent: string,
    blocks: SearchReplaceBlock[]
): { content: string; appliedCount: number; errors: string[] } {
    let content = originalContent;
    let appliedCount = 0;
    const errors: string[] = [];

    // Apply blocks in reverse order (by line number) to avoid offset issues
    const sortedBlocks = [...blocks].sort((a, b) =>
        (b.lineNumber || 0) - (a.lineNumber || 0)
    );

    for (let i = 0; i < sortedBlocks.length; i++) {
        const block = sortedBlocks[i];
        const match = findSearchBlock(content, block.searchContent);

        if (match) {
            content =
                content.substring(0, match.index) +
                block.replaceContent +
                content.substring(match.index + match.matchLength);
            appliedCount++;
        } else {
            errors.push(`Block ${i + 1}: SEARCH content not found`);
        }
    }

    return { content, appliedCount, errors };
}

/**
 * Show a diff preview comparing original file with proposed changes
 * 
 * @param originalUri - URI of the original file
 * @param blocks - SEARCH/REPLACE blocks to preview
 * @param title - Optional title for the diff view
 */
export async function showDiffPreview(
    originalUri: vscode.Uri,
    blocks: SearchReplaceBlock[],
    title?: string
): Promise<{ shown: boolean; appliedCount: number; errors: string[] }> {
    try {
        // Read original content
        const originalContent = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(originalUri)
        );

        // Apply blocks to get preview content
        const preview = applyBlocksToContent(originalContent, blocks);

        if (preview.appliedCount === 0) {
            return {
                shown: false,
                appliedCount: 0,
                errors: preview.errors
            };
        }

        // Create virtual document for preview
        const provider = getProvider();
        const previewUri = vscode.Uri.parse(
            `diff-preview:${originalUri.path}?preview`
        );
        provider.setContent(previewUri, preview.content);

        // Show diff
        const diffTitle = title || `Preview: ${vscode.workspace.asRelativePath(originalUri)}`;
        await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            previewUri,
            diffTitle,
            { preview: true }
        );

        return {
            shown: true,
            appliedCount: preview.appliedCount,
            errors: preview.errors
        };

    } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
            shown: false,
            appliedCount: 0,
            errors: [`Failed to show diff preview: ${errorMsg}`]
        };
    }
}

/**
 * Show diff between original and modified content strings
 */
export async function showContentDiff(
    originalUri: vscode.Uri,
    modifiedContent: string,
    title?: string
): Promise<void> {
    const provider = getProvider();
    const previewUri = vscode.Uri.parse(
        `diff-preview:${originalUri.path}?modified`
    );
    provider.setContent(previewUri, modifiedContent);

    const diffTitle = title || `Changes: ${vscode.workspace.asRelativePath(originalUri)}`;
    await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        previewUri,
        diffTitle,
        { preview: true }
    );
}

/**
 * Dispose of the preview provider
 */
export function disposePreviewProvider(): void {
    if (_disposable) {
        _disposable.dispose();
        _disposable = null;
    }
    _provider = null;
}
