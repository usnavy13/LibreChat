import type { TOpenAIResponsesState } from 'librechat-data-provider';
import { collectOpenAIResponsesState, sanitizeOpenAIReplayItem } from './openaiResponses';

describe('OpenAI Responses replay state', () => {
  it('sanitizes replay items and nested reasoning content', () => {
    expect(
      sanitizeOpenAIReplayItem({
        type: 'reasoning',
        id: 'rs_1',
        summary: [
          { type: 'summary_text', text: 'kept', secret: 'removed' },
          { type: 'unsupported', text: 'removed' },
        ],
        content: [{ type: 'reasoning_text', text: 'kept', secret: 'removed' }],
        encrypted_content: 'encrypted',
        unknown: 'removed',
      }),
    ).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'kept' }],
      content: [{ type: 'reasoning_text', text: 'kept' }],
      encrypted_content: 'encrypted',
    });
  });

  it('retains encrypted reasoning and complete program linkage before optional reasoning', () => {
    const state: TOpenAIResponsesState = { output: [] };
    const truncated = collectOpenAIResponsesState(
      state,
      {
        id: 'resp_1',
        output: [
          {
            type: 'reasoning',
            id: 'rs_optional',
            summary: [{ type: 'summary_text', text: 'x'.repeat(2_000) }],
          },
          {
            type: 'reasoning',
            id: 'rs_encrypted',
            summary: [{ type: 'summary_text', text: 'y'.repeat(2_000) }],
            content: [{ type: 'reasoning_text', text: 'z'.repeat(2_000) }],
            encrypted_content: 'encrypted',
          },
          {
            type: 'program',
            id: 'prog_1',
            call_id: 'program_call_1',
            code: 'await tools.lookup({})',
            fingerprint: 'fingerprint',
          },
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '{}',
            caller: { type: 'program', caller_id: 'program_call_1' },
          },
          {
            type: 'program_output',
            id: 'po_1',
            call_id: 'program_call_1',
            result: '{"ok":true}',
            status: 'completed',
          },
        ],
      },
      460,
    );

    expect(truncated).toBe(true);
    expect(state.responseId).toBe('resp_1');
    expect(state.output.map((item) => item.type)).toEqual([
      'reasoning',
      'program',
      'function_call',
      'program_output',
    ]);
    expect(state.output[0]).toEqual({
      type: 'reasoning',
      id: 'rs_encrypted',
      encrypted_content: 'encrypted',
    });
    expect(state.truncated).toBe(true);
  });

  it('drops an oversized program chain atomically', () => {
    const state: TOpenAIResponsesState = { output: [] };
    collectOpenAIResponsesState(
      state,
      {
        output: [
          {
            type: 'program',
            id: 'prog_1',
            call_id: 'program_call_1',
            code: 'x'.repeat(2_000),
            fingerprint: 'fingerprint',
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '{}',
            caller: { type: 'program', caller_id: 'program_call_1' },
          },
          {
            type: 'program_output',
            id: 'po_1',
            call_id: 'program_call_1',
            result: '{}',
            status: 'completed',
          },
        ],
      },
      300,
    );

    expect(state.output).toEqual([]);
    expect(state.truncated).toBe(true);
  });
});
