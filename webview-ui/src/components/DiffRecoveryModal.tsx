/**
 * DiffRecoveryModal - Interactive UI for diff recovery suggestions
 * 
 * Shows users potential matches when a SEARCH block fails to match,
 * allowing them to approve or reject suggested recoveries.
 */

import React, { useState } from 'react';
import './DiffRecoveryModal.css';

export interface RecoverySuggestion {
    matchedText: string;
    similarity: number;
    startLine: number;
    matchType: 'exact-adjusted' | 'whitespace-only' | 'near-match' | 'partial';
    differences: string[];
    autoRecoveryRecommended: boolean;
}

export interface DiffRecoveryData {
    searchContent: string;
    filePath: string;
    failureReason: string;
    suggestions: RecoverySuggestion[];
    blockIndex: number;
}

interface Props {
    data: DiffRecoveryData;
    onApprove: (suggestionIndex: number) => void;
    onReject: () => void;
    onSkip: () => void;
}

export const DiffRecoveryModal: React.FC<Props> = ({
    data,
    onApprove,
    onReject,
    onSkip
}) => {
    const [selectedIndex, setSelectedIndex] = useState<number>(0);
    const [showFullSearch, setShowFullSearch] = useState(false);
    const [showFullMatch, setShowFullMatch] = useState(false);

    const fileName = data.filePath.split(/[/\\]/).pop() || data.filePath;
    const bestSuggestion = data.suggestions[0];

    const getMatchTypeLabel = (type: string): string => {
        switch (type) {
            case 'whitespace-only': return 'Whitespace Only';
            case 'exact-adjusted': return 'Exact (Adjusted)';
            case 'near-match': return 'Near Match';
            case 'partial': return 'Partial Match';
            default: return type;
        }
    };

    const getMatchTypeClass = (type: string): string => {
        switch (type) {
            case 'whitespace-only': return 'match-type-whitespace';
            case 'exact-adjusted': return 'match-type-exact';
            case 'near-match': return 'match-type-near';
            case 'partial': return 'match-type-partial';
            default: return '';
        }
    };

    const truncateText = (text: string, maxLines: number = 5): string => {
        const lines = text.split('\n');
        if (lines.length <= maxLines) return text;
        return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`;
    };

    if (data.suggestions.length === 0) {
        return (
            <div className="diff-recovery-modal">
                <div className="modal-header">
                    <h3>SEARCH Block Not Found</h3>
                    <span className="file-name">{fileName}</span>
                </div>
                
                <div className="modal-body">
                    <div className="failure-reason">
                        <span className="icon">⚠️</span>
                        <span>{data.failureReason}</span>
                    </div>

                    <div className="search-content">
                        <div className="section-header">
                            <span>Search Content</span>
                            <button 
                                className="toggle-btn"
                                onClick={() => setShowFullSearch(!showFullSearch)}
                            >
                                {showFullSearch ? 'Collapse' : 'Expand'}
                            </button>
                        </div>
                        <pre className="code-block">
                            {showFullSearch ? data.searchContent : truncateText(data.searchContent)}
                        </pre>
                    </div>

                    <p className="no-suggestions">
                        No similar content found in the file. The code may have been significantly 
                        modified or removed.
                    </p>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={onSkip}>
                        Skip This Block
                    </button>
                    <button className="btn btn-danger" onClick={onReject}>
                        Abort All Changes
                    </button>
                </div>
            </div>
        );
    }

    const selectedSuggestion = data.suggestions[selectedIndex];

    return (
        <div className="diff-recovery-modal">
            <div className="modal-header">
                <h3>SEARCH Block Mismatch</h3>
                <span className="file-name">{fileName}</span>
            </div>

            <div className="modal-body">
                <div className="failure-reason">
                    <span className="icon">⚠️</span>
                    <span>{data.failureReason}</span>
                </div>

                {/* Search Content */}
                <div className="search-content">
                    <div className="section-header">
                        <span>Expected (SEARCH)</span>
                        <button 
                            className="toggle-btn"
                            onClick={() => setShowFullSearch(!showFullSearch)}
                        >
                            {showFullSearch ? 'Collapse' : 'Expand'}
                        </button>
                    </div>
                    <pre className="code-block search">
                        {showFullSearch ? data.searchContent : truncateText(data.searchContent)}
                    </pre>
                </div>

                {/* Suggestions List */}
                <div className="suggestions-section">
                    <div className="section-header">
                        <span>Found {data.suggestions.length} Potential Match{data.suggestions.length > 1 ? 'es' : ''}</span>
                    </div>

                    <div className="suggestions-list">
                        {data.suggestions.map((suggestion, index) => (
                            <div 
                                key={index}
                                className={`suggestion-item ${index === selectedIndex ? 'selected' : ''}`}
                                onClick={() => setSelectedIndex(index)}
                            >
                                <div className="suggestion-header">
                                    <span className={`match-type ${getMatchTypeClass(suggestion.matchType)}`}>
                                        {getMatchTypeLabel(suggestion.matchType)}
                                    </span>
                                    <span className="similarity">
                                        {Math.round(suggestion.similarity * 100)}% match
                                    </span>
                                    <span className="line-number">
                                        Line {suggestion.startLine}
                                    </span>
                                </div>
                                {suggestion.autoRecoveryRecommended && (
                                    <span className="recommended-badge">✓ Recommended</span>
                                )}
                                {suggestion.differences.length > 0 && (
                                    <div className="differences">
                                        {suggestion.differences.map((diff, i) => (
                                            <span key={i} className="diff-tag">{diff}</span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Selected Match Preview */}
                <div className="match-preview">
                    <div className="section-header">
                        <span>Found in File (Line {selectedSuggestion.startLine})</span>
                        <button 
                            className="toggle-btn"
                            onClick={() => setShowFullMatch(!showFullMatch)}
                        >
                            {showFullMatch ? 'Collapse' : 'Expand'}
                        </button>
                    </div>
                    <pre className="code-block match">
                        {showFullMatch ? selectedSuggestion.matchedText : truncateText(selectedSuggestion.matchedText)}
                    </pre>
                </div>
            </div>

            <div className="modal-footer">
                <button className="btn btn-secondary" onClick={onSkip}>
                    Skip This Block
                </button>
                <button className="btn btn-danger" onClick={onReject}>
                    Abort All
                </button>
                <button 
                    className="btn btn-primary" 
                    onClick={() => onApprove(selectedIndex)}
                >
                    Use This Match
                    {selectedSuggestion.autoRecoveryRecommended && ' ✓'}
                </button>
            </div>
        </div>
    );
};

export default DiffRecoveryModal;
