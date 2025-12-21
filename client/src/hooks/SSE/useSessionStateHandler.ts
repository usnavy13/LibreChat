import { useSetRecoilState } from 'recoil';
import type { EventSubmission } from 'librechat-data-provider';
import { pythonSessionStateMap } from '~/store/pythonSession';
import type { PythonSessionState } from '~/store/pythonSession';

interface SessionStateData {
  session_id: string;
  hasState: boolean;
  bytes?: number;
  hash?: string;
}

/**
 * Hook to handle session_state SSE events and update the Recoil atom
 */
export default function useSessionStateHandler() {
  const setSessionStateMap = useSetRecoilState(pythonSessionStateMap);

  return ({ data, submission }: { data: SessionStateData; submission: EventSubmission }) => {
    const conversationId = submission.conversation?.conversationId;

    if (!data.session_id || !conversationId) {
      return;
    }

    const sessionState: PythonSessionState = {
      session_id: data.session_id,
      hasState: data.hasState,
      bytes: data.bytes,
      hash: data.hash,
    };

    setSessionStateMap((prevMap) => ({
      ...prevMap,
      [conversationId]: sessionState,
    }));
  };
}
