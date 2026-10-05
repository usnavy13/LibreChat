import { FileContext, FileSources } from 'librechat-data-provider';
import type {
  TFile,
  TFileConfig,
  TurnFileConsumers,
  TFileReadingNotice,
  TurnDeliveryRouting,
} from 'librechat-data-provider';
import type { BuildTurnReadingContextParams, TurnReadingContext } from './turn';
import type { CodeFileAgent } from '~/files/code/queued';
import type { ReadingAgent } from './inventory';
import type { NoticedFile } from './notices';
import {
  withReadingNotices,
  stripReadingNotices,
  buildUserMessageFiles,
  refreshUserMessageReading,
  persistResumedReadingNotices,
  buildResumedUserMessageFiles,
} from './notices';
import { buildTurnReadingContext, getTurnReadingContext, recordNativeRejections } from './turn';
import { resolveTurnDeliveryRouting } from '~/agents/files/delivery';
import { prepareAgentFileContext } from './inventory';
import { buildMessageFiles } from '~/utils/message';

type EndpointFileConfigInput = NonNullable<TFileConfig['endpoints']>[string];

const MB = 1024 * 1024;
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PARQUET = 'application/vnd.apache.parquet';

const AUTOMATIC: EndpointFileConfigInput = { llmDeliveryPolicy: 'automatic' };
const RUNS_CODE: TurnFileConsumers = { executeCode: true, fileSearch: false };
const SEARCHES: TurnFileConsumers = { executeCode: false, fileSearch: true };
const NO_READER: TurnFileConsumers = { executeCode: false, fileSearch: false };

const LIVE_CODE_REF = {
  codeEnvRefs: {
    default: {
      kind: 'user' as const,
      id: 'user-1',
      storage_session_id: 'store',
      file_id: 'remote',
    },
  },
};

const attachment = (overrides: Partial<TFile> & Pick<TFile, 'file_id' | 'filename'>): TFile => ({
  user: 'user-1',
  object: 'file',
  filepath: `/uploads/user-1/${overrides.filename}`,
  type: XLSX,
  bytes: 2048,
  embedded: false,
  usage: 0,
  source: FileSources.local,
  context: FileContext.message_attachment,
  llmDeliveryPath: 'none',
  metadata: { destinationChosen: false },
  ...overrides,
});

const pdfAttachment = (overrides: Partial<TFile> = {}): TFile =>
  attachment({
    file_id: 'brief',
    filename: 'brief.pdf',
    type: PDF,
    llmDeliveryPath: 'provider',
    ...overrides,
  });

interface AgentSetup {
  provider?: string;
  files?: TFile[];
  consumers?: TurnFileConsumers;
  endpointConfig?: EndpointFileConfigInput;
  /** Absent leaves the agent without a provision state, as a failed provisioning does. */
  codeEnvFiles?: TFile[];
  vectorDBFiles?: TFile[];
  reading?: Partial<BuildTurnReadingContextParams>;
}

type TestAgent = CodeFileAgent & ReadingAgent & { deliveryRouting: TurnDeliveryRouting };

/**
 * An initialized agent whose code files are planned and inventory rendered, as initialization
 * leaves it before the user message is saved.
 */
function preparedAgent({
  provider = 'openAI',
  files = [],
  consumers = NO_READER,
  endpointConfig = AUTOMATIC,
  codeEnvFiles,
  vectorDBFiles = [],
  reading,
}: AgentSetup = {}): TestAgent {
  const routing = resolveTurnDeliveryRouting({
    agent: { provider, endpoint: provider },
    config: { fileConfig: { endpoints: { [provider]: endpointConfig } } },
  });
  const context = buildTurnReadingContext({
    routing,
    provider,
    model: 'gpt-4o',
    fileTokenLimit: 100_000,
    configuredFileSizeLimit: undefined,
    countTokens: (text) => text.length,
    ...reading,
  });
  if (context != null) {
    routing.reading = context;
  }
  const provisioned = codeEnvFiles != null || vectorDBFiles.length > 0;
  const agent: TestAgent = {
    id: 'agent-1',
    deliveryRouting: routing,
    fileConsumers: consumers,
    currentRequestAttachments: files,
    provisionState: provisioned
      ? {
          codeEnvFiles: codeEnvFiles ?? [],
          vectorDBFiles,
          aliveFileIds: new Set<string>(),
          agentScopedFileIds: new Set<string>(),
        }
      : undefined,
  };
  prepareAgentFileContext(agent, [agent], 'user-1');
  return agent;
}

function readingContextOf(agent: TestAgent): TurnReadingContext {
  const context = getTurnReadingContext(agent.deliveryRouting);
  if (context == null) {
    throw new Error('expected a turn reading context');
  }
  return context;
}

const noticesOf = (
  files: ReadonlyArray<TFile | NoticedFile>,
): Array<TFileReadingNotice | undefined> => files.map((file) => file.reading);

/** The notice the request's only attachment carries. */
function noticeFor(setup: AgentSetup & { files: [TFile] }): TFileReadingNotice | undefined {
  const agent = preparedAgent(setup);
  return withReadingNotices(setup.files, agent)[0]?.reading;
}

describe('withReadingNotices', () => {
  describe('under the classic policy', () => {
    it('returns the attachments it was given', () => {
      const files = [pdfAttachment()];
      const agent = preparedAgent({ files, endpointConfig: {} });

      expect(getTurnReadingContext(agent.deliveryRouting)).toBeUndefined();
      expect(withReadingNotices(files, agent)).toBe(files);
    });

    it('returns them with a derive-only reading context too', () => {
      const files = [pdfAttachment()];
      const agent = preparedAgent({
        files,
        endpointConfig: {},
        reading: { deriveText: jest.fn() },
      });

      expect(readingContextOf(agent).policy).toBe('classic');
      expect(withReadingNotices(files, agent)).toBe(files);
    });

    it('returns them without an agent, and nothing without attachments', () => {
      const files = [pdfAttachment()];

      expect(withReadingNotices(files, undefined)).toBe(files);
      expect(withReadingNotices(files, null)).toBe(files);
      expect(withReadingNotices(undefined, null)).toEqual([]);
    });
  });

  describe('the reader each request attachment is shown with', () => {
    it('shows a document sent to the model without a limitation', () => {
      expect(noticeFor({ files: [pdfAttachment()] })).toEqual({ reader: 'provider' });
    });

    it('shows a spreadsheet queued for Run Code', () => {
      const workbook = attachment({ file_id: 'q3', filename: 'Q3.xlsx' });

      expect(
        noticeFor({ files: [workbook], consumers: RUNS_CODE, codeEnvFiles: [workbook] }),
      ).toEqual({ reader: 'code' });
    });

    it('shows a spreadsheet already in the code environment', () => {
      const workbook = attachment({
        file_id: 'q2',
        filename: 'Q2.xlsx',
        metadata: { destinationChosen: false, ...LIVE_CODE_REF },
      });

      expect(noticeFor({ files: [workbook], consumers: RUNS_CODE, codeEnvFiles: [] })).toEqual({
        reader: 'code',
      });
    });

    it('never shows Run Code as the reader of a file it could not be prepared for', () => {
      const workbook = attachment({ file_id: 'q1', filename: 'Q1.xlsx' });

      expect(noticeFor({ files: [workbook], consumers: RUNS_CODE })).toEqual({
        reader: 'unavailable',
        limitation: 'not_prepared',
      });
    });

    it('shows complete text without a limitation where the model cannot take the type', () => {
      const docx = attachment({
        file_id: 'notes',
        filename: 'notes.docx',
        type: DOCX,
        text: 'Board notes',
        llmDeliveryPath: 'text',
      });

      expect(noticeFor({ files: [docx] })).toEqual({ reader: 'text' });
    });
  });

  describe('the limitation each reading reason maps to', () => {
    it('code_unavailable: spreadsheet text read without Run Code', () => {
      const workbook = attachment({
        file_id: 'q4',
        filename: 'Q4.xlsx',
        text: 'Q4,1200',
        llmDeliveryPath: 'text',
      });

      expect(noticeFor({ files: [workbook] })).toEqual({
        reader: 'text',
        limitation: 'code_unavailable',
      });
    });

    it('code_unavailable: a spreadsheet nothing can read', () => {
      const parquet = attachment({ file_id: 'data', filename: 'data.parquet', type: PARQUET });

      expect(noticeFor({ files: [parquet], consumers: SEARCHES })).toEqual({
        reader: 'unavailable',
        limitation: 'code_unavailable',
      });
    });

    it('native_capacity: a document too large to send, left to File Search', () => {
      const pdf = pdfAttachment({ bytes: 5 * MB });

      expect(
        noticeFor({
          files: [pdf],
          consumers: SEARCHES,
          vectorDBFiles: [pdf],
          reading: { configuredFileSizeLimit: MB },
        }),
      ).toEqual({ reader: 'search', limitation: 'too_large_direct' });
    });

    it('native_capacity: a document too large to send with no other reader', () => {
      const pdf = pdfAttachment({ bytes: 5 * MB });

      expect(noticeFor({ files: [pdf], reading: { configuredFileSizeLimit: MB } })).toEqual({
        reader: 'unavailable',
        limitation: 'too_large_direct',
      });
    });

    it('text_exceeds: text too long to include, left to File Search', () => {
      const log = attachment({
        file_id: 'huge',
        filename: 'huge.log',
        type: 'text/plain',
        text: 'x'.repeat(64),
        llmDeliveryPath: 'text',
      });

      expect(
        noticeFor({ files: [log], consumers: SEARCHES, reading: { fileTokenLimit: 10 } }),
      ).toEqual({ reader: 'search', limitation: 'text_too_long' });
    });

    it('aggregate_overflow: a document that did not fit with the others', () => {
      const pdf = pdfAttachment();
      const agent = preparedAgent({ files: [pdf], consumers: SEARCHES });
      readingContextOf(agent).addOverflow([pdf.file_id]);

      expect(noticesOf(withReadingNotices([pdf], agent))).toEqual([
        { reader: 'search', limitation: 'too_large_together' },
      ]);
    });

    it('native_rejected: a capacity rejection names the size, with another reader or none', () => {
      const pdf = pdfAttachment();
      const searched = preparedAgent({ files: [pdf], consumers: SEARCHES });
      const unread = preparedAgent({ files: [pdf] });
      recordNativeRejections([searched, unread], [{ file_id: pdf.file_id, reason: 'capacity' }]);

      expect(noticesOf(withReadingNotices([pdf], searched))).toEqual([
        { reader: 'search', limitation: 'too_large_direct' },
      ]);
      expect(noticesOf(withReadingNotices([pdf], unread))).toEqual([
        { reader: 'unavailable', limitation: 'too_large_direct' },
      ]);
    });

    it('native_rejected: a file that could not be opened says so only when nothing read it', () => {
      const pdf = pdfAttachment();
      const searched = preparedAgent({ files: [pdf], consumers: SEARCHES });
      const unread = preparedAgent({ files: [pdf] });
      recordNativeRejections([searched, unread], [{ file_id: pdf.file_id, reason: 'integrity' }]);

      expect(noticesOf(withReadingNotices([pdf], searched))).toEqual([{ reader: 'search' }]);
      expect(noticesOf(withReadingNotices([pdf], unread))).toEqual([
        { reader: 'unavailable', limitation: 'not_prepared' },
      ]);
    });

    it('text_unavailable: a document no available tool can read', () => {
      const docx = attachment({ file_id: 'memo', filename: 'memo.docx', type: DOCX });

      expect(noticeFor({ files: [docx] })).toEqual({
        reader: 'unavailable',
        limitation: 'no_reader',
      });
    });

    it.each([
      ['parser', 'not_prepared'],
      ['empty', 'not_prepared'],
      ['too_large', 'text_too_long'],
      ['expansion_limit', 'text_too_long'],
      ['no_extractor', 'no_reader'],
    ] as const)(
      'text_unavailable: a derivation failure (%s) names this file, not its type',
      (reason, limitation) => {
        const docx = attachment({
          file_id: 'memo',
          filename: 'memo.docx',
          type: DOCX,
          metadata: { destinationChosen: false, textDerivation: { outcome: 'failed', reason } },
        });

        expect(noticeFor({ files: [docx] })).toEqual({ reader: 'unavailable', limitation });
      },
    );

    it('text_unavailable: a derivation that failed on this request could not be prepared', () => {
      const docx = attachment({ file_id: 'memo', filename: 'memo.docx', type: DOCX });
      const agent = preparedAgent({ files: [docx], reading: { deriveText: jest.fn() } });
      readingContextOf(agent).markTextFailed(docx.file_id);
      prepareAgentFileContext(agent, [agent], 'user-1');

      expect(noticesOf(withReadingNotices([docx], agent))).toEqual([
        { reader: 'unavailable', limitation: 'not_prepared' },
      ]);
    });

    it('a spreadsheet nothing read names the missing analysis over its text length', () => {
      const csv = attachment({
        file_id: 'ledger',
        filename: 'ledger.csv',
        type: 'text/csv',
        text: 'x'.repeat(64),
        llmDeliveryPath: 'text',
      });

      expect(noticeFor({ files: [csv], reading: { fileTokenLimit: 10 } })).toEqual({
        reader: 'unavailable',
        limitation: 'code_unavailable',
      });
    });
  });

  describe('limitations the record itself explains', () => {
    it('says only extracted text was kept for a text-only record', () => {
      const textOnly = attachment({
        file_id: 'old',
        filename: 'old.xlsx',
        source: FileSources.text,
        text: 'Q1,1200',
        llmDeliveryPath: 'text',
      });

      expect(noticeFor({ files: [textOnly], consumers: RUNS_CODE, codeEnvFiles: [] })).toEqual({
        reader: 'text',
        limitation: 'text_only',
      });
    });

    describe('a text reading the configured route keeps classic', () => {
      const CONFIGURED_TEXT: EndpointFileConfigInput = {
        ...AUTOMATIC,
        defaultLLMDeliveryPath: { overrides: { 'text/plain': 'text' } },
      };
      const log = (text: string): TFile =>
        attachment({
          file_id: 'log',
          filename: 'run.log',
          type: 'text/plain',
          text,
          llmDeliveryPath: 'text',
        });

      it('says only the beginning fit when its text is over the limit', () => {
        expect(
          noticeFor({
            files: [log('x'.repeat(64))],
            endpointConfig: CONFIGURED_TEXT,
            reading: { fileTokenLimit: 10 },
          }),
        ).toEqual({ reader: 'text', limitation: 'text_truncated' });
      });

      it('names no limitation when all of its text fits', () => {
        expect(
          noticeFor({
            files: [log('short')],
            endpointConfig: CONFIGURED_TEXT,
            reading: { fileTokenLimit: 10 },
          }),
        ).toEqual({ reader: 'text' });
      });
    });

    it('says nothing about kept text when Run Code was not wanted', () => {
      const pasted = attachment({
        file_id: 'pasted',
        filename: 'pasted.txt',
        type: 'text/plain',
        source: FileSources.text,
        text: 'Pasted notes',
        llmDeliveryPath: 'text',
      });

      expect(noticeFor({ files: [pasted] })).toEqual({ reader: 'text' });
    });

    it('says the original is gone when its text could not be derived for that reason', () => {
      const workbook = attachment({
        file_id: 'lost',
        filename: 'lost.xlsx',
        metadata: {
          destinationChosen: false,
          textDerivation: { outcome: 'failed', reason: 'original_missing' },
        },
      });

      expect(noticeFor({ files: [workbook] })).toEqual({
        reader: 'unavailable',
        limitation: 'original_missing',
      });
    });
  });

  describe('classic provider records the encoder withheld', () => {
    const chosen = (overrides: Partial<TFile> = {}): TFile =>
      pdfAttachment({
        file_id: 'contract',
        filename: 'contract.pdf',
        metadata: { destinationChosen: true },
        ...overrides,
      });

    it('shows a chosen document that was sent as sent', () => {
      expect(noticeFor({ files: [chosen()], consumers: SEARCHES })).toEqual({ reader: 'provider' });
    });

    it.each([
      ['capacity', 'too_large_direct'],
      ['integrity', 'not_prepared'],
    ] as const)('never shows a document after a %s rejection as sent', (reason, limitation) => {
      const contract = chosen();
      const agent = preparedAgent({ files: [contract], consumers: SEARCHES });
      recordNativeRejections([agent], [{ file_id: contract.file_id, reason }]);

      expect(noticesOf(withReadingNotices([contract], agent))).toEqual([
        { reader: 'unavailable', limitation },
      ]);
    });

    it('never shows a chosen document the model cannot take as sent', () => {
      const docx = chosen({ filename: 'contract.docx', type: DOCX });

      expect(noticeFor({ files: [docx], consumers: SEARCHES, provider: 'anthropic' })).toEqual({
        reader: 'unavailable',
        limitation: 'no_reader',
      });
    });

    it('shows Run Code when it can still open a withheld document', () => {
      const contract = chosen({ metadata: { destinationChosen: true, ...LIVE_CODE_REF } });
      const agent = preparedAgent({ files: [contract], consumers: RUNS_CODE, codeEnvFiles: [] });
      recordNativeRejections([agent], [{ file_id: contract.file_id, reason: 'capacity' }]);

      expect(noticesOf(withReadingNotices([contract], agent))).toEqual([
        { reader: 'code', limitation: 'too_large_direct' },
      ]);
    });
  });

  describe('which files carry a notice', () => {
    it('appends a request file the endpoint refused, so it stays on the message', () => {
      const pdf = pdfAttachment();
      const agent = preparedAgent({ files: [pdf] });
      const scan = { file_id: 'scan', filename: 'scan.tiff', type: 'image/tiff', bytes: 9 * MB };
      readingContextOf(agent).recordDropped([scan]);

      expect(withReadingNotices([pdf], agent)).toEqual([
        { ...pdf, reading: { reader: 'provider' } },
        { ...scan, reading: { reader: 'unavailable', limitation: 'not_allowed' } },
      ]);
    });

    it('names the size limit when it alone refused a permitted type', () => {
      const agent = preparedAgent({ endpointConfig: { ...AUTOMATIC, fileSizeLimit: 1 } });
      const scan = { file_id: 'scan', filename: 'scan.png', type: 'image/png', bytes: 2 * MB };
      readingContextOf(agent).recordDropped([scan]);

      expect(noticesOf(withReadingNotices([], agent))).toEqual([
        { reader: 'unavailable', limitation: 'too_large_direct' },
      ]);
    });

    it('says a refused type is not allowed, however large', () => {
      const agent = preparedAgent({
        endpointConfig: { ...AUTOMATIC, fileSizeLimit: 1, supportedMimeTypes: ['^image/png$'] },
      });
      const scan = { file_id: 'scan', filename: 'scan.tiff', type: 'image/tiff', bytes: 2 * MB };
      readingContextOf(agent).recordDropped([scan]);

      expect(noticesOf(withReadingNotices([], agent))).toEqual([
        { reader: 'unavailable', limitation: 'not_allowed' },
      ]);
    });

    it('keeps a refused file on the message when it was the only attachment', () => {
      const agent = preparedAgent();
      const scan = { file_id: 'scan', filename: 'scan.tiff', type: 'image/tiff' };
      readingContextOf(agent).recordDropped([scan]);

      expect(withReadingNotices([], agent)).toEqual([
        { ...scan, reading: { reader: 'unavailable', limitation: 'not_allowed' } },
      ]);
    });

    it('lists a refused file once even when it is among the attachments', () => {
      const pdf = pdfAttachment();
      const scan = attachment({ file_id: 'scan', filename: 'scan.tiff', type: 'image/tiff' });
      const agent = preparedAgent({ files: [pdf] });
      readingContextOf(agent).recordDropped([scan]);

      const files = withReadingNotices([pdf, scan], agent);

      expect(files.map(({ file_id }) => file_id)).toEqual(['brief', 'scan']);
    });

    it('leaves files outside the current request alone', () => {
      const pdf = pdfAttachment();
      const earlier = pdfAttachment({ file_id: 'earlier', filename: 'earlier.pdf', bytes: 5 * MB });
      const agent = preparedAgent({
        files: [pdf],
        consumers: SEARCHES,
        vectorDBFiles: [earlier],
        reading: { configuredFileSizeLimit: MB },
      });
      expect(agent.dynamicToolContextMap?.file_inventory).toContain('earlier.pdf');

      const files = withReadingNotices([pdf, earlier], agent);

      expect(files).toHaveLength(2);
      expect(files[0].reading).toEqual({ reader: 'provider' });
      expect(files[1]).toBe(earlier);
    });

    it('returns the attachments as given when no request file is listed or refused', () => {
      const declined = attachment({
        file_id: 'chosen',
        filename: 'chosen.xlsx',
        metadata: { destinationChosen: true },
      });
      const files = [declined];
      const agent = preparedAgent({ files });

      expect(withReadingNotices(files, agent)).toBe(files);
      expect(withReadingNotices([], agent)).toEqual([]);
    });

    it('writes notices only onto copies, never onto the records', () => {
      const pdf = pdfAttachment();
      const workbook = attachment({ file_id: 'q1', filename: 'Q1.xlsx' });
      const files = [pdf, workbook];
      const before = structuredClone(files);
      const agent = preparedAgent({ files, consumers: SEARCHES });

      const noticed = withReadingNotices(files, agent);

      expect(files).toEqual(before);
      expect(noticed[0]).not.toBe(pdf);
      expect(noticed.every((file) => file.reading != null)).toBe(true);
      expect(pdf).not.toHaveProperty('reading');
      expect(agent.currentRequestAttachments?.[0]).not.toHaveProperty('reading');
    });
  });

  it('survives the message-file sanitizer, which strips only text and ids', () => {
    const reading: TFileReadingNotice = { reader: 'search', limitation: 'too_large_direct' };
    const pdf: TFile = { ...pdfAttachment({ text: 'extracted' }), _id: 'mongo-id', reading };

    const [saved] = buildMessageFiles([{ file_id: pdf.file_id }], [pdf]);

    expect(saved.reading).toEqual(reading);
    expect(saved).not.toHaveProperty('text');
    expect(saved).not.toHaveProperty('_id');
  });
});

describe('search preparation notices', () => {
  it('projects failure until successful retry, preserving the failed message after reload', () => {
    const pdf = pdfAttachment({ bytes: 15 * MB, llmDeliveryPath: 'none', text: 'cached text' });
    const agent = preparedAgent({ files: [pdf], consumers: SEARCHES, vectorDBFiles: [pdf] });
    const preparation = new Map<string, 'queued' | 'ready' | 'failed'>();
    readingContextOf(agent).setSearchEvidence({
      queued: [pdf.file_id],
      registered: [],
      preparation,
    });
    const refs = [{ file_id: pdf.file_id }];
    const message = { files: buildUserMessageFiles(refs, [pdf], agent) };
    expect(message.files[0].reading).toEqual({ reader: 'search', limitation: 'too_large_direct' });

    preparation.set(pdf.file_id, 'failed');
    refreshUserMessageReading(message, refs, { options: { attachments: [pdf], agent } });
    expect(message.files[0].reading).toEqual({ reader: 'unavailable', limitation: 'not_prepared' });
    expect(message.files[0]).not.toHaveProperty('text');
    expect(pdf).not.toHaveProperty('reading');

    const restored: typeof message.files = JSON.parse(JSON.stringify(message.files));
    const freshAgent = preparedAgent({ files: [pdf], consumers: SEARCHES, vectorDBFiles: [pdf] });
    expect(buildResumedUserMessageFiles(restored, [pdf], freshAgent)).toBe(restored);
    expect(restored[0].reading).toEqual({ reader: 'unavailable', limitation: 'not_prepared' });

    preparation.set(pdf.file_id, 'ready');
    refreshUserMessageReading(message, refs, { options: { attachments: [pdf], agent } });
    expect(message.files[0].reading).toEqual({ reader: 'search', limitation: 'too_large_direct' });
    expect(restored[0].reading).toEqual({ reader: 'unavailable', limitation: 'not_prepared' });
  });

  it('does not rewrite legacy, missing, or unmatched message files', () => {
    const pdf = pdfAttachment();
    const existing = [{ file_id: 'unmatched' }];
    const message = { files: existing };
    const classic = preparedAgent({ files: [pdf], endpointConfig: {} });
    refreshUserMessageReading(message, [{ file_id: pdf.file_id }], {
      options: { attachments: [pdf], agent: classic },
    });
    expect(message.files).toBe(existing);
    refreshUserMessageReading(message, existing, {
      options: { attachments: [pdf], agent: preparedAgent({ files: [pdf] }) },
    });
    expect(message.files).toBe(existing);
    refreshUserMessageReading(message, undefined, undefined);
    refreshUserMessageReading(undefined, existing, undefined);
    expect(message.files).toBe(existing);
  });

  it('persists a resumed search failure before exposing the files, and recovers only on success', async () => {
    const pdf = pdfAttachment({ bytes: 15 * MB, llmDeliveryPath: 'none', text: 'cached text' });
    const agent = preparedAgent({ files: [pdf], consumers: SEARCHES, vectorDBFiles: [pdf] });
    const preparation = new Map<string, 'queued' | 'ready' | 'failed'>([[pdf.file_id, 'failed']]);
    agent.provisionState!.searchPreparation = preparation;
    readingContextOf(agent).setSearchEvidence({
      queued: [pdf.file_id],
      registered: [],
      preparation,
    });
    const saved = buildUserMessageFiles([{ file_id: pdf.file_id }], [pdf], agent).map((file) => ({
      ...file,
      reading: { reader: 'search' as const, limitation: 'too_large_direct' as const },
    }));
    const unmatched = { file_id: 'unmatched', reading: { reader: 'provider' as const } };
    const refs = [...saved, unmatched];
    let finishWrite: () => void = () => {};
    const write = new Promise<object>((resolve) => {
      finishWrite = () => resolve({ messageId: 'user-row' });
    });
    const updateMessage = jest.fn(() => write);
    let published = false;
    const persisted = persistResumedReadingNotices(
      { userId: 'user-1', messageId: 'user-row', requestFiles: refs, agent },
      { updateMessage },
    ).then((files) => {
      published = true;
      return files;
    });
    await Promise.resolve();

    expect(published).toBe(false);
    expect(updateMessage).toHaveBeenCalledWith(
      'user-1',
      {
        messageId: 'user-row',
        files: [
          { ...saved[0], reading: { reader: 'unavailable', limitation: 'not_prepared' } },
          unmatched,
        ],
      },
      { context: 'resumed user file reading' },
    );
    finishWrite();
    const failed = await persisted;
    expect(failed?.[0].reading).toEqual({ reader: 'unavailable', limitation: 'not_prepared' });
    expect(failed?.[1]).toBe(unmatched);
    expect(refs[0].reading.reader).toBe('search');
    const restored: NonNullable<typeof failed> = JSON.parse(JSON.stringify(failed));
    expect(buildResumedUserMessageFiles(restored, [pdf], agent)[0].reading).toEqual({
      reader: 'unavailable',
      limitation: 'not_prepared',
    });

    preparation.set(pdf.file_id, 'ready');
    const recovered = await persistResumedReadingNotices(
      { userId: 'user-1', messageId: 'user-row', requestFiles: restored, agent },
      { updateMessage: jest.fn().mockResolvedValue({}) },
    );
    expect(recovered?.[0].reading).toEqual({ reader: 'search', limitation: 'too_large_direct' });
    expect(restored[0].reading).toEqual({ reader: 'unavailable', limitation: 'not_prepared' });
    expect(recovered?.[0]).not.toHaveProperty('text');
  });

  it('leaves delivered text, native files, and queued search notices unchanged on resume', async () => {
    const pdf = pdfAttachment({ bytes: 15 * MB, llmDeliveryPath: 'none' });
    const agent = preparedAgent({ files: [pdf], consumers: SEARCHES, vectorDBFiles: [pdf] });
    const preparation = new Map<string, 'queued' | 'ready' | 'failed'>([[pdf.file_id, 'failed']]);
    agent.provisionState!.searchPreparation = preparation;
    readingContextOf(agent).setSearchEvidence({
      queued: [pdf.file_id],
      registered: [],
      preparation,
    });
    const updateMessage = jest.fn().mockResolvedValue({});
    for (const reader of ['provider', 'text'] as const) {
      const refs = [{ file_id: pdf.file_id, reading: { reader } }];
      expect(
        await persistResumedReadingNotices(
          { userId: 'user-1', messageId: 'user-row', requestFiles: refs, agent },
          { updateMessage },
        ),
      ).toBe(refs);
      expect(buildResumedUserMessageFiles(refs, [pdf], agent)).toBe(refs);
    }
    preparation.set(pdf.file_id, 'queued');
    const refs = [{ file_id: pdf.file_id, reading: { reader: 'search' as const } }];
    expect(
      await persistResumedReadingNotices(
        { userId: 'user-1', messageId: 'user-row', requestFiles: refs, agent },
        { updateMessage },
      ),
    ).toBe(refs);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('propagates a resumed notice persistence failure without returning successful files', async () => {
    const pdf = pdfAttachment({ bytes: 15 * MB, llmDeliveryPath: 'none' });
    const agent = preparedAgent({ files: [pdf], consumers: SEARCHES, vectorDBFiles: [pdf] });
    const preparation = new Map([[pdf.file_id, 'failed' as const]]);
    agent.provisionState!.searchPreparation = preparation;
    readingContextOf(agent).setSearchEvidence({
      queued: [pdf.file_id],
      registered: [],
      preparation,
    });
    const error = new Error('storage unavailable');
    await expect(
      persistResumedReadingNotices(
        {
          userId: 'user-1',
          messageId: 'user-row',
          requestFiles: [{ file_id: pdf.file_id, reading: { reader: 'search' } }],
          agent,
        },
        { updateMessage: jest.fn().mockRejectedValue(error) },
      ),
    ).rejects.toBe(error);
  });
});

describe('buildUserMessageFiles', () => {
  const pdf: TFile = { ...pdfAttachment({ text: 'extracted' }), _id: 'mongo-id' };
  const scan = { file_id: 'scan', filename: 'scan.tiff', type: 'image/tiff', bytes: 4096 };
  const requestFiles = [{ file_id: pdf.file_id }, { file_id: scan.file_id }];

  it('saves the request files with their notices, sanitized, refused ones included', () => {
    const agent = preparedAgent({ files: [pdf] });
    readingContextOf(agent).recordDropped([scan]);

    const files = buildUserMessageFiles(requestFiles, [pdf], agent);

    const { text: _text, _id: _mongoId, ...saved } = pdf;
    expect(files).toEqual([
      { ...saved, reading: { reader: 'provider' } },
      { ...scan, reading: { reader: 'unavailable', limitation: 'not_allowed' } },
    ]);
  });

  it('saves only the attached request files under the classic policy', () => {
    const agent = preparedAgent({ files: [pdf], endpointConfig: {} });

    const files = buildUserMessageFiles(requestFiles, [pdf], agent);

    expect(files).toEqual(buildMessageFiles(requestFiles, [pdf]));
    expect(files[0]).not.toHaveProperty('reading');
  });
});

describe('stripReadingNotices', () => {
  it('drops the notice an earlier turn saved from each replayed ref', () => {
    const replayed = [
      { file_id: 'book', filename: 'book.xlsx', reading: { reader: 'code' as const } },
      { file_id: 'brief', filename: 'brief.pdf' },
    ];

    const files = stripReadingNotices(replayed);

    expect(files).toEqual([
      { file_id: 'book', filename: 'book.xlsx' },
      { file_id: 'brief', filename: 'brief.pdf' },
    ]);
    expect(files[1]).toBe(replayed[1]);
    expect(replayed[0]).toHaveProperty('reading');
  });

  it('returns the refs themselves when none carries a notice', () => {
    const refs = [{ file_id: 'brief' }, { file_id: 'book' }];
    expect(stripReadingNotices(refs)).toBe(refs);
  });

  it('returns a body without files unchanged', () => {
    expect(stripReadingNotices(undefined)).toBeUndefined();
  });
});

describe('buildResumedUserMessageFiles', () => {
  const pdf = pdfAttachment();

  it('keeps the files restored from the saved user row, which carry the notices', () => {
    const restored = [{ file_id: pdf.file_id, reading: { reader: 'provider' as const } }];
    expect(buildResumedUserMessageFiles(restored, [pdf], preparedAgent({ files: [pdf] }))).toBe(
      restored,
    );
  });

  it('rebuilds the notices from the resumed client when the refs carry none', () => {
    const files = buildResumedUserMessageFiles(
      [{ file_id: pdf.file_id }],
      [pdf],
      preparedAgent({ files: [pdf] }),
    );
    expect(files).toEqual([{ ...pdf, reading: { reader: 'provider' } }]);
  });

  it('keeps the request refs as they are under the classic policy', () => {
    const refs = [{ file_id: pdf.file_id }];
    const agent = preparedAgent({ files: [pdf], endpointConfig: {} });
    expect(buildResumedUserMessageFiles(refs, [pdf], agent)).toBe(refs);
  });

  it('keeps the refs when the resumed client holds no matching attachment', () => {
    const refs = [{ file_id: pdf.file_id }];
    expect(buildResumedUserMessageFiles(refs, undefined, null)).toBe(refs);
    expect(buildResumedUserMessageFiles(refs, [], null)).toBe(refs);
  });
});
