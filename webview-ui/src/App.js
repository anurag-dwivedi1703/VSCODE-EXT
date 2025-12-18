import React, { useState } from 'react';
import './App.css';
function App() {
    const [activeTab, setActiveTab] = useState('dashboard');
    return (<div className="container">
            <header className="header">
                <h1>🚀 Antigravity <span className="highlight">Mission Control</span></h1>
                <div className="status-badge">
                    Online
                </div>
            </header>

            <main className="main-content">
                <section className="dashboard-grid">
                    <div className="card">
                        <h2>Active Agents</h2>
                        <div className="stat">3</div>
                    </div>
                    <div className="card">
                        <h2>Pending Tasks</h2>
                        <div className="stat">12</div>
                    </div>
                    <div className="card">
                        <h2>Gemini Status</h2>
                        <div className="stat connected">Connected</div>
                    </div>
                </section>

                <section className="task-list">
                    <h3>Recent Activity</h3>
                    <div className="activity-item">
                        <span className="time">10:42 AM</span>
                        <span className="desc">Agent-01 created git worktree `feat/login-flow`</span>
                    </div>
                    <div className="activity-item">
                        <span className="time">10:45 AM</span>
                        <span className="desc">Gemini 3 Pro generated unit tests</span>
                    </div>
                </section>
            </main>
        </div>);
}
export default App;
//# sourceMappingURL=App.js.map