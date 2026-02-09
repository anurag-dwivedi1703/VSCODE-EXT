import * as React from 'react';
import { useState, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';

interface CorporateGuidelinesConfig {
    security: boolean;
    performance: boolean;
    maintainability: boolean;
    testing: boolean;
    accessibility: boolean;
}

interface ConstitutionReviewModalProps {
    content: string;
    type: 'constitution' | 'constitution-update' | 'constitution-drift';
    taskId: string;
    corporateGuidelines?: CorporateGuidelinesConfig;
    onApprove: (editedContent?: string, guidelinesConfig?: CorporateGuidelinesConfig) => void;
    onReject: () => void;
    // editedContent param allows backend to patch user's edits when toggling guidelines
    onGuidelinesChange?: (config: CorporateGuidelinesConfig, editedContent?: string) => void;
}

// Rule templates for quick additions
interface RuleTemplate {
    id: string;
    category: 'MUST' | 'MUST NOT' | 'SHOULD';
    template: string;
    description: string;
    icon: string;
}

const RULE_TEMPLATES: RuleTemplate[] = [
    // MUST rules
    {
        id: 'must-lint',
        category: 'MUST',
        template: 'MUST: Run `npm run lint` before completing any code change',
        description: 'Enforce linting',
        icon: '🔍'
    },
    {
        id: 'must-test',
        category: 'MUST',
        template: 'MUST: Run tests after modifying any file in src/',
        description: 'Enforce testing',
        icon: '🧪'
    },
    {
        id: 'must-types',
        category: 'MUST',
        template: 'MUST: Add TypeScript types to all new functions',
        description: 'Enforce typing',
        icon: '📝'
    },
    {
        id: 'must-docs',
        category: 'MUST',
        template: 'MUST: Add JSDoc comments to all public functions',
        description: 'Enforce documentation',
        icon: '📚'
    },
    // MUST NOT rules
    {
        id: 'mustnot-console',
        category: 'MUST NOT',
        template: 'MUST NOT: Leave console.log statements in production code',
        description: 'No console logs',
        icon: '🚫'
    },
    {
        id: 'mustnot-any',
        category: 'MUST NOT',
        template: 'MUST NOT: Use `any` type in public APIs',
        description: 'No any type',
        icon: '❌'
    },
    {
        id: 'mustnot-deps',
        category: 'MUST NOT',
        template: 'MUST NOT: Add new dependencies without checking existing alternatives',
        description: 'Control deps',
        icon: '📦'
    },
    {
        id: 'mustnot-secrets',
        category: 'MUST NOT',
        template: 'MUST NOT: Hardcode secrets or API keys',
        description: 'No secrets',
        icon: '🔐'
    },
    // SHOULD rules
    {
        id: 'should-reuse',
        category: 'SHOULD',
        template: 'SHOULD: Prefer existing utilities over new implementations',
        description: 'Reuse code',
        icon: '♻️'
    },
    {
        id: 'should-async',
        category: 'SHOULD',
        template: 'SHOULD: Use async/await instead of .then() chains',
        description: 'Modern async',
        icon: '⚡'
    },
    {
        id: 'should-errors',
        category: 'SHOULD',
        template: 'SHOULD: Add error handling with descriptive messages',
        description: 'Error handling',
        icon: '⚠️'
    },
    {
        id: 'should-small',
        category: 'SHOULD',
        template: 'SHOULD: Keep functions under 50 lines',
        description: 'Small functions',
        icon: '📏'
    }
];

// Custom rule input placeholder
const CUSTOM_RULE_PLACEHOLDERS = {
    'MUST': 'MUST: [Enter your required rule...]',
    'MUST NOT': 'MUST NOT: [Enter forbidden pattern...]',
    'SHOULD': 'SHOULD: [Enter recommended practice...]'
};

/**
 * Modal component for reviewing and editing workspace constitution.
 * Enhanced with rule templates, quick-add buttons, and better UX.
 */
// Default guidelines config
const DEFAULT_GUIDELINES: CorporateGuidelinesConfig = {
    security: true,
    performance: true,
    maintainability: false,
    testing: false,
    accessibility: false
};

// Guidelines info for display
const GUIDELINES_INFO = {
    security: { name: 'Security', icon: '🔒', description: 'OWASP-based security best practices', count: 8 },
    performance: { name: 'Performance', icon: '⚡', description: 'Performance optimization patterns', count: 7 },
    maintainability: { name: 'Maintainability', icon: '🧹', description: 'SOLID principles & clean code', count: 10 },
    testing: { name: 'Testing', icon: '🧪', description: 'Testing best practices', count: 5 },
    accessibility: { name: 'Accessibility', icon: '♿', description: 'WCAG accessibility guidelines', count: 4 }
};

export const ConstitutionReviewModal: React.FC<ConstitutionReviewModalProps> = ({
    content,
    type,
    corporateGuidelines,
    onApprove,
    onReject,
    onGuidelinesChange
}) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editedContent, setEditedContent] = useState(content);
    const [showTemplates, setShowTemplates] = useState(false);
    const [showGuidelines, setShowGuidelines] = useState(false);
    const [selectedCategory, setSelectedCategory] = useState<'MUST' | 'MUST NOT' | 'SHOULD'>('MUST');
    const [customRuleText, setCustomRuleText] = useState('');
    const [guidelinesConfig, setGuidelinesConfig] = useState<CorporateGuidelinesConfig>(
        corporateGuidelines || DEFAULT_GUIDELINES
    );

    // Sync editedContent when parent content changes (e.g., after live guidelines toggle)
    React.useEffect(() => {
        if (!isEditing) {
            setEditedContent(content);
        }
    }, [content, isEditing]);

    // Update guidelines and notify parent
    // CRITICAL: Pass editedContent so backend patches user's edits, not original
    const toggleGuideline = useCallback((key: keyof CorporateGuidelinesConfig) => {
        const newConfig = { ...guidelinesConfig, [key]: !guidelinesConfig[key] };
        setGuidelinesConfig(newConfig);
        // Pass editedContent so backend can patch user's edited markdown
        onGuidelinesChange?.(newConfig, editedContent);
    }, [guidelinesConfig, onGuidelinesChange, editedContent]);

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
                return 'A constitution has been generated for this workspace. This is the "Agent Bible" - review and customize the rules that agents must follow.';
            case 'constitution-update':
                return 'Based on changes made during this mission, the constitution may need updates. Review the suggested changes below.';
            case 'constitution-drift':
                return 'The workspace has changed since the constitution was created. Review the updated rules to ensure they match your current project structure.';
            default:
                return 'Please review the constitution.';
        }
    };

    // Parse constitution to detect existing custom rules section
    const customRulesSection = useMemo(() => {
        const match = editedContent.match(/## 8\. Custom Rules[\s\S]*?(?=##|---|\Z)/);
        return match ? match[0] : null;
    }, [editedContent]);

    // Add a rule template to the constitution
    const addRule = useCallback((rule: string) => {
        const ruleWithBullet = `- ${rule}`;

        // Find the custom rules section
        const customRulesMatch = editedContent.match(/(## 8\. Custom Rules.*?)(\n---|\n##|$)/s);

        if (customRulesMatch) {
            // Add to existing custom rules section
            const beforeSection = editedContent.substring(0, customRulesMatch.index! + customRulesMatch[1].length);
            const afterSection = editedContent.substring(customRulesMatch.index! + customRulesMatch[1].length);

            // Check if there's placeholder text to replace
            if (beforeSection.includes('*Add custom rules here')) {
                // Replace placeholder with actual rule
                const updatedContent = beforeSection.replace(
                    /\*Add custom rules here.*?\*/s,
                    ruleWithBullet
                ) + afterSection;
                setEditedContent(updatedContent);
            } else {
                // Append to section
                setEditedContent(beforeSection + '\n' + ruleWithBullet + afterSection);
            }
        } else {
            // No custom rules section found - append at end
            setEditedContent(editedContent + '\n\n## 8. Custom Rules (User-Defined)\n\n' + ruleWithBullet);
        }

        setIsEditing(true); // Switch to edit mode to show changes
    }, [editedContent]);

    // Add custom rule
    const addCustomRule = useCallback(() => {
        if (customRuleText.trim()) {
            addRule(customRuleText.trim());
            setCustomRuleText('');
        }
    }, [customRuleText, addRule]);

    // Template picker by category
    const filteredTemplates = useMemo(() => {
        return RULE_TEMPLATES.filter(t => t.category === selectedCategory);
    }, [selectedCategory]);

    const handleApprove = () => {
        if (isEditing) {
            onApprove(editedContent, guidelinesConfig);
        } else {
            onApprove(undefined, guidelinesConfig);
        }
    };

    // Count enabled guidelines
    const enabledGuidelinesCount = Object.values(guidelinesConfig).filter(Boolean).length;

    // Calculate rule counts for stats display
    const ruleStats = useMemo(() => {
        const mustCount = (editedContent.match(/^\s*-\s*✅|^\s*-\s*MUST:/gim) || []).length;
        const mustNotCount = (editedContent.match(/^\s*-\s*❌|^\s*-\s*MUST NOT:/gim) || []).length;
        const shouldCount = (editedContent.match(/^\s*-\s*💡|^\s*-\s*SHOULD:/gim) || []).length;
        return { mustCount, mustNotCount, shouldCount, total: mustCount + mustNotCount + shouldCount };
    }, [editedContent]);

    return (
        <div className="constitution-modal-overlay">
            <div className="constitution-modal constitution-modal-enhanced">
                {/* Header */}
                <div className="constitution-modal-header">
                    <h2>{getTitle()}</h2>
                    <p className="constitution-description">{getDescription()}</p>

                    {/* Rule Stats */}
                    <div className="constitution-stats">
                        <span className="stat-item stat-must" title="MUST rules">
                            ✅ {ruleStats.mustCount}
                        </span>
                        <span className="stat-item stat-mustnot" title="MUST NOT rules">
                            ❌ {ruleStats.mustNotCount}
                        </span>
                        <span className="stat-item stat-should" title="SHOULD rules">
                            💡 {ruleStats.shouldCount}
                        </span>
                        <span className="stat-total">
                            Total: {ruleStats.total} rules
                        </span>
                    </div>
                </div>

                {/* Quick Add Rules Panel */}
                {showTemplates && (
                    <div className="constitution-templates-panel">
                        <div className="templates-header">
                            <h3>Quick Add Rules</h3>
                            <div className="category-tabs">
                                <button
                                    className={`tab-btn ${selectedCategory === 'MUST' ? 'active' : ''}`}
                                    onClick={() => setSelectedCategory('MUST')}
                                >
                                    ✅ MUST
                                </button>
                                <button
                                    className={`tab-btn ${selectedCategory === 'MUST NOT' ? 'active' : ''}`}
                                    onClick={() => setSelectedCategory('MUST NOT')}
                                >
                                    ❌ MUST NOT
                                </button>
                                <button
                                    className={`tab-btn ${selectedCategory === 'SHOULD' ? 'active' : ''}`}
                                    onClick={() => setSelectedCategory('SHOULD')}
                                >
                                    💡 SHOULD
                                </button>
                            </div>
                        </div>

                        <div className="templates-grid">
                            {filteredTemplates.map(template => (
                                <button
                                    key={template.id}
                                    className="template-btn"
                                    onClick={() => addRule(template.template)}
                                    title={template.template}
                                >
                                    <span className="template-icon">{template.icon}</span>
                                    <span className="template-desc">{template.description}</span>
                                </button>
                            ))}
                        </div>

                        {/* Custom Rule Input */}
                        <div className="custom-rule-input">
                            <input
                                type="text"
                                placeholder={CUSTOM_RULE_PLACEHOLDERS[selectedCategory]}
                                value={customRuleText}
                                onChange={(e) => setCustomRuleText(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && addCustomRule()}
                            />
                            <button
                                className="add-custom-btn"
                                onClick={addCustomRule}
                                disabled={!customRuleText.trim()}
                            >
                                + Add
                            </button>
                        </div>
                    </div>
                )}

                {/* Corporate Guidelines Panel */}
                {showGuidelines && (
                    <div className="constitution-guidelines-panel">
                        <div className="guidelines-header">
                            <h3>Corporate Guidelines</h3>
                            <span className="guidelines-subtitle">
                                Industry best practices applied to agent constraints
                            </span>
                        </div>

                        <div className="guidelines-grid">
                            {(Object.keys(GUIDELINES_INFO) as Array<keyof typeof GUIDELINES_INFO>).map(key => {
                                const info = GUIDELINES_INFO[key];
                                const isEnabled = guidelinesConfig[key];

                                return (
                                    <button
                                        key={key}
                                        className={`guideline-btn ${isEnabled ? 'enabled' : 'disabled'}`}
                                        onClick={() => toggleGuideline(key)}
                                        title={info.description}
                                    >
                                        <div className="guideline-icon">{info.icon}</div>
                                        <div className="guideline-content">
                                            <span className="guideline-name">{info.name}</span>
                                            <span className="guideline-count">{info.count} rules</span>
                                        </div>
                                        <div className="guideline-toggle">
                                            {isEnabled ? '✓' : '○'}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="guidelines-footer">
                            <span className="guidelines-note">
                                {enabledGuidelinesCount} guideline set{enabledGuidelinesCount !== 1 ? 's' : ''} enabled
                            </span>
                        </div>
                    </div>
                )}

                {/* Main Content */}
                <div className="constitution-modal-content">
                    {isEditing ? (
                        <textarea
                            className="constitution-editor"
                            value={editedContent}
                            onChange={(e) => setEditedContent(e.target.value)}
                            placeholder="Edit the constitution..."
                            spellCheck={false}
                        />
                    ) : (
                        <div className="constitution-preview" key={`preview-${editedContent.length}`}>
                            <ReactMarkdown>{editedContent}</ReactMarkdown>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="constitution-modal-actions">
                    <div className="actions-left">
                        <button
                            className="constitution-btn constitution-btn-templates"
                            onClick={() => { setShowTemplates(!showTemplates); setShowGuidelines(false); }}
                        >
                            {showTemplates ? '📋 Hide Templates' : '📋 Add Rules'}
                        </button>
                        <button
                            className="constitution-btn constitution-btn-guidelines"
                            onClick={() => { setShowGuidelines(!showGuidelines); setShowTemplates(false); }}
                        >
                            {showGuidelines ? '🏢 Hide Guidelines' : `🏢 Guidelines (${enabledGuidelinesCount})`}
                        </button>
                        <button
                            className="constitution-btn constitution-btn-edit"
                            onClick={() => setIsEditing(!isEditing)}
                        >
                            {isEditing ? '👁️ Preview' : '✏️ Edit'}
                        </button>
                    </div>

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
                            ✅ Approve{isEditing ? ' (with edits)' : ''}
                        </button>
                    </div>
                </div>
            </div>

            {/* Enhanced Styles */}
            <style>{`
                .constitution-modal-enhanced {
                    max-width: 900px;
                    max-height: 90vh;
                }
                
                .constitution-stats {
                    display: flex;
                    gap: 12px;
                    margin-top: 12px;
                    font-size: 13px;
                }
                
                .stat-item {
                    padding: 4px 10px;
                    border-radius: 12px;
                    background: var(--vscode-badge-background);
                }
                
                .stat-total {
                    margin-left: auto;
                    opacity: 0.8;
                }
                
                .constitution-templates-panel {
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding: 16px;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }
                
                .templates-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }
                
                .templates-header h3 {
                    margin: 0;
                    font-size: 14px;
                    font-weight: 500;
                }
                
                .category-tabs {
                    display: flex;
                    gap: 4px;
                }
                
                .tab-btn {
                    padding: 6px 12px;
                    border: none;
                    background: transparent;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    border-radius: 4px;
                    font-size: 12px;
                    opacity: 0.7;
                    transition: all 0.2s;
                }
                
                .tab-btn:hover {
                    opacity: 1;
                    background: var(--vscode-button-secondaryHoverBackground);
                }
                
                .tab-btn.active {
                    opacity: 1;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                
                .templates-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
                    gap: 8px;
                    margin-bottom: 12px;
                }
                
                .template-btn {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 4px;
                    padding: 10px 8px;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-background);
                    color: var(--vscode-foreground);
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.2s;
                    font-size: 11px;
                    text-align: center;
                }
                
                .template-btn:hover {
                    border-color: var(--vscode-focusBorder);
                    background: var(--vscode-list-hoverBackground);
                    transform: translateY(-1px);
                }
                
                .template-icon {
                    font-size: 18px;
                }
                
                .template-desc {
                    opacity: 0.9;
                }
                
                .custom-rule-input {
                    display: flex;
                    gap: 8px;
                }
                
                .custom-rule-input input {
                    flex: 1;
                    padding: 8px 12px;
                    border: 1px solid var(--vscode-input-border);
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border-radius: 4px;
                    font-size: 12px;
                }
                
                .custom-rule-input input:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                }
                
                .add-custom-btn {
                    padding: 8px 16px;
                    border: none;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: all 0.2s;
                }
                
                .add-custom-btn:hover:not(:disabled) {
                    background: var(--vscode-button-secondaryHoverBackground);
                }
                
                .add-custom-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                
                .actions-left {
                    display: flex;
                    gap: 8px;
                }
                
                .constitution-btn-templates {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                
                .constitution-btn-templates:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
                }
                
                .constitution-btn-guidelines {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                
                .constitution-btn-guidelines:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
                }
                
                .constitution-guidelines-panel {
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding: 16px;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }
                
                .guidelines-header {
                    margin-bottom: 12px;
                }
                
                .guidelines-header h3 {
                    margin: 0 0 4px 0;
                    font-size: 14px;
                    font-weight: 500;
                }
                
                .guidelines-subtitle {
                    font-size: 12px;
                    opacity: 0.7;
                }
                
                .guidelines-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
                    gap: 8px;
                    margin-bottom: 12px;
                }
                
                .guideline-btn {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 10px 12px;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-background);
                    color: var(--vscode-foreground);
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.2s;
                    text-align: left;
                }
                
                .guideline-btn:hover {
                    border-color: var(--vscode-focusBorder);
                    background: var(--vscode-list-hoverBackground);
                }
                
                .guideline-btn.enabled {
                    border-color: var(--vscode-inputValidation-infoBorder);
                    background: var(--vscode-inputValidation-infoBackground);
                }
                
                .guideline-icon {
                    font-size: 20px;
                }
                
                .guideline-content {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }
                
                .guideline-name {
                    font-weight: 500;
                    font-size: 13px;
                }
                
                .guideline-count {
                    font-size: 11px;
                    opacity: 0.7;
                }
                
                .guideline-toggle {
                    font-size: 14px;
                    width: 20px;
                    text-align: center;
                }
                
                .guideline-btn.enabled .guideline-toggle {
                    color: var(--vscode-charts-green);
                }
                
                .guidelines-footer {
                    font-size: 12px;
                    opacity: 0.7;
                }
                
                .constitution-editor {
                    font-family: var(--vscode-editor-font-family);
                    font-size: 13px;
                    line-height: 1.5;
                }
            `}</style>
        </div>
    );
};

export default ConstitutionReviewModal;
