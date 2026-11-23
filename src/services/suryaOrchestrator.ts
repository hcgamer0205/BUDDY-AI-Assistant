/**
 * SURYA Unified Intelligence Orchestrator (Compatibility Facade over BUDDY Orchestrator)
 */

export type { OrchestrationCallbacks, OrchestrationOutcome } from './buddyOrchestrator';
import { buddyOrchestrator } from './buddyOrchestrator';

export const suryaOrchestrator = buddyOrchestrator;

