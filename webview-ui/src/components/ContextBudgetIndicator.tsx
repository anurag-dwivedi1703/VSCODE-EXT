/**
 * ContextBudgetIndicator - Visual component showing token budget status
 * 
 * Displays a progress bar with color-coded status
 */

import * as React from 'react';
import './ContextBudgetIndicator.css';

export type BudgetStatus = 'healthy' | 'warning' | 'critical' | 'exhausted';

export interface ContextBudgetProps {
    used: number;
    total: number;
    status: BudgetStatus;
    /** @deprecated Use phaseName instead */
    phaseId?: string;
    phaseName?: string;
    showDetails?: boolean;
    compact?: boolean;
}

export const ContextBudgetIndicator: React.FC<ContextBudgetProps> = ({
    used,
    total,
    status,
    phaseId: _phaseId, // Deprecated, use phaseName
    phaseName,
    showDetails = true,
    compact = false
}) => {
    const percentUsed = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    const remaining = Math.max(0, total - used);

    const getStatusColor = () => {
        switch (status) {
            case 'healthy': return 'var(--vscode-testing-iconPassed, #388a34)';
            case 'warning': return 'var(--vscode-editorWarning-foreground, #cca700)';
            case 'critical': return 'var(--vscode-editorError-foreground, #f14c4c)';
            case 'exhausted': return 'var(--vscode-testing-iconFailed, #f14c4c)';
            default: return 'var(--vscode-progressBar-background, #0e639c)';
        }
    };

    const getStatusIcon = () => {
        switch (status) {
            case 'healthy': return '✅';
            case 'warning': return '⚠️';
            case 'critical': return '🔴';
            case 'exhausted': return '🛑';
            default: return '📊';
        }
    };

    const getStatusLabel = () => {
        switch (status) {
            case 'healthy': return 'Healthy';
            case 'warning': return 'Warning';
            case 'critical': return 'Critical';
            case 'exhausted': return 'Exhausted';
            default: return 'Unknown';
        }
    };

    const getRecommendation = () => {
        switch (status) {
            case 'healthy': return 'Continue normal operation';
            case 'warning': return 'Consider wrapping up current task';
            case 'critical': return 'Save progress immediately!';
            case 'exhausted': return 'Must transition to next phase';
            default: return '';
        }
    };

    if (compact) {
        return (
            <div className="budget-indicator-compact" title={`${percentUsed}% used - ${getStatusLabel()}`}>
                <div className="budget-bar-compact">
                    <div 
                        className="budget-bar-fill-compact"
                        style={{ 
                            width: `${percentUsed}%`,
                            backgroundColor: getStatusColor()
                        }}
                    />
                </div>
                <span className="budget-percent-compact">{percentUsed}%</span>
            </div>
        );
    }

    return (
        <div className={`budget-indicator-container budget-status-${status}`}>
            {/* Header */}
            <div className="budget-header">
                <div className="budget-title">
                    <span className="budget-icon">{getStatusIcon()}</span>
                    <span>Token Budget</span>
                    {phaseName && <span className="budget-phase">({phaseName})</span>}
                </div>
                <div className={`budget-status-badge status-${status}`}>
                    {getStatusLabel()}
                </div>
            </div>

            {/* Progress Bar */}
            <div className="budget-bar-container">
                <div 
                    className="budget-bar-fill"
                    style={{ 
                        width: `${percentUsed}%`,
                        backgroundColor: getStatusColor()
                    }}
                />
                {/* Threshold Markers */}
                <div className="budget-threshold warning-threshold" style={{ left: '70%' }} />
                <div className="budget-threshold critical-threshold" style={{ left: '90%' }} />
            </div>

            {/* Stats */}
            <div className="budget-stats">
                <div className="budget-stat">
                    <span className="stat-label">Used</span>
                    <span className="stat-value">{used.toLocaleString()}</span>
                </div>
                <div className="budget-stat">
                    <span className="stat-label">Remaining</span>
                    <span className="stat-value">{remaining.toLocaleString()}</span>
                </div>
                <div className="budget-stat">
                    <span className="stat-label">Total</span>
                    <span className="stat-value">{total.toLocaleString()}</span>
                </div>
                <div className="budget-stat budget-percent">
                    <span className="stat-value-large">{percentUsed}%</span>
                </div>
            </div>

            {/* Recommendation */}
            {showDetails && status !== 'healthy' && (
                <div className={`budget-recommendation recommendation-${status}`}>
                    {getRecommendation()}
                </div>
            )}
        </div>
    );
};

export default ContextBudgetIndicator;
