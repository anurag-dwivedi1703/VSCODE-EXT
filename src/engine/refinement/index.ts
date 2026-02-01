/**
 * Refinement Module - Barrel Export
 * 
 * Provides the core functionality for Refinement Mode.
 * 
 * Token-Efficient Design:
 * - RefinementTokenManager handles token budget tracking
 * - Context is automatically truncated for large workspaces
 * - Conversation history is summarized when approaching limits
 * - Multi-turn PRD generation for complex features
 * 
 * Smart Context Building:
 * - SmartContextBuilder uses VS Code search APIs to find relevant files
 * - Full content for highly relevant files, skeleton for others
 * - Keyword extraction from user prompts for targeted search
 */

export * from './RefinementTypes';
export * from './RefinementPrompts';
export { RefinementSession } from './RefinementSession';
export { RefinementManager, getRefinementManager } from './RefinementManager';
export { skeletonizeFile, skeletonizeFiles, skeletonizeDirectory } from './ContextSkeletonizer';
export { RefinementTokenManager, createTokenAwareSkeleton } from './RefinementTokenManager';
export { 
    SmartContextBuilder, 
    getSmartContextBuilder, 
    buildSmartContext,
    type SmartContext,
    type RelevantFile 
} from './SmartContextBuilder';
