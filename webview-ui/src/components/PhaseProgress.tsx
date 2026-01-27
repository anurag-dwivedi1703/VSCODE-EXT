/**
 * PhaseProgress - Visual component showing phase execution progress
 * 
 * Displays a timeline of phases with status indicators
 */

import * as React from 'react';
import './PhaseProgress.css';

export interface PhaseInfo {
    id: string;
    name: string;
    description: string;
    status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';
    tokenUsage?: number;
    estimatedTokens: number;
}

export interface PhaseProgressProps {
    phases: PhaseInfo[];
    currentPhaseIndex: number;
    totalTokensUsed: number;
    totalTokensEstimated: number;
    onPhaseClick?: (phaseId: string, index: number) => void;
}

export const PhaseProgress: React.FC<PhaseProgressProps> = ({
    phases,
    currentPhaseIndex,
    totalTokensUsed,
    totalTokensEstimated,
    onPhaseClick
}) => {
    const completedPhases = phases.filter(p => p.status === 'completed' || p.status === 'skipped').length;
    const progressPercent = phases.length > 0 ? Math.round((completedPhases / phases.length) * 100) : 0;

    const getStatusIcon = (status: PhaseInfo['status'], isCurrent: boolean) => {
        if (isCurrent && status === 'in-progress') return '🔄';
        switch (status) {
            case 'completed': return '✅';
            case 'failed': return '❌';
            case 'skipped': return '⏭️';
            case 'in-progress': return '🔄';
            default: return '⏳';
        }
    };

    const getStatusClass = (status: PhaseInfo['status'], isCurrent: boolean) => {
        if (isCurrent) return 'phase-current';
        switch (status) {
            case 'completed': return 'phase-completed';
            case 'failed': return 'phase-failed';
            case 'skipped': return 'phase-skipped';
            case 'in-progress': return 'phase-in-progress';
            default: return 'phase-pending';
        }
    };

    return (
        <div className="phase-progress-container">
            {/* Header */}
            <div className="phase-progress-header">
                <span className="phase-progress-title">📋 Phased Execution</span>
                <span className="phase-progress-summary">
                    Phase {currentPhaseIndex + 1} of {phases.length} ({progressPercent}% complete)
                </span>
            </div>

            {/* Progress Bar */}
            <div className="phase-progress-bar-container">
                <div 
                    className="phase-progress-bar-fill" 
                    style={{ width: `${progressPercent}%` }}
                />
            </div>

            {/* Phase Timeline */}
            <div className="phase-timeline">
                {phases.map((phase, index) => {
                    const isCurrent = index === currentPhaseIndex;
                    const statusClass = getStatusClass(phase.status, isCurrent);
                    const statusIcon = getStatusIcon(phase.status, isCurrent);

                    return (
                        <div 
                            key={phase.id}
                            className={`phase-item ${statusClass}`}
                            onClick={() => onPhaseClick?.(phase.id, index)}
                            title={phase.description}
                        >
                            {/* Connector Line */}
                            {index > 0 && (
                                <div className={`phase-connector ${
                                    phases[index - 1].status === 'completed' ? 'connector-complete' : ''
                                }`} />
                            )}

                            {/* Phase Circle */}
                            <div className={`phase-circle ${statusClass}`}>
                                <span className="phase-icon">{statusIcon}</span>
                            </div>

                            {/* Phase Info */}
                            <div className="phase-info">
                                <div className="phase-name">
                                    {index + 1}. {phase.name}
                                </div>
                                {phase.tokenUsage !== undefined && (
                                    <div className="phase-tokens">
                                        {phase.tokenUsage.toLocaleString()} / {phase.estimatedTokens.toLocaleString()} tokens
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Total Tokens */}
            <div className="phase-total-tokens">
                Total: {totalTokensUsed.toLocaleString()} / {totalTokensEstimated.toLocaleString()} tokens
            </div>
        </div>
    );
};

export default PhaseProgress;
