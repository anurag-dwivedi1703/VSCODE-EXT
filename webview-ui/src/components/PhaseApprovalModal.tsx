/**
 * PhaseApprovalModal - Modal for approving phase completion
 * 
 * Displays phase results and allows user to approve, reject, or provide feedback
 */

import * as React from 'react';
import { useState } from 'react';
import './PhaseApprovalModal.css';

export interface PhaseApprovalData {
    phaseId: string;
    phaseName: string;
    phaseIndex: number;
    totalPhases: number;
    summary: string;
    filesCreated: string[];
    filesModified: string[];
    verificationResults: string[];
    tokenUsage: number;
    estimatedTokens: number;
}

export interface PhaseApprovalModalProps {
    data: PhaseApprovalData;
    isOpen: boolean;
    onApprove: (feedback?: string) => void;
    onReject: (reason?: string) => void;
    onSkip?: () => void;
}

export const PhaseApprovalModal: React.FC<PhaseApprovalModalProps> = ({
    data,
    isOpen,
    onApprove,
    onReject,
    onSkip
}) => {
    const [feedback, setFeedback] = useState('');
    const [showFeedback, setShowFeedback] = useState(false);

    if (!isOpen) return null;

    const handleApprove = () => {
        onApprove(feedback.trim() || undefined);
        setFeedback('');
        setShowFeedback(false);
    };

    const handleReject = () => {
        onReject(feedback.trim() || undefined);
        setFeedback('');
        setShowFeedback(false);
    };

    const allVerificationsPassed = data.verificationResults.every(
        r => !r.toLowerCase().includes('fail')
    );

    const isLastPhase = data.phaseIndex === data.totalPhases - 1;

    return (
        <div className="phase-approval-overlay">
            <div className="phase-approval-modal">
                {/* Header */}
                <div className="approval-header">
                    <div className="approval-title">
                        <span className="approval-icon">✅</span>
                        Phase {data.phaseIndex + 1} Complete
                    </div>
                    <div className="approval-subtitle">
                        {data.phaseName}
                    </div>
                </div>

                {/* Progress Indicator */}
                <div className="approval-progress">
                    <div className="progress-dots">
                        {Array.from({ length: data.totalPhases }).map((_, i) => (
                            <div 
                                key={i} 
                                className={`progress-dot ${
                                    i < data.phaseIndex ? 'dot-complete' :
                                    i === data.phaseIndex ? 'dot-current' : 'dot-pending'
                                }`}
                            />
                        ))}
                    </div>
                    <div className="progress-label">
                        {data.phaseIndex + 1} of {data.totalPhases} phases
                        {isLastPhase && ' (Final Phase)'}
                    </div>
                </div>

                {/* Summary */}
                <div className="approval-section">
                    <div className="section-title">📝 Summary</div>
                    <div className="section-content summary-content">
                        {data.summary}
                    </div>
                </div>

                {/* Files */}
                {(data.filesCreated.length > 0 || data.filesModified.length > 0) && (
                    <div className="approval-section">
                        <div className="section-title">📁 Files Changed</div>
                        <div className="section-content files-content">
                            {data.filesCreated.length > 0 && (
                                <div className="files-group">
                                    <span className="files-label">Created:</span>
                                    {data.filesCreated.map((f, i) => (
                                        <span key={i} className="file-badge file-created">{f}</span>
                                    ))}
                                </div>
                            )}
                            {data.filesModified.length > 0 && (
                                <div className="files-group">
                                    <span className="files-label">Modified:</span>
                                    {data.filesModified.map((f, i) => (
                                        <span key={i} className="file-badge file-modified">{f}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Verification */}
                {data.verificationResults.length > 0 && (
                    <div className="approval-section">
                        <div className="section-title">
                            {allVerificationsPassed ? '✅' : '⚠️'} Verification
                        </div>
                        <div className="section-content verification-content">
                            {data.verificationResults.map((result, i) => (
                                <div 
                                    key={i} 
                                    className={`verification-item ${
                                        result.toLowerCase().includes('fail') ? 'verification-fail' : 'verification-pass'
                                    }`}
                                >
                                    {result}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Token Usage */}
                <div className="approval-section token-section">
                    <div className="section-title">📊 Token Usage</div>
                    <div className="token-stats">
                        <div className="token-stat">
                            <span className="token-value">{data.tokenUsage.toLocaleString()}</span>
                            <span className="token-label">Used</span>
                        </div>
                        <div className="token-stat">
                            <span className="token-value">{data.estimatedTokens.toLocaleString()}</span>
                            <span className="token-label">Estimated</span>
                        </div>
                        <div className="token-stat">
                            <span className="token-value">
                                {Math.round((data.tokenUsage / data.estimatedTokens) * 100)}%
                            </span>
                            <span className="token-label">Efficiency</span>
                        </div>
                    </div>
                </div>

                {/* Feedback Input */}
                {showFeedback && (
                    <div className="approval-section">
                        <div className="section-title">💬 Feedback (Optional)</div>
                        <textarea
                            className="feedback-input"
                            placeholder="Add feedback or suggestions for the next phase..."
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value)}
                            rows={3}
                        />
                    </div>
                )}

                {/* Actions */}
                <div className="approval-actions">
                    {!showFeedback && (
                        <button 
                            className="action-btn btn-feedback"
                            onClick={() => setShowFeedback(true)}
                        >
                            💬 Add Feedback
                        </button>
                    )}
                    
                    {onSkip && !isLastPhase && (
                        <button 
                            className="action-btn btn-skip"
                            onClick={onSkip}
                        >
                            ⏭️ Skip Next Phase
                        </button>
                    )}

                    <button 
                        className="action-btn btn-reject"
                        onClick={handleReject}
                    >
                        ❌ Stop Mission
                    </button>

                    <button 
                        className="action-btn btn-approve"
                        onClick={handleApprove}
                    >
                        {isLastPhase ? '🎉 Complete Mission' : '✅ Approve & Continue'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PhaseApprovalModal;
