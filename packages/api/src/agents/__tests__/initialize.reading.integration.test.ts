import os from 'os';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { Providers } from '@librechat/agents';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import {
  Tools,
  FileContext,
  FileSources,
  EModelEndpoint,
  decideFileReading,
} from 'librechat-data-provider';
import type { AppConfig, IMongoFile } from '@librechat/data-schemas';
import type { Agent, TextDerivation } from 'librechat-data-provider';
import type { LCTool } from '@librechat/agents';
import type { ProvisionService } from '~/files/provision/service';
import type { InitializeAgentDbMethods } from '../initialize';
import type { ServerRequest } from '~/types';
import { getTurnReadingContext, createFileTextDeriver } from '~/files/reading';
import * as modelBoundContent from '../../middleware/modelBoundContent';
import { extractFileContext } from '~/files/context';
import { initializeAgent } from '../initialize';
import * as attachments from '../attachments';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET_TEXT = 'Quarter,Total\nQ1,1200\nQ2,1400\nSENTINEL-7F3A';
const SKILL_NAME = 'spreadsheet-analysis';
const SAMPLE_XLSX = path.join(__dirname, '../../files/documents/sample.xlsx');
const SAMPLE_TEXT = 'Sheet One:\nData,on,first,sheet\nSecond Sheet:\nData,On\nSecond,Sheet\n';

type FileConfigInput = NonNullable<AppConfig['fileConfig']>;
type OpenStoredFile = ProvisionService['openStoredFile'];
type RoutingFields = Pick<IMongoFile, 'llmDeliveryPath' | 'text' | 'type' | 'bytes' | 'metadata'>;

interface TurnOptions {
  fileIds: string[];
  policy?: 'automatic';
  tools?: string[];
  /** Tools the loader returns definitions for; Run Code registers itself when enabled. */
  loaded?: string[];
  /** Tools a manual skill contributes on top of the agent's own. */
  skillTools?: string[];
  fileConfig?: Omit<FileConfigInput, 'endpoints'>;
  endpointConfig?: { fileSizeLimit?: number };
  checkSessionsAlive?: InitializeAgentDbMethods['checkSessionsAlive'];
  /** Wires the request's text deriver over this storage, as the host does. */
  openStoredFile?: OpenStoredFile;
}

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let userId: string;
let storageRoot: string;
const originalApiKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-integration-'));
  process.env.OPENAI_API_KEY = 'sk-reading-integration';
}, 60000);

afterAll(async () => {
  process.env.OPENAI_API_KEY = originalApiKey;
  fs.rmSync(storageRoot, { recursive: true, force: true });
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  userId = new mongoose.Types.ObjectId().toString();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await mongoose.connection.db?.dropDatabase();
});

const baseFile = (fileId: string) => ({
  file_id: fileId,
  user: new mongoose.Types.ObjectId(userId),
  object: 'file' as const,
  source: FileSources.local,
  context: FileContext.message_attachment,
  usage: 0,
});

/** A spreadsheet uploaded under classic routing: text extracted at upload, route inferred. */
async function seedClassicEraXlsx(fileId = 'xlsx-classic'): Promise<string> {
  await methods.createFile({
    ...baseFile(fileId),
    filename: 'quarterly.xlsx',
    filepath: `/uploads/${userId}/quarterly.xlsx`,
    type: XLSX_TYPE,
    bytes: 4096,
    text: SHEET_TEXT,
    llmDeliveryPath: 'text',
    metadata: { destinationChosen: false },
  });
  return fileId;
}

/**
 * A spreadsheet the automatic upload path deferred to Run Code: no text and a `deferred`
 * marker. Written to the collection directly because the marker is a later commit's schema
 * field; reads return it as stored.
 */
async function seedDeferredXlsx(fileId = 'xlsx-deferred'): Promise<string> {
  const textDerivation: TextDerivation = { outcome: 'deferred', at: Date.now() };
  await mongoose.models.File.collection.insertOne({
    ...baseFile(fileId),
    filename: 'deferred.xlsx',
    filepath: `/uploads/${userId}/deferred.xlsx`,
    type: XLSX_TYPE,
    bytes: 4096,
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false, textDerivation },
  });
  return fileId;
}

/** Writes the real sample workbook where local storage keeps the record's original. */
async function storeSampleOriginal(fileId: string): Promise<void> {
  const [file] = (await methods.getFiles({ file_id: fileId }, null, {})) ?? [];
  const target = path.join(storageRoot, file?.filepath ?? fileId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(SAMPLE_XLSX, target);
}

/** Local storage: streams a record's original from under the storage root, observed. */
const localStorage = () =>
  jest.fn<ReturnType<OpenStoredFile>, Parameters<OpenStoredFile>>(async (file) =>
    fs.createReadStream(path.join(storageRoot, file.filepath ?? file.file_id)),
  );

async function seedPdf(fileId: string, bytes: number): Promise<string> {
  await methods.createFile({
    ...baseFile(fileId),
    filename: `${fileId}.pdf`,
    filepath: `/uploads/${userId}/${fileId}.pdf`,
    type: 'application/pdf',
    bytes,
    llmDeliveryPath: 'provider',
    metadata: { destinationChosen: false },
  });
  return fileId;
}

async function readRoutingFields(fileId: string): Promise<RoutingFields | undefined> {
  const [file] = (await methods.getFiles({ file_id: fileId }, null, {})) ?? [];
  if (file == null) {
    return undefined;
  }
  const { llmDeliveryPath, text, type, bytes, metadata } = file;
  return { llmDeliveryPath, text, type, bytes, metadata };
}

function buildDb(options: TurnOptions): InitializeAgentDbMethods {
  const skillId = new mongoose.Types.ObjectId();
  const skillDb: Partial<InitializeAgentDbMethods> =
    options.skillTools == null
      ? {}
      : {
          listSkillsByAccess: async () => ({ skills: [], has_more: false, after: null }),
          getSkillByName: async () => ({
            _id: skillId,
            name: SKILL_NAME,
            body: 'Analyze the attached spreadsheets.',
            author: new mongoose.Types.ObjectId(userId),
            allowedTools: options.skillTools,
          }),
        };
  return {
    getFiles: methods.getFiles as InitializeAgentDbMethods['getFiles'],
    updateFilesUsage: methods.updateFilesUsage,
    getToolFilesByIds: methods.getToolFilesByIds as InitializeAgentDbMethods['getToolFilesByIds'],
    getProjectFiles: methods.getProjectFiles as InitializeAgentDbMethods['getProjectFiles'],
    getConvoFiles: async () => [],
    getUserKey: async () => '',
    getUserKeyValues: async () => ({}),
    checkSessionsAlive: options.checkSessionsAlive,
    saveFileTextDerivation: methods.saveFileTextDerivation,
    ...skillDb,
  };
}

async function runTurn(options: TurnOptions) {
  const { policy, tools = [], loaded = [], skillTools, fileConfig, endpointConfig } = options;
  const { openStoredFile } = options;
  const appConfig: Pick<AppConfig, 'fileConfig'> = {
    fileConfig: {
      ...fileConfig,
      endpoints: {
        [EModelEndpoint.openAI]: {
          ...(policy != null && { llmDeliveryPolicy: policy }),
          ...endpointConfig,
        },
      },
    },
  };
  const req = {
    user: { id: userId, role: 'USER' },
    config: appConfig,
    body: {},
  } as ServerRequest;
  const agent = {
    id: 'agent-reading',
    provider: Providers.OPENAI,
    model: 'gpt-4o',
    tools,
    model_parameters: { model: 'gpt-4o' },
  } as Agent;
  const loadTools = jest.fn(async ({ tools: requested }: { tools: string[] }) => ({
    tools: [],
    toolContextMap: {},
    toolDefinitions: loaded
      .filter((name) => requested.includes(name))
      .map(
        (name): LCTool => ({
          name,
          description: name,
          parameters: { type: 'object', properties: {} },
        }),
      ),
  }));
  const skillId = new mongoose.Types.ObjectId();
  const result = await initializeAgent(
    {
      req,
      agent,
      loadTools,
      requestFiles: options.fileIds.map((file_id) => ({ file_id })) as IMongoFile[],
      codeEnvAvailable: true,
      fileSearchAvailable: true,
      endpointOption: { endpoint: EModelEndpoint.agents },
      allowedProviders: new Set([Providers.OPENAI]),
      isInitialAgent: true,
      ...(skillTools != null && { accessibleSkillIds: [skillId], manualSkills: [SKILL_NAME] }),
      ...(openStoredFile != null && { deriveText: createFileTextDeriver({ req, openStoredFile }) }),
    },
    buildDb(options),
  );
  return { result, req };
}

const pathsById = (files: ReadonlyArray<Pick<IMongoFile, 'file_id' | 'llmDeliveryPath'>>) =>
  Object.fromEntries(files.map((file) => [file.file_id, file.llmDeliveryPath]));

type InitializedAgentResult = Awaited<ReturnType<typeof initializeAgent>>;

/** The reader the final decision picked for each request attachment. */
const readersById = (result: InitializedAgentResult) =>
  Object.fromEntries(
    result.requestAttachments.map((file) => [
      file.file_id,
      decideFileReading({
        routing: result.deliveryRouting,
        file,
        consumers: result.fileConsumers,
      }).reader,
    ]),
  );

const injectedText = (files: IMongoFile[], req: ServerRequest) =>
  extractFileContext({ attachments: files, req, tokenCountFn: (text) => text.length });

describe('initializeAgent reading under the automatic policy (MongoDB)', () => {
  it('leaves a deferred spreadsheet to Run Code: queued, uncounted, uninjected, unchanged', async () => {
    const fileId = await seedDeferredXlsx();
    const before = await readRoutingFields(fileId);
    const admission = jest.spyOn(attachments, 'assertAgentAttachmentLimits');

    const { result, req } = await runTurn({
      fileIds: [fileId],
      policy: 'automatic',
      tools: [Tools.execute_code],
      fileConfig: { fileContextCharLimit: 1 },
    });

    expect(result.fileConsumers).toEqual({ executeCode: true, fileSearch: false });
    expect(pathsById(result.requestAttachments)).toEqual({ [fileId]: 'none' });
    expect(readersById(result)).toEqual({ [fileId]: 'code' });
    expect(result.provisionState?.codeEnvFiles.map((file) => file.file_id)).toEqual([fileId]);
    const [{ attachments: admitted }] = admission.mock.calls[0];
    expect([...(admitted ?? [])]).toEqual([]);
    expect(await injectedText(result.requestAttachments, req)).toBeFalsy();
    expect(await readRoutingFields(fileId)).toEqual(before);
  });

  it.each([
    { code: true, path: 'none', reason: 'Run Code reads it (A-16)' },
    { code: false, path: 'text', reason: 'its stored text fits (A-17)' },
  ])(
    'routes a classic-era spreadsheet to $path when $reason, without rewriting the record',
    async ({ code, path }) => {
      const fileId = await seedClassicEraXlsx();
      const before = await readRoutingFields(fileId);

      const { result, req } = await runTurn({
        fileIds: [fileId],
        policy: 'automatic',
        tools: code ? [Tools.execute_code] : [],
      });

      expect(pathsById(result.requestAttachments)).toEqual({ [fileId]: path });
      const injected = await injectedText(result.requestAttachments, req);
      expect(injected?.includes('SENTINEL-7F3A') === true).toBe(!code);
      expect(await readRoutingFields(fileId)).toEqual(before);
    },
  );

  it('keeps a PDF over the endpoint size limit for File Search instead of dropping it', async () => {
    const fileId = await seedPdf('pdf-large', 3 * 1024 * 1024);
    const admission = jest.spyOn(attachments, 'assertAgentAttachmentLimits');

    const { result } = await runTurn({
      fileIds: [fileId],
      policy: 'automatic',
      tools: [Tools.file_search],
      loaded: [Tools.file_search],
      endpointConfig: { fileSizeLimit: 1 },
      fileConfig: { fileContextSizeLimit: 1 },
    });

    expect(result.fileConsumers).toEqual({ executeCode: false, fileSearch: true });
    expect(pathsById(result.requestAttachments)).toEqual({ [fileId]: 'none' });
    expect(readersById(result)).toEqual({ [fileId]: 'search' });
    expect(result.provisionState?.vectorDBFiles.map((file) => file.file_id)).toEqual([fileId]);
    for (const [{ attachments: admitted }] of admission.mock.calls) {
      expect([...(admitted ?? [])].map((file) => file?.file_id)).not.toContain(fileId);
    }
    expect(getTurnReadingContext(result.deliveryRouting)?.stats()).toMatchObject({
      dropped: 0,
      overflow: 0,
    });
    const [kept] = result.requestAttachments;
    expect(
      decideFileReading({
        routing: result.deliveryRouting,
        file: kept,
        consumers: result.fileConsumers,
      }).reason,
    ).toBe('native_capacity');
  });

  it('decides again and re-runs admission and inspection once the loader drops Run Code', async () => {
    const fileId = await seedClassicEraXlsx();
    const admission = jest.spyOn(attachments, 'assertAgentAttachmentLimits');
    const inspection = jest.spyOn(modelBoundContent, 'assertModelBoundContent');

    const { result, req } = await runTurn({
      fileIds: [fileId],
      policy: 'automatic',
      skillTools: [Tools.execute_code],
    });

    expect(result.fileConsumers).toEqual({ executeCode: false, fileSearch: false });
    expect(pathsById(result.requestAttachments)).toEqual({ [fileId]: 'text' });
    expect(admission).toHaveBeenCalledTimes(2);
    const [, [{ attachments: recheck }]] = admission.mock.calls;
    expect(pathsById([...(recheck ?? [])] as IMongoFile[])).toEqual({ [fileId]: 'text' });
    const reinspected = inspection.mock.calls.filter(([{ files }]) =>
      (files ?? []).some(
        (file) =>
          typeof file === 'object' && file != null && 'file_id' in file && file.file_id === fileId,
      ),
    );
    expect(reinspected).toHaveLength(2);
    expect(await injectedText(result.requestAttachments, req)).toContain('SENTINEL-7F3A');
  });

  it('keeps the Run Code reader and injects no text when provisioning fails', async () => {
    const fileId = 'xlsx-sandboxed';
    await methods.createFile({
      ...baseFile(fileId),
      filename: 'sandboxed.xlsx',
      filepath: `/uploads/${userId}/sandboxed.xlsx`,
      type: XLSX_TYPE,
      bytes: 4096,
      text: SHEET_TEXT,
      llmDeliveryPath: 'text',
      metadata: {
        destinationChosen: false,
        codeEnvRef: {
          kind: 'user',
          id: userId,
          storage_session_id: 'session-1',
          file_id: 'sandbox-file-1',
        },
      },
    });
    const checkSessionsAlive = jest.fn().mockRejectedValue(new Error('Code API unreachable'));

    const { result, req } = await runTurn({
      fileIds: [fileId],
      policy: 'automatic',
      tools: [Tools.execute_code],
      checkSessionsAlive,
    });

    expect(checkSessionsAlive).toHaveBeenCalled();
    expect(result.provisionState).toBeUndefined();
    expect(result.fileConsumers?.executeCode).toBe(true);
    expect(pathsById(result.requestAttachments)).toEqual({ [fileId]: 'none' });
    expect(await injectedText(result.requestAttachments, req)).toBeFalsy();
  });

  const threePdfs = async () => [
    await seedPdf('pdf-a', 400 * 1024),
    await seedPdf('pdf-b', 400 * 1024),
    await seedPdf('pdf-c', 400 * 1024),
  ];

  it('sends the PDFs that fit the context allowance natively and the third to File Search', async () => {
    const fileIds = await threePdfs();

    const { result } = await runTurn({
      fileIds,
      policy: 'automatic',
      tools: [Tools.file_search],
      loaded: [Tools.file_search],
      fileConfig: { fileContextSizeLimit: 1 },
    });

    expect(pathsById(result.requestAttachments)).toEqual({
      'pdf-a': 'provider',
      'pdf-b': 'provider',
      'pdf-c': 'none',
    });
    expect(readersById(result)).toEqual({
      'pdf-a': 'provider',
      'pdf-b': 'provider',
      'pdf-c': 'search',
    });
    const context = getTurnReadingContext(result.deliveryRouting);
    expect(context?.stats().overflow).toBe(1);
    const queued = result.provisionState?.vectorDBFiles.map((file) => file.file_id) ?? [];
    expect(queued).toContain('pdf-c');
  });

  it('fails the turn on the context allowance as classic routing does when no file tool is loaded', async () => {
    const fileIds = await threePdfs();

    await expect(
      runTurn({ fileIds, policy: 'automatic', fileConfig: { fileContextSizeLimit: 1 } }),
    ).rejects.toThrow(attachments.AgentAttachmentLimitError);
  });
});

describe('initializeAgent text derivation from stored originals (MongoDB)', () => {
  it('derives a deferred spreadsheet without Run Code once and keeps the text on the record', async () => {
    const fileId = await seedDeferredXlsx();
    await storeSampleOriginal(fileId);
    const openStoredFile = localStorage();

    const { result, req } = await runTurn({
      fileIds: [fileId],
      policy: 'automatic',
      openStoredFile,
    });

    expect(result.fileConsumers).toEqual({ executeCode: false, fileSearch: false });
    expect(pathsById(result.requestAttachments)).toEqual({ [fileId]: 'text' });
    expect(readersById(result)).toEqual({ [fileId]: 'text' });
    expect(result.requestAttachments[0].text).toBe(SAMPLE_TEXT);
    expect(await injectedText(result.requestAttachments, req)).toContain('Data,on,first,sheet');
    expect(openStoredFile).toHaveBeenCalledTimes(1);
    expect(await readRoutingFields(fileId)).toMatchObject({
      llmDeliveryPath: 'none',
      text: SAMPLE_TEXT,
      metadata: {
        destinationChosen: false,
        textDerivation: { outcome: 'complete', extractor: 'document_parser' },
      },
    });

    const next = await runTurn({ fileIds: [fileId], policy: 'automatic', openStoredFile });

    expect(openStoredFile).toHaveBeenCalledTimes(1);
    expect(pathsById(next.result.requestAttachments)).toEqual({ [fileId]: 'text' });
    expect(next.result.requestAttachments[0].text).toBe(SAMPLE_TEXT);
  });

  it('writes nothing onto the record when content inspection refuses the turn', async () => {
    const fileId = await seedDeferredXlsx('xlsx-refused');
    await storeSampleOriginal(fileId);
    const openStoredFile = localStorage();
    const refusal = new Error('content refused');
    const inspection = jest
      .spyOn(modelBoundContent, 'assertModelBoundContent')
      .mockImplementation(() => {
        throw refusal;
      });
    try {
      await expect(
        runTurn({ fileIds: [fileId], policy: 'automatic', openStoredFile }),
      ).rejects.toBe(refusal);
    } finally {
      inspection.mockRestore();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(openStoredFile).toHaveBeenCalledTimes(1);
    const stored = await readRoutingFields(fileId);
    expect(stored?.text).toBeUndefined();
    expect(stored?.metadata?.textDerivation).toMatchObject({ outcome: 'deferred' });
  });
});

describe('initializeAgent reading under the classic policy (MongoDB)', () => {
  const snapshot = (files: IMongoFile[]) =>
    Object.fromEntries(
      files.map((file) => [file.file_id, { path: file.llmDeliveryPath, text: file.text }]),
    );

  it.each([{ code: true }, { code: false }])(
    'produces the copies it did before a deriver was wired (Run Code $code)',
    async ({ code }) => {
      const fileIds = [await seedClassicEraXlsx(), await seedPdf('pdf-small', 400 * 1024)];
      const tools = code ? [Tools.execute_code] : [];
      const openStoredFile = localStorage();
      const expected = {
        'xlsx-classic': { path: 'text', text: SHEET_TEXT },
        'pdf-small': { path: 'provider', text: undefined },
      };

      const unwired = await runTurn({ fileIds, tools });
      const wired = await runTurn({ fileIds, tools, openStoredFile });

      expect(wired.result.deliveryRouting.reading).toBeDefined();
      expect(snapshot(unwired.result.requestAttachments)).toEqual(expected);
      expect(snapshot(wired.result.requestAttachments)).toEqual(expected);
      expect(openStoredFile).not.toHaveBeenCalled();
    },
  );

  it('reads a deferred spreadsheet like a classic-era upload once rolled back (D27)', async () => {
    const fileId = await seedDeferredXlsx();
    await storeSampleOriginal(fileId);
    const openStoredFile = localStorage();

    const { result } = await runTurn({
      fileIds: [fileId],
      tools: [Tools.execute_code],
      openStoredFile,
    });

    expect(snapshot(result.requestAttachments)).toEqual({
      [fileId]: { path: 'text', text: SAMPLE_TEXT },
    });
    expect(openStoredFile).toHaveBeenCalledTimes(1);
    expect(await readRoutingFields(fileId)).toMatchObject({
      llmDeliveryPath: 'none',
      text: SAMPLE_TEXT,
      metadata: { textDerivation: { outcome: 'complete' } },
    });
  });

  it('keeps the classic-era spreadsheet on its text route even with Run Code', async () => {
    const fileId = await seedClassicEraXlsx();

    const { result } = await runTurn({ fileIds: [fileId], tools: [Tools.execute_code] });

    expect(result.deliveryRouting.reading).toBeUndefined();
    expect(pathsById(result.requestAttachments)).toEqual({ [fileId]: 'text' });
  });

  it('keeps the deferred spreadsheet on its stored tool route', async () => {
    const fileId = await seedDeferredXlsx();

    const { result } = await runTurn({ fileIds: [fileId], tools: [Tools.execute_code] });

    expect(pathsById(result.requestAttachments)).toEqual({ [fileId]: 'none' });
  });

  it('drops the PDF over the endpoint size limit', async () => {
    const fileId = await seedPdf('pdf-large', 3 * 1024 * 1024);

    const { result } = await runTurn({
      fileIds: [fileId],
      tools: [Tools.file_search],
      loaded: [Tools.file_search],
      endpointConfig: { fileSizeLimit: 1 },
    });

    expect(result.requestAttachments).toEqual([]);
  });

  it('refuses the turn when three PDFs exceed the context allowance', async () => {
    const fileIds = [
      await seedPdf('pdf-a', 400 * 1024),
      await seedPdf('pdf-b', 400 * 1024),
      await seedPdf('pdf-c', 400 * 1024),
    ];

    await expect(
      runTurn({ fileIds, fileConfig: { fileContextSizeLimit: 1 } }),
    ).rejects.toMatchObject({ name: 'AgentAttachmentLimitError' });
  });
});
