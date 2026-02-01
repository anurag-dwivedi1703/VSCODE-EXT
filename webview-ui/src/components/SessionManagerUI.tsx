import React, { useState, useEffect } from 'react';
import { vscode } from '../utilities/vscode';
import './SessionManagerUI.css';

// ============================================
// TYPES
// ============================================

interface SavedSession {
    id: string;
    name: string;
    domain: string;
    savedAt: number;
    expiresAt?: number;
    cookieCount: number;
    localStorageKeys: string[];
}

interface SessionHealth {
    isValid: boolean;
    expiredCookies: number;
    validCookies: number;
    recommendations: string[];
}

interface SessionManagerUIProps {
    onClose: () => void;
    onSessionSelected?: (session: SavedSession) => void;
}

// ============================================
// COMPONENT
// ============================================

export const SessionManagerUI: React.FC<SessionManagerUIProps> = ({
    onClose,
    onSessionSelected,
}) => {
    const [sessions, setSessions] = useState<SavedSession[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedSession, setSelectedSession] = useState<SavedSession | null>(null);
    const [sessionHealth, setSessionHealth] = useState<SessionHealth | null>(null);
    const [checkingHealth, setCheckingHealth] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    // Load sessions on mount
    useEffect(() => {
        loadSessions();
    }, []);

    // Listen for messages from extension
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            
            switch (message.type) {
                case 'sessionsLoaded':
                    setSessions(message.sessions || []);
                    setLoading(false);
                    break;
                    
                case 'sessionHealthResult':
                    setSessionHealth(message.health);
                    setCheckingHealth(false);
                    break;
                    
                case 'sessionDeleted':
                    setSessions(prev => prev.filter(s => s.id !== message.sessionId));
                    if (selectedSession?.id === message.sessionId) {
                        setSelectedSession(null);
                        setSessionHealth(null);
                    }
                    setConfirmDelete(null);
                    break;
                    
                case 'allSessionsCleared':
                    setSessions([]);
                    setSelectedSession(null);
                    setSessionHealth(null);
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [selectedSession]);

    const loadSessions = () => {
        setLoading(true);
        vscode.postMessage({ type: 'loadSessions' });
    };

    const selectSession = (session: SavedSession) => {
        setSelectedSession(session);
        setSessionHealth(null);
    };

    const checkHealth = (session: SavedSession) => {
        setCheckingHealth(true);
        vscode.postMessage({ type: 'checkSessionHealth', sessionId: session.id });
    };

    const deleteSession = (sessionId: string) => {
        vscode.postMessage({ type: 'deleteSession', sessionId });
    };

    const clearAllSessions = () => {
        if (window.confirm('Are you sure you want to delete all saved sessions?')) {
            vscode.postMessage({ type: 'clearAllSessions' });
        }
    };

    const clearExpiredSessions = () => {
        vscode.postMessage({ type: 'clearExpiredSessions' });
        loadSessions(); // Refresh after clearing
    };

    const useSession = (session: SavedSession) => {
        if (onSessionSelected) {
            onSessionSelected(session);
        }
        vscode.postMessage({ type: 'useSession', sessionId: session.id });
        onClose();
    };

    const formatDate = (timestamp: number): string => {
        return new Date(timestamp).toLocaleString();
    };

    const formatTimeAgo = (timestamp: number): string => {
        const diff = Date.now() - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (days > 0) return `${days}d ago`;
        if (hours > 0) return `${hours}h ago`;
        if (minutes > 0) return `${minutes}m ago`;
        return 'Just now';
    };

    const isExpired = (session: SavedSession): boolean => {
        return session.expiresAt !== undefined && session.expiresAt < Date.now();
    };

    const getExpiryStatus = (session: SavedSession): { text: string; className: string } => {
        if (!session.expiresAt) {
            return { text: 'No expiry', className: 'expiry-none' };
        }
        
        const now = Date.now();
        if (session.expiresAt < now) {
            return { text: 'Expired', className: 'expiry-expired' };
        }
        
        const hoursUntilExpiry = (session.expiresAt - now) / 3600000;
        if (hoursUntilExpiry < 1) {
            return { text: 'Expires soon', className: 'expiry-soon' };
        }
        if (hoursUntilExpiry < 24) {
            return { text: `${Math.floor(hoursUntilExpiry)}h left`, className: 'expiry-warning' };
        }
        
        return { text: `${Math.floor(hoursUntilExpiry / 24)}d left`, className: 'expiry-ok' };
    };

    return (
        <div className="session-manager-ui">
            <div className="manager-header">
                <h2>🔐 Session Manager</h2>
                <button className="close-btn" onClick={onClose}>✕</button>
            </div>

            <div className="manager-content">
                {loading ? (
                    <div className="loading-state">
                        <div className="spinner"></div>
                        <p>Loading sessions...</p>
                    </div>
                ) : (
                    <div className="sessions-container">
                        {/* Session List */}
                        <div className="session-list">
                            <div className="list-header">
                                <span className="list-title">Saved Sessions ({sessions.length})</span>
                                <div className="list-actions">
                                    <button 
                                        className="action-btn small"
                                        onClick={clearExpiredSessions}
                                        title="Clear expired sessions"
                                    >
                                        🧹
                                    </button>
                                    <button 
                                        className="action-btn small danger"
                                        onClick={clearAllSessions}
                                        title="Clear all sessions"
                                    >
                                        🗑️
                                    </button>
                                </div>
                            </div>

                            {sessions.length === 0 ? (
                                <div className="no-sessions">
                                    <div className="no-sessions-icon">📭</div>
                                    <p>No saved sessions</p>
                                    <p className="hint">
                                        Sessions are saved automatically when you log in to websites.
                                    </p>
                                </div>
                            ) : (
                                <div className="session-items">
                                    {sessions.map(session => {
                                        const expiry = getExpiryStatus(session);
                                        return (
                                            <div
                                                key={session.id}
                                                className={`session-item ${selectedSession?.id === session.id ? 'selected' : ''} ${isExpired(session) ? 'expired' : ''}`}
                                                onClick={() => selectSession(session)}
                                            >
                                                <div className="session-main">
                                                    <span className="session-domain">{session.domain}</span>
                                                    <span className={`session-expiry ${expiry.className}`}>
                                                        {expiry.text}
                                                    </span>
                                                </div>
                                                <div className="session-meta">
                                                    <span className="session-cookies">
                                                        🍪 {session.cookieCount} cookies
                                                    </span>
                                                    <span className="session-time">
                                                        {formatTimeAgo(session.savedAt)}
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Session Details */}
                        <div className="session-details">
                            {selectedSession ? (
                                <>
                                    <div className="details-header">
                                        <h3>{selectedSession.domain}</h3>
                                        {confirmDelete === selectedSession.id ? (
                                            <div className="confirm-delete">
                                                <span>Delete?</span>
                                                <button 
                                                    className="confirm-yes"
                                                    onClick={() => deleteSession(selectedSession.id)}
                                                >
                                                    Yes
                                                </button>
                                                <button 
                                                    className="confirm-no"
                                                    onClick={() => setConfirmDelete(null)}
                                                >
                                                    No
                                                </button>
                                            </div>
                                        ) : (
                                            <button 
                                                className="delete-btn"
                                                onClick={() => setConfirmDelete(selectedSession.id)}
                                            >
                                                🗑️
                                            </button>
                                        )}
                                    </div>

                                    <div className="details-info">
                                        <div className="info-row">
                                            <span className="info-label">Name:</span>
                                            <span className="info-value">{selectedSession.name}</span>
                                        </div>
                                        <div className="info-row">
                                            <span className="info-label">Saved:</span>
                                            <span className="info-value">{formatDate(selectedSession.savedAt)}</span>
                                        </div>
                                        <div className="info-row">
                                            <span className="info-label">Cookies:</span>
                                            <span className="info-value">{selectedSession.cookieCount}</span>
                                        </div>
                                        {selectedSession.expiresAt && (
                                            <div className="info-row">
                                                <span className="info-label">Expires:</span>
                                                <span className={`info-value ${isExpired(selectedSession) ? 'expired-text' : ''}`}>
                                                    {formatDate(selectedSession.expiresAt)}
                                                </span>
                                            </div>
                                        )}
                                        {selectedSession.localStorageKeys.length > 0 && (
                                            <div className="info-row">
                                                <span className="info-label">Storage Keys:</span>
                                                <span className="info-value">
                                                    {selectedSession.localStorageKeys.length} items
                                                </span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Health Check */}
                                    <div className="health-section">
                                        <div className="health-header">
                                            <span>Session Health</span>
                                            <button 
                                                className="check-health-btn"
                                                onClick={() => checkHealth(selectedSession)}
                                                disabled={checkingHealth}
                                            >
                                                {checkingHealth ? '...' : '🔍 Check'}
                                            </button>
                                        </div>

                                        {sessionHealth && (
                                            <div className={`health-result ${sessionHealth.isValid ? 'healthy' : 'unhealthy'}`}>
                                                <div className="health-status">
                                                    {sessionHealth.isValid ? '✅ Valid' : '⚠️ Issues Found'}
                                                </div>
                                                <div className="health-details">
                                                    <span>Valid: {sessionHealth.validCookies}</span>
                                                    <span>Expired: {sessionHealth.expiredCookies}</span>
                                                </div>
                                                {sessionHealth.recommendations.length > 0 && (
                                                    <div className="health-recommendations">
                                                        {sessionHealth.recommendations.map((rec, i) => (
                                                            <p key={i}>• {rec}</p>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Actions */}
                                    <div className="details-actions">
                                        <button 
                                            className="use-session-btn"
                                            onClick={() => useSession(selectedSession)}
                                            disabled={isExpired(selectedSession)}
                                        >
                                            🚀 Use This Session
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <div className="no-selection">
                                    <div className="no-selection-icon">👈</div>
                                    <p>Select a session to view details</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <div className="manager-footer">
                <button className="refresh-btn" onClick={loadSessions}>
                    🔄 Refresh
                </button>
                <button className="close-footer-btn" onClick={onClose}>
                    Close
                </button>
            </div>
        </div>
    );
};

export default SessionManagerUI;
