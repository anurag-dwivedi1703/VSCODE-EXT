import * as React from 'react';

interface DiffLine {
    type: 'addition' | 'deletion' | 'context';
    content: string;
    oldLineNum?: number;
    newLineNum?: number;
}

interface DiffViewerProps {
    filePath: string;
    beforeContent: string | null;
    afterContent: string;
    onClose: () => void;
}

/**
 * Simple line-by-line diff algorithm
 * For a more sophisticated diff, consider using a library like 'diff'
 */
function computeDiff(before: string, after: string): DiffLine[] {
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const result: DiffLine[] = [];

    // Simple LCS-based diff would be ideal, but for now use a simpler approach
    // We'll use a basic algorithm that detects additions and deletions

    let i = 0; // before index
    let j = 0; // after index
    let oldLineNum = 1;
    let newLineNum = 1;

    while (i < beforeLines.length || j < afterLines.length) {
        if (i >= beforeLines.length) {
            // Remaining lines in after are additions
            result.push({
                type: 'addition',
                content: afterLines[j],
                newLineNum: newLineNum++
            });
            j++;
        } else if (j >= afterLines.length) {
            // Remaining lines in before are deletions
            result.push({
                type: 'deletion',
                content: beforeLines[i],
                oldLineNum: oldLineNum++
            });
            i++;
        } else if (beforeLines[i] === afterLines[j]) {
            // Lines match - context
            result.push({
                type: 'context',
                content: beforeLines[i],
                oldLineNum: oldLineNum++,
                newLineNum: newLineNum++
            });
            i++;
            j++;
        } else {
            // Lines differ - check ahead for matches
            // Simple heuristic: look for the after line in remaining before lines
            const matchInBefore = beforeLines.slice(i + 1, i + 10).indexOf(afterLines[j]);
            const matchInAfter = afterLines.slice(j + 1, j + 10).indexOf(beforeLines[i]);

            if (matchInBefore !== -1 && (matchInAfter === -1 || matchInBefore <= matchInAfter)) {
                // Found after line ahead in before - these are deletions
                result.push({
                    type: 'deletion',
                    content: beforeLines[i],
                    oldLineNum: oldLineNum++
                });
                i++;
            } else if (matchInAfter !== -1) {
                // Found before line ahead in after - this is an addition
                result.push({
                    type: 'addition',
                    content: afterLines[j],
                    newLineNum: newLineNum++
                });
                j++;
            } else {
                // No match found - treat as deletion then addition
                result.push({
                    type: 'deletion',
                    content: beforeLines[i],
                    oldLineNum: oldLineNum++
                });
                result.push({
                    type: 'addition',
                    content: afterLines[j],
                    newLineNum: newLineNum++
                });
                i++;
                j++;
            }
        }
    }

    return result;
}

export function DiffViewer({ filePath, beforeContent, afterContent, onClose }: DiffViewerProps) {
    const diffLines = React.useMemo(() => {
        return computeDiff(beforeContent || '', afterContent);
    }, [beforeContent, afterContent]);

    const stats = React.useMemo(() => {
        const additions = diffLines.filter(l => l.type === 'addition').length;
        const deletions = diffLines.filter(l => l.type === 'deletion').length;
        return { additions, deletions };
    }, [diffLines]);

    const fileName = filePath.split(/[\\/]/).pop() || filePath;

    return (
        <div className="diff-viewer">
            <div className="diff-header">
                <div className="diff-title">
                    <span className="diff-filename">{fileName}</span>
                    <span className="diff-stats">
                        <span className="stat-add">+{stats.additions}</span>
                        <span className="stat-del">-{stats.deletions}</span>
                    </span>
                </div>
                <button className="icon-btn-small" onClick={onClose} title="Close Diff">×</button>
            </div>
            <div className="diff-body">
                {beforeContent === null && (
                    <div className="diff-new-file-badge">New File</div>
                )}
                {diffLines.map((line, i) => (
                    <div key={i} className={`diff-line ${line.type}`}>
                        <span className="line-num old">{line.oldLineNum || ''}</span>
                        <span className="line-num new">{line.newLineNum || ''}</span>
                        <span className="line-prefix">
                            {line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '}
                        </span>
                        <span className="line-content">{line.content || ' '}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
