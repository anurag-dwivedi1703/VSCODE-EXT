# Implementation Plan - Phased Execution Guard-Rails

## Executive Summary

This plan introduces **intelligent requirement decomposition** to prevent context exhaustion when users submit large, monolithic requirements.

---

## Architecture Overview

```
User Requirement → Complexity Analyzer → Phase Generator → Context Monitor → Phase Executor
```

---

# PHASE 1: Complexity Analyzer

## Objective
Analyze incoming requirements and produce a complexity score.

## [NEW] `src/services/ComplexityAnalyzer.ts`

**Interface:**
```typescript
export interface ComplexityScore {
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  score: number;
  estimatedTokens: number;
  metrics: {
    featureCount: number;
    estimatedFileCount: number;
    scopeIndicators: string[];
    riskFactors: string[];
  };
  recommendation: 'PROCEED' | 'SPLIT_PHASES' | 'REQUIRE_CLARIFICATION';
}
```

**Scoring Algorithm:**
| Factor | Weight |
|--------|--------|
| Feature count | 3 pts each |
| File references | 2 pts each |
| Scope keywords | 5-15 pts |
| Risk factors | 5-10 pts |
| Text length | 1 pt/100 chars |

**Thresholds:**
| Score | Level | Action |
|-------|-------|--------|
| 0-20 | LOW | PROCEED |
| 21-40 | MEDIUM | PROCEED (monitor) |
| 41-70 | HIGH | SPLIT_PHASES |
| 71+ | EXTREME | REQUIRE_CLARIFICATION |

---

# PHASE 2: Phase Generator

## Objective
Split complex requirements into manageable phases.

## [NEW] `src/services/PhaseGenerator.ts`

**Interface:**
```typescript
export interface Phase {
  id: string;
  name: string;
  description: string;
  requirements: string[];
  deliverables: string[];
  verificationCriteria: string[];
  estimatedTokens: number;
  dependencies: string[];
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
}
```

**Splitting Strategies:**
1. Feature-Based: Group related features
2. Layer-Based: Models → Backend → Frontend → Tests
3. Incremental: MVP → Secondary → Polish

---

# PHASE 3: Context Monitor

## Objective
Track token usage and trigger phase boundaries.

## [NEW] `src/services/ContextMonitor.ts`

**Interface:**
```typescript
export interface ContextBudget {
  totalBudget: number;
  used: number;
  remaining: number;
  percentUsed: number;
  status: 'healthy' | 'warning' | 'critical' | 'exhausted';
}
```

**Thresholds:**
| % Used | Status | Action |
|--------|--------|--------|
| 0-70% | healthy | Continue |
| 70-90% | warning | Wrap up |
| 90-99% | critical | Force wrap-up |
| 100% | exhausted | Stop, save state |

---

# PHASE 4: Phase Executor Integration

## Objective
Modify TaskRunner for phased execution.

## [MODIFY] `src/engine/TaskRunner.ts`

Add to AgentTask interface:
```typescript
phases?: Phase[];
currentPhaseIndex?: number;
phaseResults?: PhaseResult[];
executionMode?: 'single' | 'phased';
```

New methods:
- executePhased()
- executePhase()
- verifyPhase()
- requestPhaseApproval()
- transitionToNextPhase()

## [MODIFY] `src/ai/PromptEngine.ts`
Add phase-aware prompts.

## [NEW] `src/services/PhaseStateManager.ts`
Persist phase state for recovery.

---

# PHASE 5: UI & Polish

## Objective
Display phase progress in webview.

## [NEW] `webview-ui/src/components/PhaseProgress.tsx`
Visual timeline of phases.

## [NEW] `webview-ui/src/components/ContextBudgetIndicator.tsx`
Token budget progress bar.

## [MODIFY] `src/panels/MissionControlProvider.ts`
Send phase/budget updates to webview.

---

## File Summary

| File | Action | Phase |
|------|--------|-------|
| src/services/ComplexityAnalyzer.ts | NEW | 1 |
| src/services/PhaseGenerator.ts | NEW | 2 |
| src/services/ContextMonitor.ts | NEW | 3 |
| src/services/PhaseStateManager.ts | NEW | 4 |
| src/engine/TaskRunner.ts | MODIFY | 4 |
| src/ai/PromptEngine.ts | MODIFY | 4 |
| webview-ui/src/components/PhaseProgress.tsx | NEW | 5 |
| webview-ui/src/components/ContextBudgetIndicator.tsx | NEW | 5 |

---

## Estimated Effort

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| 1 | 2-3 hrs | None |
| 2 | 3-4 hrs | Phase 1 |
| 3 | 2-3 hrs | None |
| 4 | 4-5 hrs | 1, 2, 3 |
| 5 | 3-4 hrs | Phase 4 |

**Total: 14-19 hours**

---

## Success Criteria

1. Large requirements auto-trigger phased execution
2. Each phase completes within token budget
3. User approves between phases
4. System recovers if interrupted
5. No more context exhaustion
