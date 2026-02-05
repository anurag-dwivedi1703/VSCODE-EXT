import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import './App.css';
import { vscode } from './utilities/vscode';
import { BrowserPreview } from './components/BrowserPreview';
import { ResizableLayout } from './components/ResizableLayout';
import { DiffViewer } from './components/DiffViewer';
import { ConstitutionReviewModal } from './components/ConstitutionReviewModal';
import { PhaseProgress, PhaseInfo } from './components/PhaseProgress';
import { ContextBudgetIndicator, BudgetStatus } from './components/ContextBudgetIndicator';
import { PhaseApprovalModal, PhaseApprovalData } from './components/PhaseApprovalModal';
import { BrowserSetupWizard } from './components/BrowserSetupWizard';
import { SessionManagerUI } from './components/SessionManagerUI';
import { TypewriterText } from './components/TypewriterText';
import { RefinementQuestionnaire } from './components/RefinementQuestionnaire';

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

function parseLogs(
    logs: string[], 
    checkpoints: { id: string, message: string }[] = [],
    options: { agentStatus?: string; isWaitingForUserInput?: boolean } = {}
): LogGroup[] {
    const { agentStatus, isWaitingForUserInput } = options;
    // Determine if the agent is actively working (not waiting for user)
    const isAgentActivelyWorking = (agentStatus === 'executing' || agentStatus === 'planning') && !isWaitingForUserInput;
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

    for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
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
            // Mark previous step as completed before starting new turn
            if (currentStep) {
                currentStep.status = 'completed';
            }
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

            // FIX: Create new bubble when agent sends a new substantial response
            // after tool execution (not just appending everything together)
            const shouldCreateNewBubble = currentStep && 
                currentStep.markdown && 
                currentStep.markdown.length > 50 && // Has substantial content already
                currentStep.tools && 
                currentStep.tools.length > 0 && // Has tool calls
                currentStep.tools.some(t => t.result); // At least one tool has completed

            if (!currentStep || shouldCreateNewBubble) {
                // Commit previous step if exists
                if (currentStep) {
                    currentStep.status = 'completed';
                    commitStep();
                }
                
                // Create new step for this agent response
                const cleanText = text.replace(/\*\*/g, '').trim();
                let title = 'Response';
                if (cleanText.length > 5) {
                    let firstSentence = cleanText.split(/[.?!]/, 1)[0].trim().replace(/\n/g, ' ');
                    if (firstSentence.length > 60) {
                        firstSentence = firstSentence.substring(0, 60) + '...';
                    }
                    if (firstSentence.length > 0) {
                        title = `💭 ${firstSentence}`;
                    }
                }
                
                currentStep = {
                    type: 'step',
                    content: 'Agent Reply',
                    title,
                    markdown: text,
                    tools: [],
                    artifacts: [],
                    status: 'running'
                };
            } else {
                // Append to existing step (first response in a thinking turn)
                if (currentStep.markdown) currentStep.markdown += '\n\n' + text;
                else currentStep.markdown = text;

                // Update title from first sentence if it's currently generic
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
            if (fnName === 'write_file' || fnName === 'apply_diff') {
                // Parse path from call like: write_file({"path":"src/app.ts","content":"..."})
                // or apply_diff({"path":"src/file.ts","diff":"..."})
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
        // ========== REFINEMENT MODE LOGS ==========
        // Refinement Stage Progress (e.g., [RefinementStage:ANALYZING] message)
        // These show the current processing stage with active animations
        else if (log.startsWith('[RefinementStage:')) {
            commitStep();
            commitSystem();
            
            // Parse stage and message: [RefinementStage:ANALYZING] 🔍 Analyzing...
            const stageMatch = log.match(/^\[RefinementStage:(\w+)\]\s*(.*)$/);
            const stage = stageMatch ? stageMatch[1] : 'PROCESSING';
            const message = stageMatch ? stageMatch[2] : log;
            
            // Determine title based on stage
            const stageTitle = stage === 'ANALYZING' ? '🔍 Analyzing Request' :
                              stage === 'DRAFTING' ? '📝 Drafting Requirements' :
                              stage === 'CRITIQUING' ? '🔍 Reviewing Draft' :
                              stage === 'REFINING' ? '⏳ Generating Final PRD' :
                              '⏳ Processing...';
            
            // Last AI bubble stays active visually until next bubble appears
            const isLastLog = i === logs.length - 1;
            const shouldBeRunning = isLastLog;
            
            currentStep = {
                type: 'step',
                content: 'Refinement',
                title: stageTitle,
                markdown: message,
                tools: [],
                artifacts: [],
                status: shouldBeRunning ? 'running' : 'completed'
            };
        }
        // Analyst/System responses (Refinement Mode)
        else if (log.match(/^\*\*(Analyst|System)\*\*:/i) || log.startsWith('**Analyst Questions:**') || log.startsWith('**Clarifying Questions:**') || log.startsWith('**Draft PRD:**') || log.startsWith('**Critic Feedback:**') || log.startsWith('**Critic Review:**') || log.startsWith('**Final PRD Ready**')) {
            commitStep();
            commitSystem();
            // Create a step for Analyst/Refinement content
            const text = log.replace(/^\*\*(Analyst|System)\*\*:\s*/i, '').trim();
            
            // Determine if this is the last log (still in progress) for animations
            const isLastLog = i === logs.length - 1;
            const isFinalPRD = log.startsWith('**Final PRD Ready**');
            
            // Last AI bubble stays active visually (except for Final PRD which is a terminal state)
            const shouldBeRunning = isLastLog && !isFinalPRD;
            
            currentStep = {
                type: 'step',
                content: 'Refinement',
                title: log.startsWith('**Analyst Questions:**') ? '📋 Analyst Questions' :
                    log.startsWith('**Clarifying Questions:**') ? '📋 Clarifying Questions' :
                    log.startsWith('**Draft PRD:**') ? '📝 Draft PRD' :
                        log.startsWith('**Critic Feedback:**') ? '🔍 Critic Feedback' :
                            log.startsWith('**Critic Review:**') ? '🔍 Critic Review' :
                            log.startsWith('**Final PRD Ready**') ? '✅ Final PRD' :
                                '💬 Analyst Response',
                markdown: log,  // Keep the full markdown including the header
                tools: [],
                artifacts: [],
                // Set to 'running' for animations if agent is actively working
                status: shouldBeRunning ? 'running' : 'completed'
            };
        }
        // Refinement State/System Messages (e.g., > [Refinement]:)
        else if (log.startsWith('> [Refinement]') || log.startsWith('> [Context]:') || log.includes('[Refinement]')) {
            // These are system/debug logs - append to system group, don't create step bubbles
            commitStep();
            if (!systemGroup) {
                systemGroup = { type: 'system', content: 'Refinement Mode', details: [] };
            }
            systemGroup.details?.push(log);
        }
        // Generic markdown content - fallback for any unmatched content that looks like markdown
        else if (log.trim().length > 0 && (log.includes('**') || log.startsWith('##') || log.startsWith('#') || log.startsWith('- ') || log.startsWith('1.'))) {
            // This is likely markdown content that should be displayed
            if (currentStep) {
                // Append to existing step
                currentStep.markdown = currentStep.markdown ? currentStep.markdown + '\n\n' + log : log;
            } else {
                // Create a new step for this markdown content
                currentStep = {
                    type: 'step',
                    content: 'Content',
                    title: '💬 Response',
                    markdown: log,
                    tools: [],
                    artifacts: [],
                    status: 'completed'
                };
            }
        }
        else {
            // Misc logs still go to system group if active, or append to current step
            if (systemGroup) {
                systemGroup.details?.push(log);
            } else if (currentStep && log.trim()) {
                // Append to current step's markdown if we have one
                currentStep.markdown = currentStep.markdown ? currentStep.markdown + '\n' + log : log;
            }
            // Otherwise truly drop empty/irrelevant lines
        }
    }

    commitStep();
    commitSystem();

    // POST-PARSE: Mark the last 'step' group as 'running' so it always shows
    // the active animation (rainbow/pulse). This ensures the last AI bubble
    // stays visually active regardless of task status or what system/debug
    // logs may have been appended after it. Only exception: Final PRD and
    // mission complete are terminal states that should show as completed.
    for (let g = groups.length - 1; g >= 0; g--) {
        if (groups[g].type === 'step') {
            const isFinal = groups[g].title?.includes('Final PRD') || 
                           groups[g].title?.includes('Mission Complete');
            if (!isFinal && groups[g].status !== 'failed') {
                groups[g].status = 'running';
            }
            break; // Only affect the last step group
        }
    }

    return groups;
}

function App() {
    const [workspaces, setWorkspaces] = useState(DEFAULT_WORKSPACES);
    const [selectedWorkspace, setSelectedWorkspace] = useState(DEFAULT_WORKSPACES[0].id);
    const [dynamicAgents, setDynamicAgents] = useState<any[]>([]);
    const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
    const [showNewAgentModal, setShowNewAgentModal] = useState(false);

    // Preview State - supports multiple files
    const [previewFiles, setPreviewFiles] = useState<Array<{ path: string; content: string }>>([]);

    // Right Pane Tab State
    const [rightPaneTab, setRightPaneTab] = useState<'context' | 'browser'>('context');

    // Context State
    const [contextFiles, setContextFiles] = useState<string[]>([]);

    // Browser Reload State
    const [browserReloadTrigger, setBrowserReloadTrigger] = useState(0);

    // Diff Viewer State
    const [diffContent, setDiffContent] = useState<{ path: string, before: string | null, after: string } | null>(null);

    // Agent Mode State (Global - applies to all missions)
    const [agentMode, setAgentMode] = useState<'auto' | 'review-enabled'>('auto');

    // Chat ID for mission folder isolation (generated once per webview session)
    const [chatId] = useState<string>(() => {
        // Generate a unique 8-character hex ID for this chat session
        const array = new Uint8Array(4);
        crypto.getRandomValues(array);
        return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    });

    // Pending Approval State (for Review Enabled mode, Refinement Mode, and Login Checkpoints)
    const [pendingApproval, setPendingApproval] = useState<{
        type: 'plan' | 'command' | 'prd' | 'login-checkpoint';
        content: string;
        taskId: string;
        riskReason?: string;
    } | null>(null);

    // Questionnaire State (for interactive Refinement Mode questions)
    const [questionnaireData, setQuestionnaireData] = useState<{
        taskId: string;
        sessionId: string;
        questions: any[];
        contextSummary?: string;
        rawAnalystResponse?: string;
    } | null>(null);

    // Context Pane Tab Navigation (for switching between multiple open items)
    const [contextPaneIndex, setContextPaneIndex] = useState(0);

    // Review Comment State (ephemeral - for current session)
    const [reviewComment, setReviewComment] = useState('');

    // Constitution Review State
    const [constitutionReview, setConstitutionReview] = useState<{
        taskId: string;
        content: string;
        type: 'constitution' | 'constitution-update' | 'constitution-drift';
    } | null>(null);

    // Phase Execution State
    const [phaseInfo, setPhaseInfo] = useState<{
        taskId: string;
        enabled: boolean;
        mode: 'single' | 'phased';
        currentPhaseIndex: number;
        totalPhases: number;
        phases: PhaseInfo[];
        budget: {
            used: number;
            total: number;
            percentUsed: number;
            status: BudgetStatus;
        };
        totalTokensUsed: number;
        totalTokensEstimated: number;
    } | null>(null);

    // Phase Approval Modal State
    const [phaseApprovalData, setPhaseApprovalData] = useState<(PhaseApprovalData & { taskId: string }) | null>(null);

    // Browser Setup & Session Manager State
    const [showBrowserSetup, setShowBrowserSetup] = useState(false);
    const [showSessionManager, setShowSessionManager] = useState(false);

    // Auto-scroll logic - Smart scroll that respects user's scroll position
    const logsEndRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [isUserNearBottom, setIsUserNearBottom] = useState(true);

    // Handle scroll events to track if user is near bottom
    const handleScroll = () => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const threshold = 150; // pixels from bottom to consider "near bottom"
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
        setIsUserNearBottom(isNearBottom);
    };

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
                // Add to preview files array (avoid duplicates)
                setPreviewFiles(prev => {
                    const exists = prev.find(f => f.path === message.path);
                    if (exists) {
                        // Update content if already exists
                        return prev.map(f => f.path === message.path ? { path: message.path, content: message.content } : f);
                    }
                    return [...prev, { path: message.path, content: message.content }];
                });
                setRightPaneTab('context'); // Switch to context pane when file opened
            }
            if (message.command === 'contextSelected') {
                setContextFiles(prev => [...prev, ...message.paths]);
            }
            // Handle composer context selection (for Start Mission attachments)
            if (message.command === 'composerContextSelected') {
                const newAttachments = message.files.map((f: { path: string; name: string; type: string; content?: string }) => ({
                    name: f.name,
                    type: f.type.startsWith('image') ? 'image' as const : 
                          (f.type.includes('pdf') || f.type.includes('text') || f.type.includes('word')) ? 'document' as const : 'file' as const,
                    path: f.path,
                    mimeType: f.type,
                    dataUrl: f.content  // For images, backend sends base64 content
                }));
                setComposerAttachments(prev => [...prev, ...newAttachments]);
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
            // Handle approval requests from backend (Review Enabled mode)
            if (message.command === 'awaitingApproval') {
                setPendingApproval({
                    type: 'plan',
                    content: message.content,
                    taskId: message.taskId
                });
                setRightPaneTab('context');
            }
            // Handle PRD review from Refinement Mode
            if (message.command === 'prdReview') {
                setPendingApproval({
                    type: 'prd',
                    content: message.content,
                    taskId: message.taskId
                });
                setRightPaneTab('context');
            }
            if (message.command === 'commandApprovalRequired') {
                setPendingApproval({
                    type: 'command',
                    content: message.content,
                    taskId: message.taskId,
                    riskReason: message.riskReason
                });
            }
            // Handle login checkpoint from browser automation
            if (message.command === 'loginCheckpoint') {
                setPendingApproval({
                    type: 'login-checkpoint',
                    content: message.content,
                    taskId: message.taskId
                });
            }
            // Handle interactive questionnaire from refinement mode
            if (message.command === 'questionnaireReady') {
                setQuestionnaireData({
                    taskId: message.taskId,
                    sessionId: message.sessionId,
                    questions: message.questions,
                    contextSummary: message.contextSummary,
                    rawAnalystResponse: message.rawAnalystResponse
                });
                setRightPaneTab('context');  // Switch to context pane to show questionnaire
            }
            if (message.command === 'approvalComplete') {
                setPendingApproval(null);
                setReviewComment('');
                setConstitutionReview(null);  // Also clear constitution review
                setQuestionnaireData(null);   // Also clear questionnaire
            }
            // Handle constitution review from backend
            if (message.command === 'constitutionReview') {
                setConstitutionReview({
                    taskId: message.taskId,
                    content: message.content,
                    type: message.approvalType || 'constitution'
                });
            }

            // Phase execution message handlers
            if (message.command === 'phaseUpdate') {
                setPhaseInfo({
                    taskId: message.taskId,
                    ...message.phaseInfo
                });
            }
            if (message.command === 'phaseApprovalNeeded') {
                setPhaseApprovalData({
                    taskId: message.taskId,
                    ...message.approvalData
                });
            }
            if (message.command === 'phasedExecutionStarted') {
                console.log(`[App] Phased execution started: ${message.totalPhases} phases using ${message.strategy} strategy`);
            }
            if (message.command === 'phaseComplete') {
                console.log(`[App] Phase ${message.phaseId} completed:`, message.result);
                // Phase info will be updated via phaseUpdate message
            }
            if (message.command === 'allPhasesComplete') {
                console.log(`[App] All phases complete! Total tokens: ${message.totalTokens}`);
                setPhaseApprovalData(null);
            }
        };
        window.addEventListener('message', messageHandler);
        vscode.postMessage({ command: 'getWorkspaces' });
        vscode.postMessage({ command: 'getTasks' });
        return () => window.removeEventListener('message', messageHandler);
    }, [expandedAgentId]);

    // Auto-scroll to bottom of logs - only if user is near bottom
    // Uses smooth scrolling with a slight delay for better UX
    const prevLogsLength = useRef(0);
    
    useEffect(() => {
        if (isUserNearBottom && scrollContainerRef.current) {
            // Check if there's new content by comparing total logs length
            const activeAgent = dynamicAgents.find(a => a.id === expandedAgentId);
            const currentLogsLength = activeAgent?.logs?.length || 0;
            
            if (currentLogsLength > prevLogsLength.current) {
                // Small delay to let new content render before scrolling
                const timeoutId = setTimeout(() => {
                    const container = scrollContainerRef.current;
                    if (container) {
                        container.scrollTo({
                            top: container.scrollHeight,
                            behavior: 'smooth'
                        });
                    }
                }, 100);
                prevLogsLength.current = currentLogsLength;
                return () => clearTimeout(timeoutId);
            }
        }
    }, [dynamicAgents, isUserNearBottom, expandedAgentId]);

    const activeAgents = dynamicAgents;
    // State for New Agent Composer
    const [composerMode, setComposerMode] = useState<'planning' | 'fast' | 'refinement'>('planning');
    const [composerModel, setComposerModel] = useState<string>('claude-opus-4-5-20251101');
    // Track if refinement mode has been used in this chat (prevents reuse in replyToTask)
    const [refinementUsed, setRefinementUsed] = useState(false);
    
    // Attachment state for Start Mission composer
    const [composerAttachments, setComposerAttachments] = useState<Array<{
        name: string;
        type: 'image' | 'document' | 'file';
        path?: string;       // For workspace files
        dataUrl?: string;    // For uploaded files (base64)
        mimeType?: string;
        size?: number;
    }>>([]);
    const composerFileInputRef = useRef<HTMLInputElement>(null);

    const handleStartTask = (prompt: string) => {
        if (!prompt.trim()) return;

        // Mark refinement as used if selected, then switch to planning for future messages
        if (composerMode === 'refinement') {
            setRefinementUsed(true);
            // After starting refinement, default to planning for follow-ups
            setComposerMode('planning');
        }

        vscode.postMessage({
            command: 'startTask',
            text: prompt,
            workspaceId: selectedWorkspace,
            mode: composerMode,
            model: composerModel,
            agentMode: agentMode,  // Include global agent mode
            chatId: chatId,        // Include chat ID for mission folder isolation
            attachments: composerAttachments  // Include attachments (images, docs)
        });
        
        // Clear attachments after sending
        setComposerAttachments([]);
    };

    // Handle file upload for composer attachments
    const handleComposerFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        Array.from(files).forEach(file => {
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result as string;
                const isImage = file.type.startsWith('image/');
                const isDocument = ['application/pdf', 'text/plain', 'text/markdown', 
                    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.type);
                
                setComposerAttachments(prev => [...prev, {
                    name: file.name,
                    type: isImage ? 'image' : (isDocument ? 'document' : 'file'),
                    dataUrl,
                    mimeType: file.type,
                    size: file.size
                }]);
            };
            reader.readAsDataURL(file);
        });

        // Reset input so same file can be selected again
        event.target.value = '';
    };

    // Handle workspace file selection for composer
    const handleComposerContextSelect = () => {
        vscode.postMessage({ command: 'selectComposerContext' });
    };

    // Remove attachment from composer
    const removeComposerAttachment = (index: number) => {
        setComposerAttachments(prev => prev.filter((_, i) => i !== index));
    };

    const handleAddWorkspace = () => {
        vscode.postMessage({ command: 'addWorkspace' });
    };

    // Approval handlers for Review Enabled mode
    const handleApproveReview = () => {
        if (!pendingApproval) return;
        vscode.postMessage({
            command: 'approveReview',
            taskId: pendingApproval.taskId,
            feedback: reviewComment
        });
        setPendingApproval(null);
        setReviewComment('');
    };

    const handleRejectReview = () => {
        if (!pendingApproval) return;
        vscode.postMessage({
            command: 'rejectReview',
            taskId: pendingApproval.taskId
        });
        setPendingApproval(null);
        setReviewComment('');
    };

    const handleApproveCommand = () => {
        if (!pendingApproval) return;
        vscode.postMessage({
            command: 'approveCommand',
            taskId: pendingApproval.taskId
        });
        setPendingApproval(null);
    };

    const handleDeclineCommand = () => {
        if (!pendingApproval) return;
        vscode.postMessage({
            command: 'declineCommand',
            taskId: pendingApproval.taskId
        });
        setPendingApproval(null);
    };

    // Login Checkpoint Handlers
    const handleConfirmLogin = () => {
        if (!pendingApproval) return;
        vscode.postMessage({
            command: 'confirmLogin',
            taskId: pendingApproval.taskId
        });
        setPendingApproval(null);
    };

    const handleCancelLogin = () => {
        if (!pendingApproval) return;
        vscode.postMessage({
            command: 'cancelLogin',
            taskId: pendingApproval.taskId
        });
        setPendingApproval(null);
    };

    // Questionnaire Handlers
    const handleQuestionnaireSubmit = (taskId: string, sessionId: string, responses: any[]) => {
        vscode.postMessage({
            command: 'submitQuestionnaireAnswers',
            taskId,
            sessionId,
            responses
        });
        setQuestionnaireData(null);  // Clear questionnaire after submission
    };

    const handleQuestionnaireCancel = () => {
        setQuestionnaireData(null);  // Just hide the questionnaire
    };

    const handleAgentModeChange = (newMode: 'auto' | 'review-enabled') => {
        setAgentMode(newMode);
        vscode.postMessage({
            command: 'setAgentMode',
            mode: newMode
        });
    };

    // Constitution Review Handlers
    const handleApproveConstitution = (editedContent?: string) => {
        if (!constitutionReview) return;
        vscode.postMessage({
            command: 'approveConstitution',
            taskId: constitutionReview.taskId,
            feedback: editedContent || constitutionReview.content
        });
        setConstitutionReview(null);
    };

    const handleRejectConstitution = () => {
        if (!constitutionReview) return;
        vscode.postMessage({
            command: 'rejectConstitution',
            taskId: constitutionReview.taskId
        });
        setConstitutionReview(null);
    };

    const activeAgent = activeAgents.find(a => a.id === expandedAgentId) || activeAgents[0];
    
    // Determine if we're waiting for user input (questionnaire or pending approval)
    const isWaitingForUserInput = !!(questionnaireData || pendingApproval);
    
    const logGroups = activeAgent ? parseLogs(
        activeAgent.logs, 
        activeAgent.checkpoints || [],
        { 
            agentStatus: activeAgent.status, 
            isWaitingForUserInput 
        }
    ) : [];

    // Helper to start new chat
    const handleNewChat = () => {
        setExpandedAgentId(null); // Deselect current agent to show Composer
    };

    return (
        <div className="app-container">
            {/* Settings Bar */}
            <div className="settings-bar">
                <div className="settings-bar-left">
                    <span className="settings-label">Agent Mode:</span>
                    <div className="mode-toggle">
                        <button
                            className={`mode-toggle-btn ${agentMode === 'auto' ? 'active' : ''}`}
                            onClick={() => handleAgentModeChange('auto')}
                            title="Agent works autonomously without pause"
                        >
                            <span className="mode-icon">⚡</span>
                            Auto
                        </button>
                        <button
                            className={`mode-toggle-btn ${agentMode === 'review-enabled' ? 'active' : ''}`}
                            onClick={() => handleAgentModeChange('review-enabled')}
                            title="Agent pauses for review after plans and before high-risk commands"
                        >
                            <span className="mode-icon">🛡️</span>
                            Review Enabled
                        </button>
                    </div>
                </div>
                <div className="settings-bar-right">
                    {agentMode === 'review-enabled' && (
                        <span className="mode-indicator">
                            <span className="indicator-dot"></span>
                            Review mode active
                        </span>
                    )}
                </div>
            </div>

            {/* Command Approval Modal */}
            {pendingApproval && pendingApproval.type === 'command' && (
                <div className="modal-overlay">
                    <div className="command-approval-modal">
                        <div className="modal-header">
                            <span className="modal-icon">⚠️</span>
                            <h3>High-Risk Command Detected</h3>
                        </div>
                        <div className="modal-body">
                            <p className="risk-reason">{pendingApproval.riskReason || 'This command may have significant effects.'}</p>
                            <div className="command-preview">
                                <code>{pendingApproval.content}</code>
                            </div>
                        </div>
                        <div className="modal-actions">
                            <button className="decline-btn" onClick={handleDeclineCommand}>
                                ✕ Decline
                            </button>
                            <button className="approve-btn" onClick={handleApproveCommand}>
                                ✓ Accept
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Login Checkpoint Modal */}
            {pendingApproval && pendingApproval.type === 'login-checkpoint' && (
                <div className="modal-overlay">
                    <div className="login-checkpoint-modal">
                        <div className="modal-header">
                            <span className="modal-icon">🔐</span>
                            <h3>Authentication Required</h3>
                        </div>
                        <div className="modal-body">
                            <div className="login-instructions">
                                <ReactMarkdown>{pendingApproval.content}</ReactMarkdown>
                            </div>
                            <div className="login-steps">
                                <div className="step">
                                    <span className="step-number">1</span>
                                    <span className="step-text">Complete the login in the browser window</span>
                                </div>
                                <div className="step">
                                    <span className="step-number">2</span>
                                    <span className="step-text">Wait for the page to redirect after login</span>
                                </div>
                                <div className="step">
                                    <span className="step-number">3</span>
                                    <span className="step-text">Click "I've Logged In" below to continue</span>
                                </div>
                            </div>
                        </div>
                        <div className="modal-actions">
                            <button className="cancel-btn" onClick={handleCancelLogin}>
                                ✕ Skip Login
                            </button>
                            <button className="login-confirm-btn" onClick={handleConfirmLogin}>
                                ✓ I've Logged In
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Constitution Review Modal */}
            {constitutionReview && (
                <ConstitutionReviewModal
                    content={constitutionReview.content}
                    type={constitutionReview.type}
                    taskId={constitutionReview.taskId}
                    onApprove={handleApproveConstitution}
                    onReject={handleRejectConstitution}
                />
            )}

            {/* Phase Approval Modal */}
            {phaseApprovalData && (
                <PhaseApprovalModal
                    data={phaseApprovalData}
                    isOpen={true}
                    onApprove={(feedback) => {
                        vscode.postMessage({
                            command: 'phaseApprove',
                            taskId: phaseApprovalData.taskId,
                            feedback
                        });
                        setPhaseApprovalData(null);
                    }}
                    onReject={(reason) => {
                        vscode.postMessage({
                            command: 'phaseReject',
                            taskId: phaseApprovalData.taskId,
                            reason
                        });
                        setPhaseApprovalData(null);
                    }}
                    onSkip={() => {
                        vscode.postMessage({
                            command: 'phaseSkip',
                            taskId: phaseApprovalData.taskId,
                            reason: 'User skipped phase'
                        });
                        setPhaseApprovalData(null);
                    }}
                />
            )}

            {/* Browser Setup Wizard */}
            {showBrowserSetup && (
                <BrowserSetupWizard
                    onClose={() => setShowBrowserSetup(false)}
                    onBrowserSelected={(browser) => {
                        console.log('Browser selected:', browser);
                    }}
                />
            )}

            {/* Session Manager UI */}
            {showSessionManager && (
                <SessionManagerUI
                    onClose={() => setShowSessionManager(false)}
                    onSessionSelected={(session) => {
                        console.log('Session selected:', session);
                    }}
                />
            )}

            <ResizableLayout
                left={
                    /* LEFT PANE: WORKSPACE & MISSIONS */
                    <aside className="pane-sidebar">
                        <div className="pane-header">
                            <span className="title">VIBEARCHITECT v1.4</span>
                            <div className="header-tools">
                                <button 
                                    className="icon-btn-small" 
                                    onClick={() => setShowBrowserSetup(true)} 
                                    title="Browser Setup"
                                >
                                    🌐
                                </button>
                                <button 
                                    className="icon-btn-small" 
                                    onClick={() => setShowSessionManager(true)} 
                                    title="Session Manager"
                                >
                                    🔐
                                </button>
                            </div>
                        </div>

                        <div className="sub-header">
                            <span>WORKSPACES</span>
                            <button className="icon-btn" onClick={handleAddWorkspace} title="Add Workspace">+</button>
                        </div>

                        <div className="workspace-list">
                            {(() => {
                                const renderedAgentIds = new Set<string>();

                                const workspaceGroups = workspaces.map(ws => {
                                    // Normalize paths for comparison (Windows issue)
                                    const wsPath = ws.id.toLowerCase().replace(/\\/g, '/');

                                    const wsAgents = activeAgents.filter(a => {
                                        if (!a.worktreePath) return false;
                                        const agentPath = a.worktreePath.toLowerCase().replace(/\\/g, '/');
                                        return agentPath === wsPath || agentPath.startsWith(wsPath + '/');
                                    });

                                    wsAgents.forEach(a => renderedAgentIds.add(a.id));

                                    // Only show workspace group if it's the main selected one OR has active agents
                                    // Actually, we show all known workspaces for structure
                                    return (
                                        <div key={ws.id} className="workspace-group">
                                            <div className="workspace-header" onClick={() => setSelectedWorkspace(ws.id)}>
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
                                                            <div className="mission-title">{(agent.displayPrompt || agent.prompt).substring(0, 30)}...</div>
                                                            <div className="mission-status">{agent.status}</div>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <div className="empty-mission-placeholder">No active missions</div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                });

                                // Find Uncategorized Agents
                                const uncategorizedAgents = activeAgents.filter(a => !renderedAgentIds.has(a.id));

                                return (
                                    <>
                                        {workspaceGroups}
                                        {uncategorizedAgents.length > 0 && (
                                            <div className="workspace-group">
                                                <div className="workspace-header" style={{ opacity: 0.7 }}>
                                                    <div className="workspace-info">
                                                        <span className="workspace-icon">❓</span>
                                                        <span className="workspace-name">Other Missions</span>
                                                    </div>
                                                </div>
                                                <div className="workspace-missions">
                                                    {uncategorizedAgents.map(agent => (
                                                        <div key={agent.id}
                                                            className={`mission-item ${expandedAgentId === agent.id ? 'active' : ''}`}
                                                            onClick={() => {
                                                                setExpandedAgentId(agent.id);
                                                                // Don't switch workspace blindly if it's unknown
                                                            }}>
                                                            <div className="mission-title">{(agent.displayPrompt || agent.prompt).substring(0, 30)}...</div>
                                                            <div className="mission-status">{agent.status}</div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </>
                                );
                            })()}
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
                                </div>
                                <div className="agent-view" ref={scrollContainerRef} onScroll={handleScroll}>
                                    <div className="agent-header-large">
                                        <h1 className="agent-title">{activeAgent.displayPrompt || activeAgent.prompt}</h1>
                                        {activeAgent.branchName && (
                                            <div className="agent-meta">Branch: <code>{activeAgent.branchName}</code></div>
                                        )}
                                    </div>

                                    {/* Phase Execution Progress */}
                                    {phaseInfo && phaseInfo.taskId === activeAgent.id && phaseInfo.mode === 'phased' && (
                                        <div className="phase-execution-container">
                                            <PhaseProgress
                                                phases={phaseInfo.phases}
                                                currentPhaseIndex={phaseInfo.currentPhaseIndex}
                                                totalTokensUsed={phaseInfo.totalTokensUsed}
                                                totalTokensEstimated={phaseInfo.totalTokensEstimated}
                                            />
                                            <ContextBudgetIndicator
                                                used={phaseInfo.budget.used}
                                                total={phaseInfo.budget.total}
                                                status={phaseInfo.budget.status}
                                                phaseName={phaseInfo.phases[phaseInfo.currentPhaseIndex]?.name}
                                                compact={false}
                                            />
                                        </div>
                                    )}

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
                                                const isRunning = group.status === 'running';
                                                const statusClass = group.status || '';
                                                return (
                                                    <div key={i} className={`msg-step-card ${statusClass}`}>
                                                        <div className="step-header">
                                                            <div className={`step-icon ${isRunning ? 'active' : ''}`}>🤖</div>
                                                            <div className={`step-title ${isRunning ? 'thinking' : ''}`}>
                                                                {group.title}
                                                                {isRunning && <span className="loading-dots"></span>}
                                                            </div>
                                                        </div>
                                                        <div className="step-body">
                                                            {group.markdown && (
                                                                <div className={`step-markdown markdown-body ${isRunning ? 'typing' : ''}`}>
                                                                    {isRunning && group.markdown.length < 500 ? (
                                                                        <TypewriterText 
                                                                            text={group.markdown} 
                                                                            speed={8}
                                                                            isActive={isRunning}
                                                                        />
                                                                    ) : (
                                                                        <ReactMarkdown>{group.markdown}</ReactMarkdown>
                                                                    )}
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
                                                                const fileEdits = group.tools?.filter(t => t.name === 'write_file' || t.name === 'apply_diff') || [];
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
                                                                                const isSystemFile = fileName?.toLowerCase().match(/^(task\.md|implementation_plan\.md|mission_summary\.md|constitution\.md)$/) ||
                                                                                    filePath?.includes('.vibearchitect/');

                                                                                return (
                                                                                    <div key={fi} className="file-modified-card">
                                                                                        <div className="file-info">
                                                                                            <span className="file-icon">📄</span>
                                                                                            <span className="file-name">{fileName}</span>
                                                                                        </div>
                                                                                        <div className="file-actions">
                                                                                            {!isSystemFile ? (
                                                                                                <>
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
                                                                                                </>
                                                                                            ) : (
                                                                                                <button
                                                                                                    className="preview-file-btn primary"
                                                                                                    style={{ width: '100%', justifyContent: 'center' }}
                                                                                                    title="Open File"
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
                                                                                                    Open
                                                                                                </button>
                                                                                            )}
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
                                                                        {group.tools.map((tool, ti) => {
                                                                            const isExecuting = !tool.result && group.status === 'running' && ti === group.tools!.length - 1;
                                                                            return (
                                                                            <div key={ti} className={`step-tool-item ${tool.name === 'write_file' ? 'file-edit' : ''} ${isExecuting ? 'executing' : ''}`}>
                                                                                <div className="tool-row">
                                                                                    <span className="tool-name">⚡ {tool.name}</span>
                                                                                    <div className="tool-actions">
                                                                                        {(tool.name === 'write_file' || tool.name === 'apply_diff') && (
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
                                                                        );})}
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
                                        <textarea
                                            className="reply-input reply-textarea"
                                            placeholder="Reply to agent... (Enter to send, Shift+Enter for new line)"
                                            id={`reply-input-${activeAgent.id}`}
                                            rows={1}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && !e.shiftKey) {
                                                    e.preventDefault();
                                                    const textarea = e.target as HTMLTextAreaElement;
                                                    if (textarea.value.trim()) {
                                                        vscode.postMessage({
                                                            command: 'replyToAgent',
                                                            text: textarea.value,
                                                            taskId: activeAgent.id,
                                                            attachments: contextFiles
                                                        });
                                                        textarea.value = '';
                                                        textarea.style.height = 'auto';
                                                        setContextFiles([]); // Clear context after send
                                                    }
                                                }
                                            }}
                                            onInput={(e) => {
                                                // Auto-resize textarea
                                                const textarea = e.target as HTMLTextAreaElement;
                                                textarea.style.height = 'auto';
                                                textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
                                            }}
                                        />
                                    </div>
                                    <div className="model-selector-bar">
                                        {/* Mode Toggle - Clickable */}
                                        <button
                                            className={`mode-pill-btn ${activeAgent.mode || 'planning'}`}
                                            onClick={() => {
                                                const newMode = activeAgent.mode === 'fast' ? 'planning' : 'fast';
                                                vscode.postMessage({
                                                    command: 'changeMode',
                                                    taskId: activeAgent.id,
                                                    mode: newMode
                                                });
                                            }}
                                            title={`Click to switch to ${activeAgent.mode === 'fast' ? 'Planning' : 'Fast'} mode`}
                                        >
                                            {activeAgent.mode === 'fast' ? '⚡ Fast' : '📋 Planning'}
                                        </button>
                                        <select
                                            className="model-dropdown"
                                            value={activeAgent.model || 'claude-opus-4-5-20251101'}
                                            onChange={(e) => vscode.postMessage({
                                                command: 'changeModel',
                                                taskId: activeAgent.id,
                                                model: e.target.value
                                            })}
                                        >
                                            <option value="claude-opus-4-5-20251101">Claude Opus 4.5</option>
                                            <option value="claude-sonnet-4-5-20251101">Claude Sonnet 4.5</option>
                                            <option value="gpt-5-mini">GPT-5-mini (Copilot)</option>
                                        </select>
                                        {/* Submit or Stop Button */}
                                        {activeAgent.status === 'executing' || activeAgent.status === 'planning' ? (
                                            <button
                                                className="stop-btn"
                                                onClick={() => vscode.postMessage({
                                                    command: 'stopTask',
                                                    taskId: activeAgent.id
                                                })}
                                                title="Stop the current task"
                                            >
                                                ⏹ Stop
                                            </button>
                                        ) : (
                                            <button
                                                className="submit-btn"
                                                onClick={() => {
                                                    const textarea = document.getElementById(`reply-input-${activeAgent.id}`) as HTMLTextAreaElement;
                                                    if (textarea && textarea.value.trim()) {
                                                        vscode.postMessage({
                                                            command: 'replyToAgent',
                                                            text: textarea.value,
                                                            taskId: activeAgent.id,
                                                            attachments: contextFiles
                                                        });
                                                        textarea.value = '';
                                                        textarea.style.height = 'auto';
                                                        setContextFiles([]);
                                                    }
                                                }}
                                                title="Send message"
                                            >
                                                →
                                            </button>
                                        )}
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
                                                className={`mode-option ${composerMode === 'refinement' ? 'selected' : ''} ${refinementUsed ? 'disabled' : ''}`}
                                                onClick={() => !refinementUsed && setComposerMode('refinement')}
                                                title={refinementUsed
                                                    ? "Refinement already used for this chat. Start a new chat to use Refinement again."
                                                    : "Agent clarifies requirements before planning. Best for ambiguous or complex tasks."}
                                                style={refinementUsed ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                                            >
                                                <span className="mode-icon">🧠</span>
                                                <div className="mode-info">
                                                    <div className="mode-title">Refinement {refinementUsed && '✓'}</div>
                                                    <div className="mode-desc">{refinementUsed ? 'Already used in this chat' : 'Clarify requirements first. Best for ambiguous tasks.'}</div>
                                                </div>
                                            </div>
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
                                            onChange={(e) => setComposerModel(e.target.value)}
                                        >
                                            <option value="claude-opus-4-5-20251101">Claude Opus 4.5 (Thinking)</option>
                                            <option value="claude-sonnet-4-5-20251101">Claude Sonnet 4.5 (Fast)</option>
                                            <option value="gpt-5-mini">GPT-5-mini (Vision)</option>
                                        </select>
                                    </div>
                                </div>

                                <div className="composer-input-area">
                                    {/* Attachment Preview */}
                                    {composerAttachments.length > 0 && (
                                        <div className="composer-attachments">
                                            {composerAttachments.map((attachment, idx) => (
                                                <div key={idx} className={`attachment-chip ${attachment.type}`}>
                                                    {attachment.type === 'image' && attachment.dataUrl && (
                                                        <img 
                                                            src={attachment.dataUrl} 
                                                            alt={attachment.name}
                                                            className="attachment-thumbnail"
                                                        />
                                                    )}
                                                    {attachment.type !== 'image' && (
                                                        <span className="attachment-icon">
                                                            {attachment.type === 'document' ? '📄' : '📎'}
                                                        </span>
                                                    )}
                                                    <span className="attachment-name" title={attachment.name}>
                                                        {attachment.name.length > 20 
                                                            ? attachment.name.substring(0, 17) + '...' 
                                                            : attachment.name}
                                                    </span>
                                                    <button 
                                                        className="attachment-remove"
                                                        onClick={() => removeComposerAttachment(idx)}
                                                        title="Remove attachment"
                                                    >
                                                        ×
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    
                                    <div className="composer-input-row">
                                        {/* Hidden file input */}
                                        <input
                                            type="file"
                                            ref={composerFileInputRef}
                                            style={{ display: 'none' }}
                                            multiple
                                            accept="image/*,.pdf,.txt,.md,.doc,.docx"
                                            onChange={handleComposerFileUpload}
                                        />
                                        
                                        {/* Attachment button */}
                                        <button 
                                            className="icon-btn-attachment"
                                            onClick={() => composerFileInputRef.current?.click()}
                                            title="Attach image or document (UI mockups, specs, etc.)"
                                        >
                                            📎
                                        </button>
                                        
                                        {/* Context button for workspace files */}
                                        <button 
                                            className="icon-btn-context"
                                            onClick={handleComposerContextSelect}
                                            title="Add workspace files as context"
                                        >
                                            +
                                        </button>
                                        
                                        <textarea
                                            className="composer-textarea"
                                            placeholder="Describe your task... (Enter to start, Shift+Enter for new line)"
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && !e.shiftKey) {
                                                    e.preventDefault();
                                                    handleStartTask((e.target as HTMLTextAreaElement).value);
                                                }
                                            }}
                                        />
                                    </div>
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
                            rightPaneTab === 'context' ? (() => {
                                // Build array of available context items
                                const contextItems: { id: string; render: () => React.ReactNode }[] = [];
                                
                                if (questionnaireData) {
                                    contextItems.push({
                                        id: 'questionnaire',
                                        render: () => (
                                            <RefinementQuestionnaire
                                                taskId={questionnaireData.taskId}
                                                sessionId={questionnaireData.sessionId}
                                                questions={questionnaireData.questions}
                                                contextSummary={questionnaireData.contextSummary}
                                                onSubmit={handleQuestionnaireSubmit}
                                                onCancel={handleQuestionnaireCancel}
                                            />
                                        )
                                    });
                                }
                                
                                if (pendingApproval && pendingApproval.type === 'plan') {
                                    contextItems.push({
                                        id: 'plan',
                                        render: () => (
                                            <div className="review-pane">
                                                <div className="review-header">
                                                    <span className="review-icon">📋</span>
                                                    <h3>Review Implementation Plan</h3>
                                                </div>
                                                <div className="review-content markdown-body">
                                                    <ReactMarkdown>{pendingApproval.content}</ReactMarkdown>
                                                </div>
                                                <div className="review-comment-section">
                                                    <label className="comment-label">Add feedback or suggestions (optional):</label>
                                                    <textarea
                                                        className="review-textarea"
                                                        placeholder="e.g., 'Add error handling' or 'Include unit tests'..."
                                                        value={reviewComment}
                                                        onChange={(e) => setReviewComment(e.target.value)}
                                                    />
                                                </div>
                                                <div className="review-actions">
                                                    <button className="decline-btn" onClick={handleRejectReview}>
                                                        ✕ Cancel
                                                    </button>
                                                    <button className="approve-btn" onClick={handleApproveReview}>
                                                        ✓ Approve & Continue
                                                    </button>
                                                </div>
                                            </div>
                                        )
                                    });
                                }
                                
                                if (pendingApproval && pendingApproval.type === 'prd') {
                                    contextItems.push({
                                        id: 'prd',
                                        render: () => (
                                            <div className="review-pane prd-review">
                                                <div className="review-header">
                                                    <span className="review-icon">📝</span>
                                                    <h3>Review Product Requirements Document</h3>
                                                </div>
                                                <div className="review-content markdown-body">
                                                    <ReactMarkdown>{pendingApproval.content}</ReactMarkdown>
                                                </div>
                                                <div className="review-comment-section">
                                                    <label className="comment-label">Request changes or refinements (optional):</label>
                                                    <textarea
                                                        className="review-textarea"
                                                        placeholder="e.g., 'Add authentication requirements' or 'Include database schemas'..."
                                                        value={reviewComment}
                                                        onChange={(e) => setReviewComment(e.target.value)}
                                                    />
                                                </div>
                                                <div className="review-actions">
                                                    <button className="decline-btn" onClick={() => {
                                                        if (reviewComment.trim()) {
                                                            vscode.postMessage({
                                                                command: 'prdFeedback',
                                                                taskId: pendingApproval.taskId,
                                                                feedback: reviewComment
                                                            });
                                                        } else {
                                                            vscode.postMessage({
                                                                command: 'prdFeedback',
                                                                taskId: pendingApproval.taskId,
                                                                feedback: 'Please refine the PRD further with more details.'
                                                            });
                                                        }
                                                        setPendingApproval(null);
                                                        setReviewComment('');
                                                    }}>
                                                        ✎ Request Changes
                                                    </button>
                                                    <button className="approve-btn" onClick={() => {
                                                        vscode.postMessage({
                                                            command: 'prdApproved',
                                                            taskId: pendingApproval.taskId
                                                        });
                                                        setPendingApproval(null);
                                                        setReviewComment('');
                                                    }}>
                                                        ✓ Approve & Continue to Planning
                                                    </button>
                                                </div>
                                            </div>
                                        )
                                    });
                                }
                                
                                if (diffContent) {
                                    contextItems.push({
                                        id: 'diff',
                                        render: () => (
                                            <DiffViewer
                                                filePath={diffContent.path}
                                                beforeContent={diffContent.before}
                                                afterContent={diffContent.after}
                                                onClose={() => setDiffContent(null)}
                                            />
                                        )
                                    });
                                }
                                
                                // Add all preview files to context items
                                previewFiles.forEach((file, idx) => {
                                    contextItems.push({
                                        id: `preview-${idx}`,
                                        render: () => (
                                            <div className="file-preview">
                                                <div className="preview-header">
                                                    <span className="preview-filename">{file.path?.split(/[\\/]/).pop()}</span>
                                                    <button className="icon-btn-small" onClick={() => {
                                                        setPreviewFiles(prev => prev.filter(f => f.path !== file.path));
                                                    }}>×</button>
                                                </div>
                                                <div className="preview-body markdown-body">
                                                    {file.path?.endsWith('.md') ? (
                                                        <ReactMarkdown>{file.content}</ReactMarkdown>
                                                    ) : (
                                                        <pre>{file.content}</pre>
                                                    )}
                                                </div>
                                            </div>
                                        )
                                    });
                                });
                                
                                // Clamp index to valid range
                                const safeIndex = Math.max(0, Math.min(contextPaneIndex, contextItems.length - 1));
                                if (safeIndex !== contextPaneIndex && contextItems.length > 0) {
                                    // Reset index if it's out of bounds (item was removed)
                                    setTimeout(() => setContextPaneIndex(safeIndex), 0);
                                }
                                
                                // If no items, show empty state
                                if (contextItems.length === 0) {
                                    return (
                                        <div className="context-list">
                                            <div className="empty-state">
                                                <div>No artifacts open. Click OPEN on an artifact card to view.</div>
                                            </div>
                                        </div>
                                    );
                                }
                                
                                return (
                                    <div className="context-list">
                                        {/* Navigation bar when multiple items */}
                                        {contextItems.length > 1 && (
                                            <div className="context-nav-bar">
                                                <button 
                                                    className="context-nav-btn" 
                                                    onClick={() => setContextPaneIndex(prev => Math.max(0, prev - 1))}
                                                    disabled={safeIndex === 0}
                                                >
                                                    &lt;
                                                </button>
                                                <span className="context-nav-indicator">
                                                    {safeIndex + 1} / {contextItems.length}
                                                </span>
                                                <button 
                                                    className="context-nav-btn" 
                                                    onClick={() => setContextPaneIndex(prev => Math.min(contextItems.length - 1, prev + 1))}
                                                    disabled={safeIndex === contextItems.length - 1}
                                                >
                                                    &gt;
                                                </button>
                                            </div>
                                        )}
                                        {/* Render current item */}
                                        {contextItems[safeIndex].render()}
                                    </div>
                                );
                            })() : (
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
