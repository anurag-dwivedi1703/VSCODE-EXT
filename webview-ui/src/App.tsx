import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import './App.css';
import { vscode } from './utilities/vscode';

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
                if (message.workspaces.length > 0) {
                    setSelectedWorkspace(message.workspaces[0].id);
                }
            }
            if (message.command === 'fileContent') {
                setPreviewContent(message.content);
                setPreviewPath(message.path);
            }
        };
        window.addEventListener('message', messageHandler);
        vscode.postMessage({ command: 'getWorkspaces' });
        return () => window.removeEventListener('message', messageHandler);
    }, [expandedAgentId]);

    // Auto-scroll to bottom of logs
    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [dynamicAgents]);

    const activeAgents = dynamicAgents;
    const activeAgent = activeAgents.find(a => a.id === expandedAgentId) || activeAgents[0];
    const logGroups = activeAgent ? parseLogs(activeAgent.logs) : [];

    return (
        <div className="layout-container">
            {/* LEFT PANE: WORKSPACE & MISSIONS */}
            <aside className="pane-sidebar">
                <div className="pane-header">ANTIGRAVITY</div>

                <div className="sub-header">
                    <span>ACTIVE WORKSPACE</span>
                    <button className="icon-btn" onClick={() => vscode.postMessage({ command: 'addWorkspace' })}>+</button>
                </div>
                <div className="workspace-list">
                    {workspaces.map(ws => (
                        <div key={ws.id} className={`workspace-item ${selectedWorkspace === ws.id ? 'active' : ''}`}
                            onClick={() => setSelectedWorkspace(ws.id)}>
                            📂 {ws.name}
                        </div>
                    ))}
                </div>

                <div className="sub-header">
                    <span>MISSIONS</span>
                    <button className="icon-btn" onClick={() => setShowNewAgentModal(true)}>New Mission</button>
                </div>
                <div className="mission-list">
                    {activeAgents.map(agent => (
                        <div key={agent.id}
                            className={`mission-item ${expandedAgentId === agent.id ? 'active' : ''}`}
                            onClick={() => setExpandedAgentId(agent.id)}>
                            <div className="mission-title">{agent.prompt.substring(0, 30)}...</div>
                            <div className="mission-status">{agent.status}</div>
                        </div>
                    ))}
                </div>
            </aside>

            {/* MIDDLE PANE: MAIN AGENT VIEW */}
            <main className="pane-main">
                {activeAgent ? (
                    <>
                        <div className="pane-header custom-pane-header">
                            {activeAgent.id}
                            <span className={`agent-status-badge ${activeAgent.status.toUpperCase()}`}>{activeAgent.status}</span>
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
                                                taskId: activeAgent.id
                                            });
                                            input.value = '';
                                        }
                                    }
                                }}
                            />
                        </footer>
                    </>
                ) : (
                    <div className="empty-state">
                        <h2>No Active Agents</h2>
                        <p>Select a mission or spin up a new agent.</p>
                    </div>
                )}
            </main>

            {/* RIGHT PANE: CONTEXT & ARTIFACTS OR PREVIEW */}
            <aside className="pane-context">
                <div className="pane-header">
                    <span>{previewContent ? 'PREVIEW' : 'REVIEW CONTEXT'}</span>
                    {previewContent && (
                        <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => {
                            setPreviewContent(null);
                            setPreviewPath(null);
                        }}>❌ Close</button>
                    )}
                </div>

                {previewContent ? (
                    <div className="markdown-body" style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
                        <h3>{previewPath?.split(/[\\/]/).pop()}</h3>
                        <ReactMarkdown>{previewContent}</ReactMarkdown>
                    </div>
                ) : (
                    <div className="context-list">
                        {activeAgent && activeAgent.worktreePath && (
                            <div className="context-item">
                                <strong>Worktree:</strong><br />
                                <code style={{ wordBreak: 'break-all' }}>{activeAgent.worktreePath}</code>
                            </div>
                        )}

                        {/* ARTIFACTS LIST */}
                        {activeAgent && activeAgent.artifacts && activeAgent.artifacts.length > 0 && (
                            <div>
                                <div className="sub-header">Created Artifacts</div>
                                {activeAgent.artifacts.map((path: string, i: number) => (
                                    <div key={i} className="context-item artifact-item"
                                        onClick={() => vscode.postMessage({ command: 'previewFile', path, taskId: activeAgent.id })}>
                                        <span style={{ marginRight: '5px' }}>📄</span>
                                        <span>{path.split(/[\\/]/).pop()}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {(!activeAgent || !activeAgent.artifacts || activeAgent.artifacts.length === 0) && (
                            <div className="context-item empty-context" >
                                No artifacts created yet.
                            </div>
                        )}
                    </div>
                )}
            </aside>

            {/* Modal */}
            {showNewAgentModal && (
                <div className="modal-overlay">
                    <div className="modal">
                        <h2>New Agent Task</h2>
                        <input id="taskInput" type="text" placeholder="Describe the task..." autoFocus />
                        <div className="modal-actions">
                            <button onClick={() => setShowNewAgentModal(false)}>Cancel</button>
                            <button className="primary-btn" onClick={() => {
                                const input = document.getElementById('taskInput') as HTMLInputElement;
                                vscode.postMessage({
                                    command: 'startTask',
                                    text: input.value || 'Default Task'
                                });
                                setShowNewAgentModal(false);
                            }}>Start Agent</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;
