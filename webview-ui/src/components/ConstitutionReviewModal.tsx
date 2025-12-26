import * as React from 'react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';

interface ConstitutionReviewModalProps {
    content: string;
    type: 'constitution' | 'constitution-update' | 'constitution-drift';
    taskId: string;
    onApprove: (editedContent?: string) => void;
    onReject: () => void;
}

/**
 * Modal component for reviewing and editing workspace constitution.
 * Shows different UI based on whether this is a new constitution, update, or drift detection.
 */
export const ConstitutionReviewModal: React.FC<ConstitutionReviewModalProps> = ({
    content,
    type,
    onApprove,
    onReject
}) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editedContent, setEditedContent] = useState(content);

    const getTitle = () => {
        switch (type) {
            case 'constitution':
                return '📜 New Workspace Constitution';
            case 'constitution-update':
                return '🔄 Constitution Update';
            case 'constitution-drift':
                return '⚠️ Constitution Drift Detected';
            default:
                return 'Constitution Review';
        }
    };

    const getDescription = () => {
        switch (type) {
            case 'constitution':
                return 'A constitution has been generated for this workspace. Please review and approve it before starting the mission.';
            case 'constitution-update':
                return 'Based on the changes made during this mission, the constitution may need updates. Please review the suggested changes.';
            case 'constitution-drift':
                return 'The workspace has changed since the constitution was created. Please review and approve the updated constitution.';
            default:
                return 'Please review the constitution.';
        }
    };

    const handleApprove = () => {
        if (isEditing) {
            onApprove(editedContent);
        } else {
            onApprove();
        }
    };

    return (
        <div className="constitution-modal-overlay">
            <div className="constitution-modal">
                <div className="constitution-modal-header">
                    <h2>{getTitle()}</h2>
                    <p className="constitution-description">{getDescription()}</p>
                </div>

                <div className="constitution-modal-content">
                    {isEditing ? (
                        <textarea
                            className="constitution-editor"
                            value={editedContent}
                            onChange={(e) => setEditedContent(e.target.value)}
                            placeholder="Edit the constitution..."
                        />
                    ) : (
                        <div className="constitution-preview">
                            <ReactMarkdown>{content}</ReactMarkdown>
                        </div>
                    )}
                </div>

                <div className="constitution-modal-actions">
                    <button
                        className="constitution-btn constitution-btn-edit"
                        onClick={() => setIsEditing(!isEditing)}
                    >
                        {isEditing ? '👁️ Preview' : '✏️ Edit'}
                    </button>

                    <div className="constitution-btn-group">
                        <button
                            className="constitution-btn constitution-btn-reject"
                            onClick={onReject}
                        >
                            ❌ Reject
                        </button>
                        <button
                            className="constitution-btn constitution-btn-approve"
                            onClick={handleApprove}
                        >
                            ✅ Approve
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ConstitutionReviewModal;
