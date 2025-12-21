import { atom } from 'recoil';

/**
 * Python session state info
 */
export interface PythonSessionState {
  session_id: string;
  hasState: boolean;
  bytes?: number;
  hash?: string;
}

/**
 * Map of conversationId to Python session state
 * Used to track Python session state for each conversation
 */
export const pythonSessionStateMap = atom<Record<string, PythonSessionState | null>>({
  key: 'pythonSessionStateMap',
  default: {},
});
