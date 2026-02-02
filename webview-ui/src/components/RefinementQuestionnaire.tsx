import React, { useState, useMemo, useCallback } from 'react';
import './RefinementQuestionnaire.css';

/**
 * Question type from the analyst
 */
interface ClarifyingQuestion {
    id: string;
    question: string;
    category: 'requirement' | 'constraint' | 'preference' | 'technical';
    options?: string[];
    allowMultiple?: boolean;
    inputType?: 'select' | 'text' | 'both';
    placeholder?: string;
    required?: boolean;
}

/**
 * User's response to a question
 */
interface QuestionResponse {
    questionId: string;
    selectedOptions?: string[];
    textResponse?: string;
}

interface RefinementQuestionnaireProps {
    taskId: string;
    sessionId: string;
    questions: ClarifyingQuestion[];
    contextSummary?: string;
    onSubmit: (taskId: string, sessionId: string, responses: QuestionResponse[]) => void;
    onCancel?: () => void;
}

/**
 * Category badge colors and icons
 */
const categoryConfig: Record<string, { icon: string; label: string }> = {
    requirement: { icon: '📋', label: 'Requirement' },
    constraint: { icon: '⚠️', label: 'Constraint' },
    preference: { icon: '💡', label: 'Preference' },
    technical: { icon: '⚙️', label: 'Technical' }
};

/**
 * Interactive questionnaire component for Refinement Mode.
 * Displays questions with selectable options and/or text inputs.
 */
export const RefinementQuestionnaire: React.FC<RefinementQuestionnaireProps> = ({
    taskId,
    sessionId,
    questions,
    contextSummary,
    onSubmit,
    onCancel
}) => {
    // State for all responses
    const [responses, setResponses] = useState<Map<string, QuestionResponse>>(() => {
        const initial = new Map<string, QuestionResponse>();
        questions.forEach(q => {
            initial.set(q.id, {
                questionId: q.id,
                selectedOptions: [],
                textResponse: ''
            });
        });
        return initial;
    });

    // Track which "Other" inputs are expanded
    const [expandedOther, setExpandedOther] = useState<Set<string>>(new Set());

    // Calculate progress
    const progress = useMemo(() => {
        let answered = 0;
        questions.forEach(q => {
            const response = responses.get(q.id);
            if (response) {
                const hasSelection = response.selectedOptions && response.selectedOptions.length > 0;
                const hasText = response.textResponse && response.textResponse.trim().length > 0;
                if (hasSelection || hasText) {
                    answered++;
                }
            }
        });
        return { answered, total: questions.length };
    }, [responses, questions]);

    // Check if all required questions are answered
    const canSubmit = useMemo(() => {
        return questions.every(q => {
            if (!q.required) return true;
            const response = responses.get(q.id);
            if (!response) return false;
            const hasSelection = response.selectedOptions && response.selectedOptions.length > 0;
            const hasText = response.textResponse && response.textResponse.trim().length > 0;
            return hasSelection || hasText;
        });
    }, [responses, questions]);

    // Handle option selection (single or multiple)
    const handleOptionSelect = useCallback((questionId: string, option: string, allowMultiple: boolean) => {
        setResponses(prev => {
            const newResponses = new Map(prev);
            const current = newResponses.get(questionId) || { questionId, selectedOptions: [], textResponse: '' };
            
            let newSelected: string[];
            if (allowMultiple) {
                // Toggle selection for multi-select
                if (current.selectedOptions?.includes(option)) {
                    newSelected = current.selectedOptions.filter(o => o !== option);
                } else {
                    newSelected = [...(current.selectedOptions || []), option];
                }
            } else {
                // Single select - replace
                newSelected = [option];
            }
            
            newResponses.set(questionId, {
                ...current,
                selectedOptions: newSelected
            });
            
            // If "Other" is selected, expand the text input
            if (option.toLowerCase() === 'other') {
                setExpandedOther(prev => new Set(prev).add(questionId));
            }
            
            return newResponses;
        });
    }, []);

    // Handle text input change
    const handleTextChange = useCallback((questionId: string, text: string) => {
        setResponses(prev => {
            const newResponses = new Map(prev);
            const current = newResponses.get(questionId) || { questionId, selectedOptions: [], textResponse: '' };
            newResponses.set(questionId, {
                ...current,
                textResponse: text
            });
            return newResponses;
        });
    }, []);

    // Handle form submission
    const handleSubmit = useCallback(() => {
        const responseArray = Array.from(responses.values());
        onSubmit(taskId, sessionId, responseArray);
    }, [taskId, sessionId, responses, onSubmit]);

    return (
        <div className="questionnaire-container">
            {/* Header */}
            <div className="questionnaire-header">
                <div className="header-icon">📝</div>
                <div className="header-content">
                    <h3>Analyst Questions</h3>
                    <p className="header-subtitle">
                        Answer the following to help clarify your requirements
                    </p>
                </div>
                <div className="progress-badge">
                    {progress.answered}/{progress.total} answered
                </div>
            </div>

            {/* Context Summary */}
            {contextSummary && (
                <div className="context-summary">
                    <span className="summary-icon">💡</span>
                    <span className="summary-text">{contextSummary}</span>
                </div>
            )}

            {/* Questions */}
            <div className="questions-list">
                {questions.map((question, index) => {
                    const response = responses.get(question.id);
                    const categoryInfo = categoryConfig[question.category] || categoryConfig.requirement;
                    const inputType = question.inputType || (question.options ? 'select' : 'text');
                    const showTextInput = inputType === 'text' || inputType === 'both' || expandedOther.has(question.id);
                    const isAnswered = (response?.selectedOptions?.length || 0) > 0 || (response?.textResponse?.trim().length || 0) > 0;

                    return (
                        <div 
                            key={question.id} 
                            className={`question-card ${isAnswered ? 'answered' : ''} ${question.required ? 'required' : ''}`}
                        >
                            {/* Question Header */}
                            <div className="question-header">
                                <span className="question-number">{index + 1}</span>
                                <span className={`category-badge category-${question.category}`}>
                                    {categoryInfo.icon} {categoryInfo.label}
                                </span>
                                {question.required && <span className="required-badge">Required</span>}
                            </div>

                            {/* Question Text */}
                            <div className="question-text">{question.question}</div>

                            {/* Options (if available) */}
                            {question.options && question.options.length > 0 && (
                                <div className={`options-group ${question.allowMultiple ? 'multi' : 'single'}`}>
                                    {question.options.map((option, optIdx) => {
                                        const isSelected = response?.selectedOptions?.includes(option);
                                        return (
                                            <button
                                                key={optIdx}
                                                className={`option-button ${isSelected ? 'selected' : ''}`}
                                                onClick={() => handleOptionSelect(question.id, option, !!question.allowMultiple)}
                                            >
                                                <span className="option-indicator">
                                                    {question.allowMultiple ? (
                                                        isSelected ? '☑' : '☐'
                                                    ) : (
                                                        isSelected ? '●' : '○'
                                                    )}
                                                </span>
                                                <span className="option-text">{option}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Text Input (for text type or "Other" option) */}
                            {showTextInput && (
                                <div className="text-input-container">
                                    <textarea
                                        className="text-input"
                                        placeholder={question.placeholder || 'Enter your response...'}
                                        value={response?.textResponse || ''}
                                        onChange={(e) => handleTextChange(question.id, e.target.value)}
                                        rows={3}
                                    />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Actions */}
            <div className="questionnaire-actions">
                {onCancel && (
                    <button className="cancel-button" onClick={onCancel}>
                        Skip for Now
                    </button>
                )}
                <button 
                    className={`submit-button ${canSubmit ? '' : 'disabled'}`}
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                >
                    Submit Answers ({progress.answered}/{progress.total})
                </button>
            </div>
        </div>
    );
};

export default RefinementQuestionnaire;
