import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import './App.css';
import { vscode } from './utilities/vscode';
import { BrowserPreview } from './components/BrowserPreview';
import { ResizableLayout } from './components/ResizableLayout';

// Mock Data
const DEFAULT_WORKSPACES = [
    { id: '1', name: 'No Workspace Open', status: 'Idle' }
];

type LogType = 'user' | 'agent' | 'tool' | 'error' | 'info' | 'system' | 'artifact';

interface LogGroup {
    type: LogType;
    content: string;
    details?: string[]; // For tools or system logs
    isOpen?: boolean;
}

function parseLogs(logs: string[]): LogGroup[] {
    const groups: LogGroup[] = [];
    let currentGroup: LogGroup | null = null;
    let systemGroup: LogGroup | null = null;

    for (const log of logs) {
        // Filter out "Thinking..." and duplicate "Mission Complete"
        if (log.includes('Thinking...')) continue;
        if (log.toLowerCase() === 'mission complete' && groups.length > 0 && groups[groups.length - 1].content.includes('MISSION COMPLETE')) continue;

        // User
        if (log.startsWith('**User**:')) {
            if (currentGroup) groups.push(currentGroup);
            if (systemGroup) { groups.push(systemGroup); systemGroup = null; }
            currentGroup = { type: 'user', content: log.replace('**User**:', '').trim() };
        }
        // Agent
        else if (log.startsWith('**Gemini**:')) {
            if (currentGroup) groups.push(currentGroup);
            if (systemGroup) { groups.push(systemGroup); systemGroup = null; }
            currentGroup = { type: 'agent', content: log.replace('**Gemini**:', '').trim() };
        }
        // Tool Call
        else if (log.includes('[Tool Call]:')) {
            if (currentGroup && currentGroup.type !== 'tool') {
                groups.push(currentGroup);
                currentGroup = null;
            }
            if (systemGroup) { groups.push(systemGroup); systemGroup = null; }

            const cleanLog = log.replace('> [Tool Call]:', '').trim();
            if (!currentGroup) {
                currentGroup = { type: 'tool', content: cleanLog, details: [] };
            } else {
                // Start new tool block if previous was tool
                groups.push(currentGroup);
                currentGroup = { type: 'tool', content: cleanLog, details: [] };
            }
        }
        // Tool Result
        else if (log.includes('[Result]:')) {
            if (currentGroup && currentGroup.type === 'tool') {
                currentGroup.details?.push(log.replace('> [Result]:', '').trim());
            } else {
                // Orphan result, treat as info
                if (currentGroup) groups.push(currentGroup);
                currentGroup = { type: 'info', content: log };
            }
        }
        // Error
        else if (log.startsWith('Error:')) {
            if (currentGroup) groups.push(currentGroup);
            if (systemGroup) { groups.push(systemGroup); systemGroup = null; }
            currentGroup = { type: 'error', content: log };
        }
        // System Logs (Initializing, Creating Worktree, etc.)
        else if (
            log.startsWith('Initializing') ||
            log.startsWith('Creating Isolated') ||
            log.startsWith('Worktree created') ||
            log.includes('**Worktree Created**') ||
            log.startsWith('Consulting Gemini')
        ) {
            if (currentGroup) groups.push(currentGroup);
            currentGroup = null; // Reset current main group

            if (!systemGroup) {
                systemGroup = { type: 'system', content: 'System Initialization', details: [] };
            }
            systemGroup.details?.push(log);
        }
        // Artifact created
        else if (log.includes('[Artifact Created]:')) {
            if (currentGroup) groups.push(currentGroup);
            if (systemGroup) { groups.push(systemGroup); systemGroup = null; }

            const path = log.replace('[Artifact Created]:', '').trim();
            currentGroup = { type: 'artifact', content: path };
        }
        else {
            // Append to current if match type
            if (currentGroup && (currentGroup.type === 'agent' || currentGroup.type === 'user')) {
                currentGroup.content += '\n' + log;
            } else if (currentGroup && currentGroup.type === 'tool') {
                currentGroup.details?.push(log);
            } else if (systemGroup) {
                systemGroup.details?.push(log);
            } else {
                // Fallback info
                if (log.trim()) {
                    if (currentGroup) groups.push(currentGroup);
                    currentGroup = { type: 'info', content: log };
                }
            }
        }
    }
    if (systemGroup) groups.push(systemGroup);
    if (currentGroup) groups.push(currentGroup);
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
    const logGroups = activeAgent ? parseLogs(activeAgent.logs) : [];

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
                        <div className="pane-header">ANTIGRAVITY</div>

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
                                            if (group.type === 'agent') {
                                                return (
                                                    <div key={i} className="msg-row msg-row-agent">
                                                        <div className="msg-avatar">🤖</div>
                                                        <div className="msg-bubble msg-agent">
                                                            <div className="msg-content markdown-body">
                                                                <ReactMarkdown>{group.content}</ReactMarkdown>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            }
                                            if (group.type === 'tool') {
                                                return (
                                                    <div key={i} className="msg-tool">
                                                        <details>
                                                            <summary>🛠️ Used Tool: <code>{group.content.split('(')[0]}...</code></summary>
                                                            <div className="tool-details">
                                                                <div className="tool-call">{group.content}</div>
                                                                {group.details?.map((d, di) => (
                                                                    <div key={di} className="tool-result">{d}</div>
                                                                ))}
                                                            </div>
                                                        </details>
                                                    </div>
                                                );
                                            }
                                            if (group.type === 'artifact') {
                                                return (
                                                    <div key={i} className="msg-artifact-card">
                                                        <div className="artifact-icon">📄</div>
                                                        <div className="artifact-info">
                                                            <div className="artifact-name">{group.content.split(/[\\/]/).pop()}</div>
                                                            <div className="artifact-desc">Information Artifact</div>
                                                        </div>
                                                        <button className="artifact-open-btn"
                                                            onClick={() => vscode.postMessage({ command: 'previewFile', path: group.content, taskId: activeAgent.id })}>
                                                            OPEN
                                                        </button>
                                                    </div>
                                                );
                                            }
                                            if (group.type === 'error') {
                                                return <div key={i} className="msg-error">⚠️ {group.content}</div>;
                                            }
                                            // Handle alerts especially
                                            if (group.content.includes('[!IMPORTANT]')) {
                                                return (
                                                    <div key={i} className="msg-alert">
                                                        <ReactMarkdown>{group.content}</ReactMarkdown>
                                                    </div>
                                                );
                                            }
                                            return <div key={i} className="msg-info">{group.content}</div>;
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
                        )}
                    </main>
                }
                right={
                    /* RIGHT PANE: CONTEXT & BROWSER */
                    <aside className="pane-context">
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

                        {rightPaneTab === 'context' ? (
                            <div className="context-list">
                                {previewContent ? (
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
                        )}
                    </aside>
                }
            />
        </div>
    );
}

export default App;
