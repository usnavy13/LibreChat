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

  it('retains encrypted reasoning before optional reasoning', () => {
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
        ],
      },
      460,
    );

    expect(truncated).toBe(true);
    expect(state.responseId).toBe('resp_1');
    expect(state.output.map((item) => item.type)).toEqual(['reasoning', 'reasoning']);
    expect(state.output[0]).toEqual({
      type: 'reasoning',
      id: 'rs_optional',
    });
    expect(state.output[1]).toEqual({
      type: 'reasoning',
      id: 'rs_encrypted',
      encrypted_content: 'encrypted',
    });
    expect(state.truncated).toBe(true);
  });

  it('drops oversized optional reasoning', () => {
    const state: TOpenAIResponsesState = { output: [] };
    collectOpenAIResponsesState(
      state,
      {
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{ type: 'summary_text', text: 'x'.repeat(2_000) }],
            content: [{ type: 'reasoning_text', text: 'y'.repeat(2_000) }],
          },
        ],
      },
      300,
    );

    expect(state.output).toEqual([]);
    expect(state.truncated).toBe(true);
  });
});
