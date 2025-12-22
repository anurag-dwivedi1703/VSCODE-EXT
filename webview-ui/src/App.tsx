import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import './App.css';
import { vscode } from './utilities/vscode';
import { BrowserPreview } from './components/BrowserPreview';
import { ResizableLayout } from './components/ResizableLayout';
import { DiffViewer } from './components/DiffViewer';

// Mock Data
const DEFAULT_WORKSPACES = [
    { id: '1', name: 'No Workspace Open', status: 'Idle' }
];

type LogType = 'user' | 'agent' | 'tool' | 'error' | 'info' | 'system' | 'artifact' | 'completion';

interface LogGroup {
    type: LogType | 'step';
    content: string;
    details?: string[]; // For system logs
    // For Step
    title?: string;
    markdown?: string;
    tools?: { name: string, call: string, result?: string, checkpointId?: string, filePath?: string, timestamp?: number }[];
    artifacts?: string[];
    status?: 'running' | 'completed' | 'failed';
}

function parseLogs(logs: string[], checkpoints: { id: string, message: string }[] = []): LogGroup[] {
    const groups: LogGroup[] = [];
    let currentStep: LogGroup | null = null;
    let systemGroup: LogGroup | null = null;

    const commitStep = () => {
        if (currentStep) {
            // Determine title if not set or generic
            if (!currentStep.title || currentStep.title.startsWith('Thinking')) {
                if (currentStep.markdown) {
                    // Use first sentence of markdown as title
                    const firstLine = currentStep.markdown.split('\n')[0].replace(/\*\*/g, '').trim();
                    const shortTitle = firstLine.length > 80 ? firstLine.substring(0, 80) + '...' : firstLine;
                    if (shortTitle) currentStep.title = `💭 ${shortTitle}`;
                }
            }
            groups.push(currentStep);
            currentStep = null;
        }
    };

    const commitSystem = () => {
        if (systemGroup) {
            groups.push(systemGroup);
            systemGroup = null;
        }
    };

    for (const log of logs) {
        // Skip duplicate mission complete usually at end
        if (log.toLowerCase() === 'mission complete' && groups.length > 0 && groups[groups.length - 1].content.includes('MISSION COMPLETE')) continue;

        // Mission Summary Special Log
        if (log.startsWith('[MISSION_COMPLETE_SUMMARY]:')) {
            commitStep();
            commitSystem();
            const summaryText = log.replace('[MISSION_COMPLETE_SUMMARY]:', '').trim();
            groups.push({ type: 'completion', content: summaryText });
            continue;
        }

        // User Message
        if (log.startsWith('**User**:')) {
            commitStep();
            commitSystem();
            groups.push({ type: 'user', content: log.replace('**User**:', '').trim() });
        }
        // Turn Marker (Thinking...)
        else if (log.includes('Thinking...')) {
            // If we have an existing step that is "Thinking...", maybe update it?
            // Or usually "Thinking..." marks start of new turn.
            commitStep();
            commitSystem();

            const turnNum = log.match(/Turn (\d+):/)?.[1] || '';
            currentStep = {
                type: 'step',
                content: log,
                title: turnNum ? `Thinking (Turn ${turnNum})...` : 'Thinking...',
                markdown: '',
                tools: [],
                artifacts: [],
                status: 'running'
            };
        }
        // Agent Message (matches **Gemini**: or **Claude**: or similar variations)
        else if (log.match(/^\*{0,2}\s*(Gemini|Claude)\s*\*{0,2}:/i)) {
            commitSystem();
            const text = log.replace(/^\*{0,2}\s*(Gemini|Claude)\s*\*{0,2}:\s*/i, '').trim();

            if (!currentStep) {
                // If text comes without "Thinking" (e.g. Planning mode reply), create step
                currentStep = {
                    type: 'step',
                    content: 'Agent Reply',
                    title: 'Response',
                    markdown: text,
                    tools: [],
                    artifacts: [],
                    status: 'running'
                };
            } else {
                // Append to existing step (e.g. Thinking -> Tools -> Response)
                if (currentStep.markdown) currentStep.markdown += '\n\n' + text;
                else currentStep.markdown = text;

                // FIX: Aggressively update title from first sentence if it's currently generic
                // We rely on the fact that 'text' here uses the cleaned log content
                if (currentStep.title && currentStep.title.includes('Thinking')) {
                    const cleanText = text.replace(/\*\*/g, '').trim();
                    if (cleanText.length > 5) {
                        let firstSentence = cleanText.split(/[.?!]/, 1)[0].trim().replace(/\n/g, ' ');
                        if (firstSentence.length > 60) {
                            firstSentence = firstSentence.substring(0, 60) + '...';
                        }
                        if (firstSentence.length > 0) {
                            currentStep.title = `💭 ${firstSentence}`;
                        }
                    }
                }
            }
        }

        // Tool Call
        else if (log.includes('[Tool Call]:')) {
            commitSystem();
            const cleanLog = log.replace('> [Tool Call]:', '').trim();
            const fnName = cleanLog.split('(')[0].trim();

            // Find Checkpoint
            const matchedCheckpoint = checkpoints.find(cp => cp.message.includes(cleanLog));

            if (!currentStep) {
                // Orphan tool call? Create implicit step
                currentStep = {
                    type: 'step',
                    content: 'Tool Execution',
                    title: `Executing ${fnName}...`,
                    markdown: '',
                    tools: [],
                    artifacts: [],
                    status: 'running'
                };
            }
            // Add tool
            // Extract file path for write_file calls
            let filePath: string | undefined;
            let timestamp: number | undefined;
            if (fnName === 'write_file') {
                // Parse path from call like: write_file({"path":"src/app.ts","content":"..."})
                const pathMatch = cleanLog.match(/["']path["']\s*:\s*["']([^"']+)["']/);
                if (pathMatch) {
                    filePath = pathMatch[1];
                    timestamp = Date.now(); // Use current time as approximation
                }
            }

            currentStep.tools?.push({
                name: fnName,
                call: cleanLog,
                result: '',
                checkpointId: matchedCheckpoint?.id,
                filePath,
                timestamp
            });
        }
        // Tool Result
        else if (log.includes('[Result]:')) {
            if (currentStep && currentStep.tools && currentStep.tools.length > 0) {
                // Attach to last tool
                const lastTool = currentStep.tools[currentStep.tools.length - 1];
                const res = log.replace('> [Result]:', '').trim();
                lastTool.result = lastTool.result ? lastTool.result + '\n' + res : res;
            }
            // Else ignore parsing error
        }
        // Artifact
        else if (log.includes('[Artifact Created]:')) {
            const path = log.replace('[Artifact Created]:', '').trim();
            if (currentStep) {
                if (!currentStep.artifacts?.includes(path)) {
                    currentStep.artifacts?.push(path);
                }
            } else {
                // Implicit step or just log as artifact card?
                // Let's create a standalone artifact group if no step
                groups.push({ type: 'artifact', content: path });
            }
        }
        // Error
        else if (log.startsWith('Error:') || log.includes('> [Error]:')) {
            if (currentStep) {
                // Append error to markdown or logic?
                currentStep.markdown += `\n\n> ⚠️ **Error**: ${log.replace('> [Error]:', '')}`;
                currentStep.status = 'failed';
            } else {
                groups.push({ type: 'error', content: log });
            }
        }
        // System / Info
        else if (
            log.startsWith('Initializing') ||
            log.startsWith('Creating Isolated') ||
            log.includes('**Worktree Created**') ||
            log.startsWith('Consulting Gemini')
        ) {
            commitStep();
            if (!systemGroup) {
                systemGroup = { type: 'system', content: 'System Initialization', details: [] };
            }
            systemGroup.details?.push(log);
        }
        else {
            // Misc logs
            if (systemGroup) {
                systemGroup.details?.push(log);
            }
        }
    }

    commitStep();
    commitSystem();

    return groups;
}

function App() {
    const [workspaces, setWorkspaces] = useState(DEFAULT_WORKSPACES);
    const [selectedWorkspace, setSelectedWorkspace] = useState(DEFAULT_WORKSPACES[0].id);
    const [dynamicAgents, setDynamicAgents] = useState<any[]>([]);
    const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
    const [showNewAgentModal, setShowNewAgentModal] = useState(false);

    // Preview State
    const [previewContent, setPreviewContent] = useState<string | null>(null);
    const [previewPath, setPreviewPath] = useState<string | null>(null);

    // Right Pane Tab State
    const [rightPaneTab, setRightPaneTab] = useState<'context' | 'browser'>('context');

    // Context State
    const [contextFiles, setContextFiles] = useState<string[]>([]);

    // Browser Reload State
    const [browserReloadTrigger, setBrowserReloadTrigger] = useState(0);

    // Diff Viewer State
    const [diffContent, setDiffContent] = useState<{ path: string, before: string | null, after: string } | null>(null);

    // Auto-scroll logic
    const logsEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            const message = event.data;
            if (message.command === 'taskUpdate') {
                setDynamicAgents(prev => {
                    const exists = prev.find(a => a.id === message.task.id);
                    if (!expandedAgentId && !exists) {
                        setExpandedAgentId(message.task.id);
                    }
                    if (exists) {
                        return prev.map(a => a.id === message.task.id ? message.task : a);
                    }
                    return [...prev, message.task];
                });
            }
            if (message.command === 'updateWorkspaces') {
                setWorkspaces(message.workspaces);
                setSelectedWorkspace(prev => {
                    const exists = message.workspaces.find((w: any) => w.id === prev);
                    return exists ? prev : (message.workspaces[0]?.id || '');
                });
            }
            if (message.command === 'fileContent') {
                setPreviewContent(message.content);
                setPreviewPath(message.path);
            }
            if (message.command === 'contextSelected') {
                setContextFiles(prev => [...prev, ...message.paths]);
            }
            if (message.command === 'reloadBrowser') {
                setRightPaneTab('browser');
                setBrowserReloadTrigger(Date.now());
            }
            if (message.command === 'diffContent') {
                setDiffContent({
                    path: message.path,
                    before: message.before,
                    after: message.after
                });
                setRightPaneTab('context');
            }
        };
        window.addEventListener('message', messageHandler);
        vscode.postMessage({ command: 'getWorkspaces' });
        vscode.postMessage({ command: 'getTasks' });
        return () => window.removeEventListener('message', messageHandler);
    }, [expandedAgentId]);

    // Auto-scroll to bottom of logs
    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [dynamicAgents]);

    const activeAgents = dynamicAgents;
    // State for New Agent Composer
    const [composerMode, setComposerMode] = useState<'planning' | 'fast'>('planning');
    const [composerModel, setComposerModel] = useState<'gemini-3-pro-preview' | 'gemini-3-flash-preview'>('gemini-3-pro-preview');

    const handleStartTask = (prompt: string) => {
        if (!prompt.trim()) return;
        vscode.postMessage({
            command: 'startTask',
            text: prompt,
            workspaceId: selectedWorkspace,
            mode: composerMode,
            model: composerModel
        });
        // Optional: Reset composer or switch view
    };

    const handleAddWorkspace = () => {
        vscode.postMessage({ command: 'addWorkspace' });
    };

    const activeAgent = activeAgents.find(a => a.id === expandedAgentId) || activeAgents[0];
    const logGroups = activeAgent ? parseLogs(activeAgent.logs, activeAgent.checkpoints || []) : [];

    // Helper to start new chat
    const handleNewChat = () => {
        setExpandedAgentId(null); // Deselect current agent to show Composer
    };

    return (
        <div className="app-container">
            <ResizableLayout
                left={
                    /* LEFT PANE: WORKSPACE & MISSIONS */
                    <aside className="pane-sidebar">
                        <div className="pane-header">
                            <span className="title">VIBEARCHITECT v1.4</span>
                        </div>

                        <div className="sub-header">
                            <span>WORKSPACES</span>
                            <button className="icon-btn" onClick={handleAddWorkspace} title="Add Workspace">+</button>
                        </div>

                        <div className="workspace-list">
                            {workspaces.map(ws => {
                                const wsAgents = activeAgents.filter(a => a.worktreePath === ws.id);
                                return (
                                    <div key={ws.id} className="workspace-group">
                                        <div className="workspace-header">
                                            <div className="workspace-info">
                                                <span className="workspace-icon">📂</span>
                                                <span className="workspace-name">{ws.name}</span>
                                            </div>
                                            <div className="workspace-actions">
                                                <button className="icon-btn-small" onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSelectedWorkspace(ws.id);
                                                    handleNewChat();
                                                }} title="New Mission">
                                                    +
                                                </button>
                                            </div>
                                        </div>
                                        <div className="workspace-missions">
                                            {wsAgents.length > 0 ? (
                                                wsAgents.map(agent => (
                                                    <div key={agent.id}
                                                        className={`mission-item ${expandedAgentId === agent.id ? 'active' : ''}`}
                                                        onClick={() => {
                                                            setExpandedAgentId(agent.id);
                                                            if (agent.worktreePath) setSelectedWorkspace(agent.worktreePath);
                                                        }}>
                                                        <div className="mission-title">{agent.prompt.substring(0, 30)}...</div>
                                                        <div className="mission-status">{agent.status}</div>
                                                    </div>
                                                ))
                                            ) : (
                                                <div className="empty-mission-placeholder">No active missions</div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </aside>
                }
                center={
                    /* MIDDLE PANE: MAIN AGENT VIEW */
                    <main className="pane-main">
                        {activeAgent && expandedAgentId ? (
                            <>
                                <div className="pane-header custom-pane-header">
                                    <span className="agent-uid">AGENT-{activeAgent.id.substring(activeAgent.id.length - 6)}</span>
                                    <span className={`agent-status-badge ${activeAgent.status.toUpperCase()}`}>{activeAgent.status}</span>
                                    <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={handleNewChat} title="New Chat">➕ New</button>
                                </div>
                                <div className="agent-view">
                                    <div className="agent-header-large">
                                        <h1 className="agent-title">{activeAgent.prompt}</h1>
                                        {activeAgent.branchName && (
                                            <div className="agent-meta">Branch: <code>{activeAgent.branchName}</code></div>
                                        )}
                                    </div>

                                    <div className="agent-logs-container">
                                        {logGroups.map((group, i) => {
                                            if (group.type === 'system') {
                                                return (
                                                    <div key={i} className="msg-system">
                                                        <details>
                                                            <summary>⚙️ {group.content}</summary>
                                                            <div className="system-details">
                                                                {group.details?.map((d, di) => (
                                                                    <div key={di}>{d}</div>
                                                                ))}
                                                            </div>
                                                        </details>
                                                    </div>
                                                );
                                            }
                                            if (group.type === 'user') {
                                                return (
                                                    <div key={i} className="msg-row msg-row-user">
                                                        <div className="msg-bubble msg-user">
                                                            <div className="msg-content">{group.content}</div>
                                                        </div>
                                                        <div className="msg-avatar">👤</div>
                                                    </div>
                                                );
                                            }
                                            if (group.type === 'step') {
                                                return (
                                                    <div key={i} className="msg-step-card">
                                                        <div className="step-header">
                                                            <div className="step-icon">🤖</div>
                                                            <div className="step-title">{group.title}</div>
                                                        </div>
                                                        <div className="step-body">
                                                            {group.markdown && (
                                                                <div className="step-markdown markdown-body">
                                                                    <ReactMarkdown>{group.markdown}</ReactMarkdown>
                                                                </div>
                                                            )}

                                                            {/* Artifacts Created in this Step */}
                                                            {group.artifacts && group.artifacts.length > 0 && (
                                                                <div className="step-artifacts">
                                                                    {group.artifacts.map((path, ai) => (
                                                                        <div key={ai} className="mini-artifact-card"
                                                                            onClick={() => vscode.postMessage({ command: 'previewFile', path: path, taskId: activeAgent.id })}>
                                                                            <span className="icon">📄</span>
                                                                            <span className="name">{path.split(/[\\/]/).pop()}</span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}

                                                            {/* Files Modified - PROMINENT SECTION */}
                                                            {(() => {
                                                                const fileEdits = group.tools?.filter(t => t.name === 'write_file') || [];
                                                                if (fileEdits.length === 0) return null;
                                                                return (
                                                                    <div className="files-modified">
                                                                        <div className="files-modified-header">
                                                                            <span className="header-icon">📝</span>
                                                                            <span>Files Modified ({fileEdits.length})</span>
                                                                        </div>
                                                                        <div className="files-modified-list">
                                                                            {fileEdits.map((tool, fi) => {
                                                                                // Extract file path
                                                                                let filePath = tool.filePath;
                                                                                if (!filePath) {
                                                                                    const match = tool.call.match(/["']path["']\s*:\s*["']([^"']+)["']/);
                                                                                    if (match) filePath = match[1];
                                                                                }
                                                                                const fileName = filePath ? filePath.split(/[\\/]/).pop() : 'Unknown file';

                                                                                return (
                                                                                    <div key={fi} className="file-modified-card">
                                                                                        <div className="file-info">
                                                                                            <span className="file-icon">📄</span>
                                                                                            <span className="file-name">{fileName}</span>
                                                                                        </div>
                                                                                        <div className="file-actions">
                                                                                            <button
                                                                                                className="open-diff-btn-prominent"
                                                                                                title="View file changes"
                                                                                                onClick={(e) => {
                                                                                                    e.stopPropagation();
                                                                                                    if (filePath) {
                                                                                                        vscode.postMessage({
                                                                                                            command: 'getDiff',
                                                                                                            taskId: activeAgent.id,
                                                                                                            path: filePath
                                                                                                        });
                                                                                                    }
                                                                                                }}>
                                                                                                <span className="btn-icon">⇄</span>
                                                                                                Open Diff
                                                                                            </button>
                                                                                            <button
                                                                                                className="preview-file-btn"
                                                                                                title="Preview file"
                                                                                                onClick={(e) => {
                                                                                                    e.stopPropagation();
                                                                                                    if (filePath) {
                                                                                                        vscode.postMessage({
                                                                                                            command: 'previewFile',
                                                                                                            path: filePath,
                                                                                                            taskId: activeAgent.id
                                                                                                        });
                                                                                                    }
                                                                                                }}>
                                                                                                👁 View
                                                                                            </button>
                                                                                        </div>
                                                                                    </div>
                                                                                );
                                                                            })}
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })()}

                                                            {/* Progress Updates (Collapsed Tools) */}
                                                            {group.tools && group.tools.length > 0 && (
                                                                <details className="step-updates">
                                                                    <summary>Progress Updates ({group.tools.length})</summary>
                                                                    <div className="step-updates-list">
                                                                        {group.tools.map((tool, ti) => (
                                                                            <div key={ti} className={`step-tool-item ${tool.name === 'write_file' ? 'file-edit' : ''}`}>
                                                                                <div className="tool-row">
                                                                                    <span className="tool-name">⚡ {tool.name}</span>
                                                                                    <div className="tool-actions">
                                                                                        {tool.name === 'write_file' && (
                                                                                            <button
                                                                                                className="open-diff-btn"
                                                                                                title="Open Diff"
                                                                                                onClick={(e) => {
                                                                                                    e.stopPropagation();
                                                                                                    // Extract path from tool.call string
                                                                                                    let extractedPath = tool.filePath;
                                                                                                    if (!extractedPath) {
                                                                                                        // Try to extract from call: write_file({"path":"poem.md",...})
                                                                                                        const match = tool.call.match(/["']path["']\s*:\s*["']([^"']+)["']/);
                                                                                                        if (match) extractedPath = match[1];
                                                                                                    }
                                                                                                    if (extractedPath) {
                                                                                                        vscode.postMessage({
                                                                                                            command: 'getDiff',
                                                                                                            taskId: activeAgent.id,
                                                                                                            path: extractedPath
                                                                                                        });
                                                                                                    }
                                                                                                }}>
                                                                                                Open Diff
                                                                                            </button>
                                                                                        )}
                                                                                        {tool.checkpointId && (
                                                                                            <button className="revert-btn-small"
                                                                                                title="Revert to this state"
                                                                                                onClick={(e) => {
                                                                                                    e.stopPropagation();
                                                                                                    vscode.postMessage({
                                                                                                        command: 'requestRevert',
                                                                                                        taskId: activeAgent.id,
                                                                                                        checkpointId: tool.checkpointId
                                                                                                    });
                                                                                                }}>
                                                                                                ↩ Revert
                                                                                            </button>
                                                                                        )}
                                                                                    </div>
                                                                                </div>
                                                                                <div className="tool-args">{tool.call}</div>
                                                                                {tool.result && <div className="tool-result-mini">{tool.result.substring(0, 100)}{tool.result.length > 100 ? '...' : ''}</div>}
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                </details>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            }

                                            if (group.type === 'artifact') {
                                                return (
                                                    <div key={i} className="msg-artifact-card">
                                                        <div className="artifact-icon">📄</div>
                                                        <div className="artifact-info">
                                                            <div className="artifact-name">{group.content.split(/[\\/]/).pop()}</div>
                                                            <div className="artifact-desc">Artifact</div>
                                                        </div>
                                                        <button className="artifact-open-btn"
                                                            onClick={() => vscode.postMessage({ command: 'previewFile', path: group.content, taskId: activeAgent.id })}>
                                                            OPEN
                                                        </button>
                                                    </div>
                                                );
                                            }
                                            if (group.type === 'completion') {
                                                return (
                                                    <div key={i} className="msg-completion-card">
                                                        <div className="completion-header">
                                                            <span className="icon">🚀</span>
                                                            <span className="title">Mission Complete</span>
                                                        </div>
                                                        <div className="completion-body markdown-body">
                                                            <ReactMarkdown>{group.content}</ReactMarkdown>
                                                        </div>
                                                    </div>
                                                );
                                            }
                                            if (group.type === 'error') {
                                                return <div key={i} className="msg-error">⚠️ {group.content}</div>;
                                            }
                                            return null;
                                        })}
                                        <div ref={logsEndRef} />
                                    </div>
                                </div>

                                {/* Reply Footer */}
                                <footer className="reply-footer">
                                    {contextFiles.length > 0 && (
                                        <div className="context-chips">
                                            {contextFiles.map((f, idx) => (
                                                <div key={idx} className="chip">
                                                    <span>{f.split(/[\\/]/).pop()}</span>
                                                    <span className="chip-remove" onClick={() => setContextFiles(prev => prev.filter((_, i) => i !== idx))}>×</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    <div className="input-row">
                                        <button className="icon-btn-add" title="Add Context" onClick={() => vscode.postMessage({ command: 'selectContext' })}>+</button>
                                        <input
                                            className="reply-input"
                                            type="text"
                                            placeholder="Reply to agent..."
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    const input = e.target as HTMLInputElement;
                                                    if (input.value.trim()) {
                                                        vscode.postMessage({
                                                            command: 'replyToAgent',
                                                            text: input.value,
                                                            taskId: activeAgent.id,
                                                            attachments: contextFiles
                                                        });
                                                        input.value = '';
                                                        setContextFiles([]); // Clear context after send
                                                    }
                                                }
                                            }}
                                        />
                                    </div>
                                    <div className="model-selector-bar">
                                        <span className="mode-pill">← {activeAgent.mode === 'planning' ? 'Planning' : 'Fast'}</span>
                                        <select
                                            className="model-dropdown"
                                            value={activeAgent.model || 'gemini-3-pro-preview'}
                                            onChange={(e) => vscode.postMessage({
                                                command: 'changeModel',
                                                taskId: activeAgent.id,
                                                model: e.target.value
                                            })}
                                        >
                                            <option value="gemini-3-pro-preview">Gemini 3 Pro</option>
                                            <option value="gemini-3-flash-preview">Gemini 3 Flash</option>
                                            <option value="claude-opus-4-5-20251101">Claude Opus 4.5</option>
                                        </select>
                                        <span className="submit-arrow">→</span>
                                    </div>
                                </footer>
                            </>
                        ) : (
                            <div className="composer-container">
                                <div className="composer-header">
                                    <h1>What can I do for you?</h1>
                                    <div style={{ textAlign: 'center', fontSize: '12px', opacity: 0.7, marginTop: '5px' }}>
                                        Working in: <strong>{workspaces.find(w => w.id === selectedWorkspace)?.name || 'Unknown Workspace'}</strong>
                                    </div>
                                </div>

                                <div className="composer-controls">
                                    {/* Mode Selector */}
                                    <div className="control-group">
                                        <div className="control-label">Mode</div>
                                        <div className="mode-selector">
                                            <div
                                                className={`mode-option ${composerMode === 'planning' ? 'selected' : ''}`}
                                                onClick={() => setComposerMode('planning')}
                                                title="Agent creates a plan (task.md) before execution."
                                            >
                                                <span className="mode-icon">📋</span>
                                                <div className="mode-info">
                                                    <div className="mode-title">Planning</div>
                                                    <div className="mode-desc">Best for complex tasks. Creates a plan first.</div>
                                                </div>
                                            </div>
                                            <div
                                                className={`mode-option ${composerMode === 'fast' ? 'selected' : ''}`}
                                                onClick={() => setComposerMode('fast')}
                                                title="Agent executes directly without creating a plan."
                                            >
                                                <span className="mode-icon">⚡</span>
                                                <div className="mode-info">
                                                    <div className="mode-title">Fast</div>
                                                    <div className="mode-desc">Best for quick fixes. Executes immediately.</div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Model Selector */}
                                    <div className="control-group">
                                        <div className="control-label">Model</div>
                                        <select
                                            className="model-select"
                                            value={composerModel}
                                            onChange={(e) => setComposerModel(e.target.value as any)}
                                        >
                                            <option value="gemini-3-pro-preview">Gemini 3 Pro (Reasoning)</option>
                                            <option value="gemini-3-flash-preview">Gemini 3 Flash (Speed)</option>
                                            <option value="claude-opus-4-5-20251101">Claude Opus 4.5 (Thinking)</option>
                                        </select>
                                    </div>
                                </div>

                                <div className="composer-input-area">
                                    <textarea
                                        className="composer-textarea"
                                        placeholder="Describe your task..."
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                handleStartTask((e.target as HTMLTextAreaElement).value);
                                            }
                                        }}
                                    />
                                    <div className="composer-actions">
                                        <button className="primary-btn" onClick={(e) => {
                                            const textarea = (e.target as HTMLElement).closest('.composer-input-area')?.querySelector('textarea');
                                            if (textarea) handleStartTask(textarea.value);
                                        }}>
                                            Start Mission 🚀
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )
                        }
                    </main >
                }
                right={
                    /* RIGHT PANE: CONTEXT & BROWSER */
                    < aside className="pane-context" >
                        <div className="tab-switcher">
                            <button
                                className={`tab-btn ${rightPaneTab === 'context' ? 'active' : ''}`}
                                onClick={() => setRightPaneTab('context')}>
                                CONTEXT
                            </button>
                            <button
                                className={`tab-btn ${rightPaneTab === 'browser' ? 'active' : ''}`}
                                onClick={() => setRightPaneTab('browser')}>
                                BROWSER
                            </button>
                        </div>

                        {
                            rightPaneTab === 'context' ? (
                                <div className="context-list">
                                    {diffContent ? (
                                        <DiffViewer
                                            filePath={diffContent.path}
                                            beforeContent={diffContent.before}
                                            afterContent={diffContent.after}
                                            onClose={() => setDiffContent(null)}
                                        />
                                    ) : previewContent ? (
                                        <div className="file-preview">
                                            <div className="preview-header">
                                                <span className="preview-filename">{previewPath?.split(/[\\/]/).pop()}</span>
                                                <button className="icon-btn-small" onClick={() => setPreviewContent(null)}>×</button>
                                            </div>
                                            <div className="preview-body markdown-body">
                                                {previewPath?.endsWith('.md') ? (
                                                    <ReactMarkdown>{previewContent}</ReactMarkdown>
                                                ) : (
                                                    <pre>{previewContent}</pre>
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="empty-state">
                                            <div>No artifacts open. Click OPEN on an artifact card to view.</div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <BrowserPreview taskId={activeAgent?.id || ''} />
                            )
                        }
                    </aside >
                }
            />
        </div >
    );
}

export default App;
