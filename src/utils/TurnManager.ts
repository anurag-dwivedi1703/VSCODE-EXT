/**
 * TurnManager.ts
 * 
 * Manages conversation turns with phase-aware summarization.
 * Uses implementation_plan.md phases as natural summarization boundaries.
 */

import * as fs from 'fs';
import * as path from 'path';

// Constants
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_RECENT_TURNS = 10;
const FALLBACK_SUMMARIZATION_THRESHOLD = 0.75;

// Interfaces
export interface Turn {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    timestamp: number;
    phaseId?: number;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
}

export interface TurnManagerConfig {
    maxRecentTurns: number;
    maxTokens: number;
    implementationPlanPath?: string;
    workspaceRoot?: string;
}

export interface TurnManagerState {
    currentPhase: number;
    totalPhases: number;
    turnsInCurrentPhase: number;
    totalTurns: number;
    estimatedTokens: number;
    filesModified: string[];
    filesRead: string[];
}

export interface PhaseProgress {
    phaseNumber: number;
    phaseName: string;
    tasksTotal: number;
    tasksCompleted: number;
}

export interface PhaseInfo {
    phaseNumber: number;
    phaseName: string;
    tasks: { description: string; completed: boolean }[];
    summary?: string;
}

export interface PhaseCompletionResult {
    completed: boolean;
    phaseNumber: number;
    reason?: string;
}

export interface SummarizedToolResult {
    toolName: string;
    summary: string;
    originalTokens: number;
    summarizedTokens: number;
}

/**
 * Manages conversation turns with intelligent phase-aware summarization.
 */
export class TurnManager {
    private turns: Turn[] = [];
    private maxRecentTurns: number;
    private maxTokens: number;
    private implementationPlanPath?: string;
    private workspaceRoot: string;
    
    private filesModified: Set<string> = new Set();
    private filesRead: Set<string> = new Set();
    private keyDecisions: string[] = [];
    
    private phases: PhaseInfo[] = [];
    private currentPhaseNumber: number = 1;
    private phaseSummaries: Map<number, string> = new Map();
    private estimatedTokensUsed: number = 0;

    constructor(config: TurnManagerConfig) {
        this.maxRecentTurns = config.maxRecentTurns ?? DEFAULT_MAX_RECENT_TURNS;
        this.maxTokens = config.maxTokens;
        this.implementationPlanPath = config.implementationPlanPath;
        this.workspaceRoot = config.workspaceRoot ?? '';
        
        if (this.implementationPlanPath) {
            this.loadImplementationPlan(this.implementationPlanPath);
        }
    }

    /**
     * Update the max token budget (e.g., after AI client reports actual limits).
     */
    public updateMaxTokens(maxTokens: number): void {
        this.maxTokens = maxTokens;
    }

    // Phase tracking methods - see TurnManager_phases.ts
    public loadImplementationPlan(planPath: string): void {
        try {
            const fullPath = path.isAbsolute(planPath) ? planPath : path.join(this.workspaceRoot, planPath);
            if (!fs.existsSync(fullPath)) return;
            const content = fs.readFileSync(fullPath, 'utf-8');
            this.phases = this.parseImplementationPlan(content);
            this.currentPhaseNumber = this.determineCurrentPhase();
        } catch (error) {
            console.error(`[TurnManager] Error loading plan:`, error);
        }
    }

    private parseImplementationPlan(content: string): PhaseInfo[] {
        const phases: PhaseInfo[] = [];
        const lines = content.split('\n');
        let currentPhase: PhaseInfo | null = null;
        const phasePattern = /^#{1,3}\s*(?:Phase\s+)?(\d+)[:\s.-]+(.+?)(?:\s*\(.*\))?\s*$/i;
        const taskPattern = /^\s*-\s*\[([ xX])\]\s*(.+)$/;
        
        for (const line of lines) {
            const phaseMatch = line.match(phasePattern);
            if (phaseMatch) {
                if (currentPhase) phases.push(currentPhase);
                currentPhase = { phaseNumber: parseInt(phaseMatch[1], 10), phaseName: phaseMatch[2].trim(), tasks: [] };
                continue;
            }
            const taskMatch = line.match(taskPattern);
            if (taskMatch && currentPhase) {
                currentPhase.tasks.push({ description: taskMatch[2].trim(), completed: taskMatch[1].toLowerCase() === 'x' });
            }
        }
        if (currentPhase) phases.push(currentPhase);
        return phases;
    }

    public getCurrentPhase(): PhaseInfo | undefined {
        return this.phases.find(p => p.tasks.some(t => !t.completed)) ?? this.phases[this.phases.length - 1];
    }

    private determineCurrentPhase(): number {
        return this.getCurrentPhase()?.phaseNumber ?? 1;
    }

    public refreshPhaseProgress(): { phaseJustCompleted: boolean; completedPhase?: number } {
        const prev = this.currentPhaseNumber;
        if (this.implementationPlanPath) this.loadImplementationPlan(this.implementationPlanPath);
        if (this.currentPhaseNumber > prev) return { phaseJustCompleted: true, completedPhase: prev };
        return { phaseJustCompleted: false };
    }

    public detectPhaseCompletion(agentResponse: string): PhaseCompletionResult {
        const patterns = [/phase\s+(\d+)\s+(?:is\s+)?complete/i, /completed?\s+phase\s+(\d+)/i, /moving\s+to\s+phase\s+(\d+)/i];
        for (const pattern of patterns) {
            const match = agentResponse.match(pattern);
            if (match) return { completed: true, phaseNumber: parseInt(match[1], 10), reason: `Signal: "${match[0]}"` };
        }
        const curr = this.getCurrentPhase();
        if (curr?.tasks.length && curr.tasks.every(t => t.completed)) {
            return { completed: true, phaseNumber: curr.phaseNumber, reason: 'All tasks complete' };
        }
        return { completed: false, phaseNumber: this.currentPhaseNumber };
    }

    public onPhaseComplete(phaseNumber: number): void {
        const summary = this.summarizePhase(phaseNumber);
        this.phaseSummaries.set(phaseNumber, summary);
        this.turns = this.turns.filter(t => t.phaseId !== phaseNumber);
        this.currentPhaseNumber = phaseNumber + 1;
    }

    public summarizePhase(phaseNumber: number): string {
        const phase = this.phases.find(p => p.phaseNumber === phaseNumber);
        const phaseTurns = this.turns.filter(t => t.phaseId === phaseNumber);
        const files = this.extractFilesFromTurns(phaseTurns);
        const decisions = this.extractDecisionsFromTurns(phaseTurns);
        return this.generatePhaseSummary(phase, files, decisions);
    }

    private extractFilesFromTurns(turns: Turn[]): { modified: string[]; read: string[] } {
        const modified = new Set<string>(), read = new Set<string>();
        for (const t of turns) {
            if (t.toolName === 'read_file' && t.toolArgs?.path) read.add(String(t.toolArgs.path));
            if ((t.toolName === 'write_file' || t.toolName === 'apply_diff') && t.toolArgs?.path) modified.add(String(t.toolArgs.path));
        }
        return { modified: Array.from(modified), read: Array.from(read) };
    }

    private extractDecisionsFromTurns(turns: Turn[]): string[] {
        const decisions: string[] = [];
        const patterns = [/decided\s+to\s+(.+?)\./i, /key\s+decision:\s*(.+)/i];
        for (const t of turns) {
            if (t.role === 'assistant') {
                for (const p of patterns) { const m = t.content.match(p); if (m) decisions.push(m[1].trim()); }
            }
        }
        return decisions.slice(0, 5);
    }

    private generatePhaseSummary(phase: PhaseInfo | undefined, files: { modified: string[]; read: string[] }, decisions: string[]): string {
        const num = phase?.phaseNumber ?? this.currentPhaseNumber;
        const name = phase?.phaseName ?? 'Unknown';
        const tasks = phase?.tasks.filter(t => t.completed) ?? [];
        const next = this.phases.find(p => p.phaseNumber === num + 1);
        let s = `[PHASE ${num} COMPLETE: ${name}]\n\n`;
        if (tasks.length) { s += `Tasks Completed:\n${tasks.slice(0,5).map(t => `- ${t.description}`).join('\n')}\n`; if (tasks.length > 5) s += `- ...and ${tasks.length-5} more\n`; s += '\n'; }
        if (files.modified.length) { s += `Files Modified:\n${files.modified.slice(0,10).map(f => `- ${f}`).join('\n')}\n\n`; }
        if (decisions.length) { s += `Key Decisions:\n${decisions.map(d => `- ${d}`).join('\n')}\n\n`; }
        s += next ? `Ready for Phase ${next.phaseNumber}: ${next.phaseName}` : 'All phases complete.';
        return s;
    }

    public shouldTriggerFallbackSummarization(): boolean {
        return this.estimatedTokensUsed / this.maxTokens > FALLBACK_SUMMARIZATION_THRESHOLD;
    }

    public triggerFallbackSummarization(): void {
        console.warn('[TurnManager] Summarizing due to token pressure');
        const keep = this.turns.slice(-this.maxRecentTurns);
        const old = this.turns.slice(0, -this.maxRecentTurns);
        if (!old.length) return;
        const files = this.extractFilesFromTurns(old);
        const summary = `[PARTIAL CONTEXT - ${old.length} turns summarized]\nFiles: ${[...files.modified,...files.read].slice(0,5).join(', ')}`;
        this.phaseSummaries.set(-this.currentPhaseNumber, summary);
        this.turns = keep;
        this.recalculateTokens();
    }

    public async markTaskComplete(phaseNumber: number, taskIndex: number): Promise<boolean> {
        if (!this.implementationPlanPath) return false;
        try {
            const fullPath = path.isAbsolute(this.implementationPlanPath) ? this.implementationPlanPath : path.join(this.workspaceRoot, this.implementationPlanPath);
            let content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');
            let currPhase = 0, taskCount = 0, targetLine = -1;
            for (let i = 0; i < lines.length; i++) {
                const pm = lines[i].match(/^#{1,3}\s*(?:Phase\s+)?(\d+)/i);
                if (pm) { currPhase = parseInt(pm[1], 10); taskCount = 0; continue; }
                if (currPhase === phaseNumber && /^\s*-\s*\[ \]/.test(lines[i])) {
                    if (taskCount === taskIndex) { targetLine = i; break; }
                    taskCount++;
                }
            }
            if (targetLine >= 0) {
                lines[targetLine] = lines[targetLine].replace(/\[ \]/, '[x]');
                fs.writeFileSync(fullPath, lines.join('\n'), 'utf-8');
                this.loadImplementationPlan(this.implementationPlanPath);
                return true;
            }
            return false;
        } catch { return false; }
    }

    public getPhaseProgress(): { current: number; total: number; currentPhaseTasks: string } {
        const curr = this.getCurrentPhase();
        const done = curr?.tasks.filter(t => t.completed).length ?? 0;
        const total = curr?.tasks.length ?? 0;
        return { current: this.currentPhaseNumber, total: this.phases.length, currentPhaseTasks: `${done}/${total}` };
    }

    public addTurn(role: 'user' | 'assistant' | 'tool', content: string): void {
        this.turns.push({ role, content, timestamp: Date.now(), phaseId: this.currentPhaseNumber });
        this.estimatedTokensUsed += this.estimateTokens(content);
        if (role === 'assistant') {
            this.extractMetadata(content);
            const comp = this.detectPhaseCompletion(content);
            if (comp.completed) this.onPhaseComplete(comp.phaseNumber);
        }
        if (this.shouldTriggerFallbackSummarization()) this.triggerFallbackSummarization();
    }

    public addToolResult(toolName: string, args: Record<string, unknown>, result: string): SummarizedToolResult {
        const fp = args.path as string | undefined;
        if (fp) {
            if (toolName === 'read_file') this.filesRead.add(fp);
            else if (toolName === 'write_file' || toolName === 'apply_diff') this.filesModified.add(fp);
        }
        // Track grep_search queries for context
        if (toolName === 'grep_search' && args.query) {
            // No file tracking needed, just summarize
        }
        const summarized = this.summarizeToolResult(toolName, args, result);
        this.turns.push({ role: 'tool', content: summarized.summary, timestamp: Date.now(), phaseId: this.currentPhaseNumber, toolName, toolArgs: args });
        this.estimatedTokensUsed += summarized.summarizedTokens;
        return summarized;
    }

    private extractMetadata(content: string): void {
        for (const p of [/decided\s+to\s+(.+?)\./i, /key\s+decision:\s*(.+)/i]) {
            const m = content.match(p); if (m) this.keyDecisions.push(m[1].trim());
        }
        if (this.keyDecisions.length > 20) this.keyDecisions = this.keyDecisions.slice(-20);
    }

    public summarizeToolResult(toolName: string, args: Record<string, unknown>, result: string): SummarizedToolResult {
        const origTokens = this.estimateTokens(result);
        let summary: string;
        switch (toolName) {
            case 'read_file':
                if (args.startLine || args.endLine) {
                    summary = `[Read ${args.path} lines ${args.startLine ?? 1}-${args.endLine ?? 'end'}] ${result.length} chars`;
                } else {
                    summary = this.summarizeReadFile(args, result);
                }
                break;
            case 'run_command': summary = this.summarizeRunCommand(args, result); break;
            case 'write_file': summary = `[Wrote ${args.path}] - Created/updated.`; break;
            case 'apply_diff': summary = `[Applied diff to ${args.path}] - Changes applied.`; break;
            case 'list_files': { const items = result.split('\n').filter(l => l.trim()).length; const dirs = (result.match(/DIR\t/g)||[]).length; summary = `[Listed ${args.path}] - ${items-dirs} files, ${dirs} dirs.`; break; }
            case 'grep_search': { const matchCount = result.split('\n').filter(l => l.trim()).length; summary = `[Searched for "${args.query}"] ${matchCount} matches found`; break; }
            case 'file_search': { const fileCount = result.split('\n').filter(l => l.trim()).length; summary = `[File search "${args.pattern}"] ${fileCount} files found`; break; }
            default: summary = result.length > 500 ? result.substring(0, 500) + '...' : result;
        }
        return { toolName, summary, originalTokens: origTokens, summarizedTokens: this.estimateTokens(summary) };
    }

    private summarizeReadFile(args: Record<string, unknown>, result: string): string {
        const fp = args.path as string;
        const lines = result.split('\n').length;
        const ext = path.extname(fp);
        let type = 'file';
        if (['.ts','.tsx','.js','.jsx'].includes(ext)) type = 'TypeScript/JS';
        else if (ext === '.py') type = 'Python';
        else if (ext === '.json') type = 'JSON';
        else if (ext === '.md') type = 'Markdown';
        return `[Read ${fp}] - ${lines} lines (${type}). Re-read if needed.`;
    }

    private summarizeRunCommand(args: Record<string, unknown>, result: string): string {
        if (result.includes('error TS') || result.includes('error:')) return this.summarizeCompileErrors(result);
        if (result.includes('passing') || result.includes('failing') || result.includes('PASS') || result.includes('FAIL')) {
            const pass = result.match(/(\d+)\s+passing/)?.[1] ?? '0';
            const fail = result.match(/(\d+)\s+failing/)?.[1] ?? '0';
            return `[TEST] ${pass} passing, ${fail} failing`;
        }
        if (result.includes('npm') || result.includes('added')) {
            const added = result.match(/added (\d+) packages?/)?.[1];
            return added ? `[NPM] Added ${added} packages.` : '[NPM] Complete.';
        }
        return result.length > 500 ? result.substring(0, 500) + '...' : result;
    }

    public summarizeCompileErrors(output: string): string {
        const errPattern = /error (TS\d+):/g;
        const counts = new Map<string, number>();
        const fileErrs = new Map<string, number>();
        let total = 0, match;
        while ((match = errPattern.exec(output)) !== null) {
            total++;
            counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
        }
        for (const line of output.split('\n')) {
            const fm = line.match(/^(.+?)\(\d+,\d+\):.*error TS/);
            if (fm) fileErrs.set(fm[1], (fileErrs.get(fm[1]) ?? 0) + 1);
        }
        if (total === 0) return output.length > 500 ? output.substring(0, 500) + '...' : output;
        const descs: Record<string, string> = { TS2345: 'Type mismatch', TS2339: 'Property missing', TS2307: 'Import error', TS2304: 'Name not found', TS2322: 'Type not assignable', TS2532: 'Possibly undefined', TS7006: 'Implicit any' };
        let s = `[COMPILE ERRORS: ${total}]\n`;
        const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
        s += 'By Code:\n' + top.map(([c, n]) => `- ${c}: ${n}x - ${descs[c] ?? 'Error'}`).join('\n') + '\n';
        const topFiles = Array.from(fileErrs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
        if (topFiles.length) s += 'Files:\n' + topFiles.map(([f, n]) => `- ${f}: ${n}`).join('\n') + '\n';
        if (top.length) s += `Fix ${top[0][0]} first.`;
        return s;
    }

    public getContextForModel(): string {
        const parts = [this.getPhaseProgressContext(), this.getCompletedPhaseSummaries(), this.getFileTrackingContext()];
        const currTurns = this.getCurrentPhaseTurns();
        if (currTurns.length) parts.push('[CURRENT CONVERSATION]\n' + currTurns.map(t => `${t.role}: ${t.content}`).join('\n\n'));
        return parts.filter(p => p).join('\n\n---\n\n');
    }

    private getPhaseProgressContext(): string {
        const prog = this.getPhaseProgress();
        const curr = this.getCurrentPhase();
        const totalTasks = this.phases.reduce((s, p) => s + p.tasks.length, 0);
        const doneTasks = this.phases.reduce((s, p) => s + p.tasks.filter(t => t.completed).length, 0);
        const pct = totalTasks ? Math.round(doneTasks / totalTasks * 100) : 0;
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        return `[MISSION PROGRESS]\nCurrent Phase: ${prog.current} of ${prog.total}${curr ? ` - "${curr.phaseName}"` : ''}\nPhase ${prog.current}: ${prog.currentPhaseTasks} tasks\n\nOverall: ${bar} ${pct}%\n\n📋 Mark tasks [x] when complete.`;
    }

    private getCompletedPhaseSummaries(): string {
        if (!this.phaseSummaries.size) return '';
        const sorted = Array.from(this.phaseSummaries.keys()).sort((a, b) => Math.abs(a) - Math.abs(b));
        return '[COMPLETED PHASES]\n\n' + sorted.map(k => this.phaseSummaries.get(k)).filter(Boolean).join('\n\n');
    }

    private getCurrentPhaseTurns(): Turn[] {
        const t = this.turns.filter(t => t.phaseId === this.currentPhaseNumber);
        return t.length > this.maxRecentTurns ? t.slice(-this.maxRecentTurns) : t;
    }

    private getFileTrackingContext(): string {
        const mod = Array.from(this.filesModified), read = Array.from(this.filesRead);
        if (!mod.length && !read.length) return '';
        let s = '[FILE TRACKING]\n';
        if (mod.length) s += `\nModified (${mod.length}):\n${mod.slice(0,15).map(f => `- ${f}`).join('\n')}\n`;
        if (read.length) s += `\nRead (${read.length}):\n${read.slice(0,10).map(f => `- ${f}`).join('\n')}\n`;
        return s + '\n💡 Re-read files if content needed.';
    }

    public getTokenEstimate(): { used: number; available: number; percent: number } {
        return { used: this.estimatedTokensUsed, available: this.maxTokens - this.estimatedTokensUsed, percent: Math.round(this.estimatedTokensUsed / this.maxTokens * 100) };
    }

    private estimateTokens(text: string): number { return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0; }

    private recalculateTokens(): void {
        this.estimatedTokensUsed = this.turns.reduce((s, t) => s + this.estimateTokens(t.content), 0);
        for (const v of this.phaseSummaries.values()) this.estimatedTokensUsed += this.estimateTokens(v);
    }

    public getState(): TurnManagerState {
        return {
            currentPhase: this.currentPhaseNumber,
            totalPhases: this.phases.length,
            turnsInCurrentPhase: this.turns.filter(t => t.phaseId === this.currentPhaseNumber).length,
            totalTurns: this.turns.length,
            estimatedTokens: this.estimatedTokensUsed,
            filesModified: Array.from(this.filesModified),
            filesRead: Array.from(this.filesRead)
        };
    }

    public reset(): void {
        this.turns = [];
        this.filesModified.clear();
        this.filesRead.clear();
        this.keyDecisions = [];
        this.phases = [];
        this.currentPhaseNumber = 1;
        this.phaseSummaries.clear();
        this.estimatedTokensUsed = 0;
    }
}
