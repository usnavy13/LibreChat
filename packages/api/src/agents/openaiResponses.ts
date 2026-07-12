import type { TOpenAIReplayItem, TOpenAIResponsesState } from 'librechat-data-provider';

export const OPENAI_RESPONSES_STATE_LIMIT: number = 1024 * 1024;

function sanitizeReasoningItem(item: Record<string, unknown>): TOpenAIReplayItem | null {
  if (item.type !== 'reasoning' || typeof item.id !== 'string') {
    return null;
  }
  const summary = Array.isArray(item.summary)
    ? item.summary.flatMap((part) =>
        typeof part === 'object' &&
        part != null &&
        'type' in part &&
        part.type === 'summary_text' &&
        'text' in part &&
        typeof part.text === 'string'
          ? [{ type: 'summary_text' as const, text: part.text }]
          : [],
      )
    : undefined;
  const content = Array.isArray(item.content)
    ? item.content.flatMap((part) =>
        typeof part === 'object' &&
        part != null &&
        'type' in part &&
        part.type === 'reasoning_text' &&
        'text' in part &&
        typeof part.text === 'string'
          ? [{ type: 'reasoning_text' as const, text: part.text }]
          : [],
      )
    : undefined;
  const status =
    item.status === 'in_progress' || item.status === 'completed' || item.status === 'incomplete'
      ? item.status
      : undefined;
  return {
    type: 'reasoning',
    id: item.id,
    ...(summary && { summary }),
    ...(content && { content }),
    ...(typeof item.encrypted_content === 'string' && {
      encrypted_content: item.encrypted_content,
    }),
    ...(item.encrypted_content === null && { encrypted_content: null }),
    ...(status && { status }),
  };
}

export function sanitizeOpenAIReplayItem(item: unknown): TOpenAIReplayItem | null {
  if (typeof item !== 'object' || item == null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const reasoning = sanitizeReasoningItem(record);
  if (reasoning) {
    return reasoning;
  }
  if (
    record.type === 'program' &&
    typeof record.id === 'string' &&
    typeof record.call_id === 'string' &&
    typeof record.code === 'string' &&
    typeof record.fingerprint === 'string'
  ) {
    return {
      type: 'program',
      id: record.id,
      call_id: record.call_id,
      code: record.code,
      fingerprint: record.fingerprint,
    };
  }
  if (
    record.type === 'program_output' &&
    typeof record.id === 'string' &&
    typeof record.call_id === 'string' &&
    typeof record.result === 'string' &&
    (record.status === 'completed' || record.status === 'incomplete')
  ) {
    return {
      type: 'program_output',
      id: record.id,
      call_id: record.call_id,
      result: record.result,
      status: record.status,
    };
  }
  if (
    record.type === 'function_call' &&
    typeof record.call_id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.arguments === 'string' &&
    typeof record.caller === 'object' &&
    record.caller != null &&
    'type' in record.caller &&
    record.caller.type === 'program' &&
    'caller_id' in record.caller &&
    typeof record.caller.caller_id === 'string'
  ) {
    const status =
      record.status === 'in_progress' ||
      record.status === 'completed' ||
      record.status === 'incomplete'
        ? record.status
        : undefined;
    return {
      type: 'function_call',
      call_id: record.call_id,
      name: record.name,
      arguments: record.arguments,
      caller: {
        type: 'program',
        caller_id: record.caller.caller_id,
      },
      ...(typeof record.id === 'string' && { id: record.id }),
      ...(typeof record.namespace === 'string' && { namespace: record.namespace }),
      ...(status && { status }),
    };
  }
  return null;
}

function getStateSize(output: TOpenAIReplayItem[]): number {
  return Buffer.byteLength(JSON.stringify(output), 'utf8');
}

function compactReasoning(output: TOpenAIReplayItem[], limit: number): TOpenAIReplayItem[] {
  const withoutSummaries = output.map((item) => {
    if (item.type !== 'reasoning') {
      return item;
    }
    const compacted = { ...item };
    delete compacted.summary;
    return compacted;
  });
  if (getStateSize(withoutSummaries) <= limit) {
    return withoutSummaries;
  }
  return withoutSummaries.map((item) => {
    if (item.type !== 'reasoning' || !item.encrypted_content) {
      return item;
    }
    const compacted = { ...item };
    delete compacted.content;
    return compacted;
  });
}

type ReplayGroup = {
  firstIndex: number;
  priority: number;
  indexes: number[];
};

function getReplayGroups(output: TOpenAIReplayItem[]): ReplayGroup[] {
  const groups = new Map<string, ReplayGroup>();
  for (let index = 0; index < output.length; index++) {
    const item = output[index];
    let programCallId: string | undefined;
    if (item.type === 'function_call') {
      programCallId = item.caller.caller_id;
    } else if (item.type === 'program' || item.type === 'program_output') {
      programCallId = item.call_id;
    }
    const key = programCallId ? `program:${programCallId}` : `reasoning:${index}`;
    const hasEncryptedReasoning =
      item.type === 'reasoning' &&
      typeof item.encrypted_content === 'string' &&
      item.encrypted_content.length > 0;
    const priority = programCallId != null || hasEncryptedReasoning ? 0 : 1;
    const group = groups.get(key);
    if (group) {
      group.indexes.push(index);
      group.priority = Math.min(group.priority, priority);
      continue;
    }
    groups.set(key, {
      firstIndex: index,
      priority,
      indexes: [index],
    });
  }
  return [...groups.values()].sort(
    (left, right) => left.priority - right.priority || left.firstIndex - right.firstIndex,
  );
}

function fitReplayItems(
  output: TOpenAIReplayItem[],
  limit: number,
): { output: TOpenAIReplayItem[]; truncated: boolean } {
  let compacted = output;
  let truncated = false;
  if (getStateSize(compacted) > limit) {
    compacted = compactReasoning(compacted, limit);
    truncated = true;
  }
  if (getStateSize(compacted) <= limit) {
    return { output: compacted, truncated };
  }

  const selected = new Set<number>();
  for (const group of getReplayGroups(compacted)) {
    const proposed = new Set([...selected, ...group.indexes]);
    const nextOutput = compacted.filter((_, index) => proposed.has(index));
    if (getStateSize(nextOutput) <= limit) {
      for (const index of group.indexes) {
        selected.add(index);
      }
    } else {
      truncated = true;
    }
  }
  return {
    output: compacted.filter((_, index) => selected.has(index)),
    truncated,
  };
}

export function collectOpenAIResponsesState(
  state: TOpenAIResponsesState,
  responseMetadata: unknown,
  limit: number = OPENAI_RESPONSES_STATE_LIMIT,
): boolean {
  if (typeof responseMetadata !== 'object' || responseMetadata == null) {
    return false;
  }
  const metadata = responseMetadata as Record<string, unknown>;
  if (typeof metadata.id === 'string') {
    state.responseId = metadata.id;
  }
  if (!Array.isArray(metadata.output)) {
    return false;
  }
  const replayItems = metadata.output.flatMap((item) => {
    const replayItem = sanitizeOpenAIReplayItem(item);
    return replayItem ? [replayItem] : [];
  });
  const fitted = fitReplayItems([...state.output, ...replayItems], limit);
  state.output = fitted.output;
  if (fitted.truncated) {
    state.truncated = true;
  }
  return fitted.truncated;
}
