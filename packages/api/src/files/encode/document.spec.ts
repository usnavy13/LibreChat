import { Providers } from '@librechat/agents';
import { mbToBytes, fileConfig as baseFileConfig } from 'librechat-data-provider';
import type { AppConfig, IMongoFile } from '@librechat/data-schemas';
import type { NativeValidationMode, DocumentResult, ServerRequest } from '~/types';
import { encodeAndFormatDocuments } from './document';

/** Mock the validation module */
jest.mock('~/files/validation', () => ({
  ...jest.requireActual('~/files/validation'),
  validatePdf: jest.fn(),
  validateBedrockDocument: jest.fn(),
}));

/** Mock storage reads; the file size limit resolves through the real fileConfig merge */
jest.mock('./utils', () => ({
  ...jest.requireActual('./utils'),
  getFileStream: jest.fn(),
}));

import { validatePdf, validateBedrockDocument } from '~/files/validation';
import { getFileStream, AttachmentObjectNotFoundError } from './utils';
import { Types } from 'mongoose';

const realValidation =
  jest.requireActual<typeof import('~/files/validation')>('~/files/validation');

const mockedValidatePdf = validatePdf as jest.MockedFunction<typeof validatePdf>;
const mockedValidateBedrockDocument = validateBedrockDocument as jest.MockedFunction<
  typeof validateBedrockDocument
>;
const mockedGetFileStream = getFileStream as jest.MockedFunction<typeof getFileStream>;

describe('encodeAndFormatDocuments - fileConfig integration', () => {
  const mockStrategyFunctions = jest.fn();

  const inheritedLimit = baseFileConfig.endpoints.default.fileSizeLimit;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  /** Helper to create a mock request with file config */
  const createMockRequest = (
    fileSizeLimit?: number,
    provider: string = Providers.OPENAI,
  ): Partial<AppConfig> => ({
    config:
      fileSizeLimit !== undefined
        ? {
            fileConfig: {
              endpoints: {
                [provider]: {
                  fileSizeLimit,
                },
              },
            },
          }
        : undefined,
  });

  /** Helper to create a mock PDF file */
  const createMockFile = (sizeInMB: number): IMongoFile =>
    ({
      _id: new Types.ObjectId(),
      user: new Types.ObjectId(),
      file_id: new Types.ObjectId().toString(),
      filename: 'test.pdf',
      type: 'application/pdf',
      bytes: Math.floor(sizeInMB * 1024 * 1024),
      object: 'file',
      usage: 0,
      source: 'test',
      filepath: '/test/path.pdf',
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as IMongoFile;

  const createMockDocFile = (sizeInMB: number, mimeType: string, filename: string): IMongoFile =>
    ({
      _id: new Types.ObjectId(),
      user: new Types.ObjectId(),
      file_id: new Types.ObjectId().toString(),
      filename,
      type: mimeType,
      bytes: Math.floor(sizeInMB * 1024 * 1024),
      object: 'file',
      usage: 0,
      source: 'test',
      filepath: `/test/path/${filename}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as IMongoFile;

  describe('Configuration extraction and validation', () => {
    it('should pass configured file size limit to validatePdf for OpenAI', async () => {
      const configuredLimit = mbToBytes(15);
      const req = createMockRequest(15) as ServerRequest;
      const file = createMockFile(10);

      const mockContent = Buffer.from('test-pdf-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidatePdf.mockResolvedValue({ isValid: true });

      await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI },
        mockStrategyFunctions,
      );

      expect(mockedValidatePdf).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        Providers.OPENAI,
        configuredLimit,
        undefined,
      );
    });

    it('should pass undefined when no fileConfig is provided', async () => {
      const req = {} as ServerRequest;
      const file = createMockFile(10);

      const mockContent = Buffer.from('test-pdf-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidatePdf.mockResolvedValue({ isValid: true });

      await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI },
        mockStrategyFunctions,
      );

      expect(mockedValidatePdf).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        Providers.OPENAI,
        undefined,
        undefined,
      );
    });

    it('should pass the inherited default limit for an empty fileConfig', async () => {
      const req = {
        config: {
          fileConfig: {},
        },
      } as ServerRequest;
      const file = createMockFile(10);

      mockedGetFileStream.mockResolvedValue({
        file,
        content: Buffer.from('test-pdf-content').toString('base64'),
        metadata: file,
      });
      mockedValidatePdf.mockResolvedValue({ isValid: true });

      await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI },
        mockStrategyFunctions,
      );

      expect(mockedValidatePdf).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        Providers.OPENAI,
        inheritedLimit,
        undefined,
      );
    });

    it('should use endpoint-specific config for Anthropic', async () => {
      const configuredLimit = mbToBytes(20);
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.ANTHROPIC]: {
                fileSizeLimit: 20,
              },
            },
          },
        },
      } as unknown as ServerRequest;
      const file = createMockFile(15);

      const mockContent = Buffer.from('test-pdf-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidatePdf.mockResolvedValue({ isValid: true });

      await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.ANTHROPIC },
        mockStrategyFunctions,
      );

      expect(mockedValidatePdf).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        Providers.ANTHROPIC,
        configuredLimit,
        undefined,
      );
    });

    it('should use endpoint-specific config for Google', async () => {
      const configuredLimit = mbToBytes(25);
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.GOOGLE]: {
                fileSizeLimit: 25,
              },
            },
          },
        },
      } as unknown as ServerRequest;
      const file = createMockFile(18);

      const mockContent = Buffer.from('test-pdf-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidatePdf.mockResolvedValue({ isValid: true });

      await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.GOOGLE },
        mockStrategyFunctions,
      );

      expect(mockedValidatePdf).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        Providers.GOOGLE,
        configuredLimit,
        undefined,
      );
    });

    it('should pass the inherited default limit when only another provider is configured', async () => {
      const req = {
        config: {
          fileConfig: {
            endpoints: {
              [Providers.ANTHROPIC]: {
                fileSizeLimit: 25,
              },
            },
          },
        },
      } as unknown as ServerRequest;
      const file = createMockFile(20);

      mockedGetFileStream.mockResolvedValue({
        file,
        content: Buffer.from('test-pdf-content').toString('base64'),
        metadata: file,
      });
      mockedValidatePdf.mockResolvedValue({ isValid: true });

      await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI },
        mockStrategyFunctions,
      );

      expect(mockedValidatePdf).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        Providers.OPENAI,
        inheritedLimit,
        undefined,
      );
    });
  });

  describe('Validation failure handling', () => {
    it('should throw error when validation fails', async () => {
      const req = createMockRequest(10) as ServerRequest;
      const file = createMockFile(12);

      const mockContent = Buffer.from('test-pdf-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidatePdf.mockResolvedValue({
        isValid: false,
        error: 'PDF file size (12MB) exceeds the 10MB limit',
      });

      await expect(
        encodeAndFormatDocuments(
          req,
          [file],
          { provider: Providers.OPENAI },
          mockStrategyFunctions,
        ),
      ).rejects.toThrow('PDF validation failed: PDF file size (12MB) exceeds the 10MB limit');
    });

    it('should not call validatePdf for non-PDF files', async () => {
      const req = createMockRequest(10) as ServerRequest;
      const file: IMongoFile = {
        ...createMockFile(5),
        type: 'image/jpeg',
        filename: 'test.jpg',
      };

      const mockContent = Buffer.from('test-image-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI },
        mockStrategyFunctions,
      );

      expect(mockedValidatePdf).not.toHaveBeenCalled();
    });
  });

  describe('Bug reproduction scenarios', () => {
    it('should respect user-configured lower limit (stricter than provider)', async () => {
      /**
       * Scenario: User sets openAI.fileSizeLimit = 5MB (stricter than 10MB provider limit)
       * Uploads 7MB PDF
       * Expected: Validation called with 5MB limit
       */
      const req = createMockRequest(5) as ServerRequest;
      const file = createMockFile(7);

      const mockContent = Buffer.from('test-pdf-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidatePdf.mockResolvedValue({
        isValid: false,
        error: 'PDF file size (7MB) exceeds the 5MB limit',
      });

      await expect(
        encodeAndFormatDocuments(
          req,
          [file],
          { provider: Providers.OPENAI },
          mockStrategyFunctions,
        ),
      ).rejects.toThrow('PDF validation failed');

      expect(mockedValidatePdf).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        Providers.OPENAI,
        mbToBytes(5),
        undefined,
      );
    });

    it('should respect user-configured higher limit (allows API changes)', async () => {
      /**
       * Scenario: User sets openAI.fileSizeLimit = 50MB (higher than 10MB provider default)
       * Uploads 15MB PDF
       * Expected: Validation called with 50MB limit, allowing files between 10-50MB
       * This allows users to take advantage of API limit increases
       */
      const req = createMockRequest(50) as ServerRequest;
      const file = createMockFile(15);

      const mockContent = Buffer.from('test-pdf-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidatePdf.mockResolvedValue({ isValid: true });

      await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI },
        mockStrategyFunctions,
      );

      expect(mockedValidatePdf).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        Providers.OPENAI,
        mbToBytes(50),
        undefined,
      );
    });

    it('should handle multiple files with different sizes', async () => {
      const req = createMockRequest(10) as ServerRequest;
      const file1 = createMockFile(5);
      const file2 = createMockFile(8);

      const mockContent1 = Buffer.from('pdf-content-1').toString('base64');
      const mockContent2 = Buffer.from('pdf-content-2').toString('base64');

      mockedGetFileStream
        .mockResolvedValueOnce({
          file: file1,
          content: mockContent1,
          metadata: file1,
        })
        .mockResolvedValueOnce({
          file: file2,
          content: mockContent2,
          metadata: file2,
        });

      mockedValidatePdf.mockResolvedValue({ isValid: true });

      await encodeAndFormatDocuments(
        req,
        [file1, file2],
        { provider: Providers.OPENAI },
        mockStrategyFunctions,
      );

      expect(mockedValidatePdf).toHaveBeenCalledTimes(2);
      expect(mockedValidatePdf).toHaveBeenNthCalledWith(
        1,
        expect.any(Buffer),
        expect.any(Number),
        Providers.OPENAI,
        mbToBytes(10),
        undefined,
      );
      expect(mockedValidatePdf).toHaveBeenNthCalledWith(
        2,
        expect.any(Buffer),
        expect.any(Number),
        Providers.OPENAI,
        mbToBytes(10),
        undefined,
      );
    });
  });

  describe('Document formatting after validation', () => {
    it('should format Anthropic document with valid PDF', async () => {
      const req = createMockRequest(30) as ServerRequest;
      const file = createMockFile(20);

      const mockContent = Buffer.from('test-pdf-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidatePdf.mockResolvedValue({ isValid: true });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.ANTHROPIC },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: mockContent,
        },
        citations: { enabled: true },
      });
    });

    it('should format Bedrock document with valid PDF', async () => {
      const req = createMockRequest() as ServerRequest;
      const file = createMockFile(3);

      const mockContent = Buffer.from('test-pdf-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidateBedrockDocument.mockResolvedValue({ isValid: true });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.BEDROCK },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'document',
        document: {
          name: 'test_pdf',
          format: 'pdf',
          source: {
            bytes: expect.any(Buffer),
          },
        },
      });
    });

    it('should format Bedrock CSV document', async () => {
      const req = createMockRequest() as ServerRequest;
      const file = createMockDocFile(1, 'text/csv', 'data.csv');

      const mockContent = Buffer.from('col1,col2\nval1,val2').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidateBedrockDocument.mockResolvedValue({ isValid: true });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.BEDROCK },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'document',
        document: {
          name: 'data_csv',
          format: 'csv',
          source: {
            bytes: expect.any(Buffer),
          },
        },
      });
    });

    it('should format Bedrock DOCX document', async () => {
      const req = createMockRequest() as ServerRequest;
      const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const file = createMockDocFile(2, mimeType, 'report.docx');

      const mockContent = Buffer.from('docx-binary-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidateBedrockDocument.mockResolvedValue({ isValid: true });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.BEDROCK },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'document',
        document: {
          name: 'report_docx',
          format: 'docx',
          source: {
            bytes: expect.any(Buffer),
          },
        },
      });
    });

    it('should format Bedrock plain text document', async () => {
      const req = createMockRequest() as ServerRequest;
      const file = createMockDocFile(0.5, 'text/plain', 'notes.txt');

      const mockContent = Buffer.from('plain text content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidateBedrockDocument.mockResolvedValue({ isValid: true });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.BEDROCK },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'document',
        document: {
          name: 'notes_txt',
          format: 'txt',
          source: {
            bytes: expect.any(Buffer),
          },
        },
      });
    });

    it('should thread model to validateBedrockDocument when model is provided', async () => {
      const req = createMockRequest() as ServerRequest;
      const model = 'anthropic.claude-sonnet-4-20250514-v1:0';
      const file = createMockDocFile(1, 'text/csv', 'data.csv');

      const mockContent = Buffer.from('col1,col2\nval1,val2').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidateBedrockDocument.mockResolvedValue({ isValid: true });

      await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.BEDROCK, model },
        mockStrategyFunctions,
      );

      expect(mockedValidateBedrockDocument).toHaveBeenCalledWith(
        expect.any(Number),
        'text/csv',
        expect.any(Buffer),
        undefined,
        model,
      );
    });

    it('should reject Bedrock document when validation fails', async () => {
      const req = createMockRequest() as ServerRequest;
      const file = createMockDocFile(5, 'text/csv', 'big.csv');

      const mockContent = Buffer.from('large-csv-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidateBedrockDocument.mockResolvedValue({
        isValid: false,
        error: 'File size (5.0MB) exceeds the 4.5MB limit for Bedrock',
      });

      await expect(
        encodeAndFormatDocuments(
          req,
          [file],
          { provider: Providers.BEDROCK },
          mockStrategyFunctions,
        ),
      ).rejects.toThrow('Document validation failed');
    });

    it('should format OpenAI document with responses API', async () => {
      const req = createMockRequest(15) as ServerRequest;
      const file = createMockFile(10);

      const mockContent = Buffer.from('test-pdf-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      mockedValidatePdf.mockResolvedValue({ isValid: true });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI, useResponsesApi: true },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'input_file',
        filename: 'test.pdf',
        file_data: `data:application/pdf;base64,${mockContent}`,
      });
    });

    it.each([Providers.GOOGLE, Providers.VERTEXAI] as const)(
      'should format %s PDF as media block when responses API is enabled',
      async (provider) => {
        const req = createMockRequest(15, provider) as ServerRequest;
        const file = createMockFile(10);

        const mockContent = Buffer.from('test-pdf-content').toString('base64');
        mockedGetFileStream.mockResolvedValue({
          file,
          content: mockContent,
          metadata: file,
        });

        mockedValidatePdf.mockResolvedValue({ isValid: true });

        const result = await encodeAndFormatDocuments(
          req,
          [file],
          { provider, useResponsesApi: true },
          mockStrategyFunctions,
        );

        expect(result.documents).toHaveLength(1);
        expect(result.documents[0]).toMatchObject({
          type: 'media',
          mimeType: 'application/pdf',
          data: mockContent,
        });
        expect(result.documents[0]).not.toHaveProperty('type', 'input_file');
      },
    );
  });

  describe('Generic document encoding path', () => {
    it('should format text/plain for Anthropic as a plain-text document source', async () => {
      const req = createMockRequest(30) as ServerRequest;
      const file = createMockDocFile(1, 'text/plain', 'notes.txt');

      const mockContent = Buffer.from('plain text content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.ANTHROPIC },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'document',
        source: {
          type: 'text',
          media_type: 'text/plain',
          data: 'plain text content',
        },
        citations: { enabled: true },
        context: 'File: "notes.txt"',
      });
      expect(result.files).toHaveLength(1);
    });

    it('should format text/html for Anthropic as a plain-text document source', async () => {
      const req = createMockRequest(30) as ServerRequest;
      const file = createMockDocFile(1, 'text/html', 'page.html');

      const mockContent = Buffer.from('<html>content</html>').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.ANTHROPIC },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: '<html>content</html>' },
        citations: { enabled: true },
      });
    });

    it('should format application/json for Anthropic as a plain-text document source', async () => {
      const req = createMockRequest(30) as ServerRequest;
      const file = createMockDocFile(1, 'application/json', 'data.json');

      const mockContent = Buffer.from('{"key":"value"}').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.ANTHROPIC },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: '{"key":"value"}' },
        citations: { enabled: true },
      });
    });

    it('should skip non-PDF binary documents for Anthropic without contacting storage', async () => {
      const req = createMockRequest(30) as ServerRequest;
      const file = createMockDocFile(
        1,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'report.docx',
      );

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.ANTHROPIC },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(0);
      expect(result.files).toHaveLength(0);
      expect(mockedGetFileStream).not.toHaveBeenCalled();
    });

    it('should apply Claude document restrictions through an OpenAI-compatible gateway', async () => {
      const req = createMockRequest(30) as ServerRequest;
      const file = createMockDocFile(
        1,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'report.xlsx',
      );

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI, model: 'anthropic/claude-sonnet-4-6' },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(0);
      expect(result.files).toHaveLength(0);
      expect(mockedGetFileStream).not.toHaveBeenCalled();
    });

    it('should send textual documents as text parts to Claude through an OpenAI-compatible gateway', async () => {
      const req = createMockRequest(30) as ServerRequest;
      const file = createMockDocFile(1, 'text/plain', 'notes.txt');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: Buffer.from('hello from test').toString('base64'),
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI, model: 'claude-auto-latest' },
        mockStrategyFunctions,
      );

      expect(result.documents).toEqual([
        { type: 'text', text: 'File: "notes.txt"\n\nhello from test' },
      ]);
      expect(result.files).toHaveLength(1);
    });

    it('should keep textual documents as file parts for non-Claude OpenAI models', async () => {
      const req = createMockRequest(30) as ServerRequest;
      const file = createMockDocFile(1, 'text/html', 'page.html');
      const mockContent = Buffer.from('<p>hi</p>').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI, model: 'gemini-auto-latest' },
        mockStrategyFunctions,
      );

      expect(result.documents).toEqual([
        {
          type: 'file',
          file: { filename: 'page.html', file_data: `data:text/html;base64,${mockContent}` },
        },
      ]);
    });

    it('should retain XLSX support for non-Claude OpenAI models', async () => {
      const req = createMockRequest(30) as ServerRequest;
      const file = createMockDocFile(
        1,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'report.xlsx',
      );
      const mockContent = Buffer.from('xlsx-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI, model: 'gpt-5.4' },
        mockStrategyFunctions,
      );

      expect(result.documents).toMatchObject([
        {
          type: 'file',
          file: {
            filename: 'report.xlsx',
            file_data: `data:${file.type};base64,${mockContent}`,
          },
        },
      ]);
      expect(result.files).toEqual([file]);
      expect(mockedGetFileStream).toHaveBeenCalledTimes(1);
    });

    it('should still encode supported Anthropic documents when mixed with unsupported ones', async () => {
      const req = createMockRequest(30) as ServerRequest;
      const docxFile = createMockDocFile(1, 'application/vnd.ms-excel', 'sheet.xls');
      const textFile = createMockDocFile(1, 'text/markdown', 'readme.md');

      const mockContent = Buffer.from('# heading').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file: textFile,
        content: mockContent,
        metadata: textFile,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [docxFile, textFile],
        { provider: Providers.ANTHROPIC },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: '# heading' },
      });
      expect(result.files).toHaveLength(1);
      expect(mockedGetFileStream).toHaveBeenCalledTimes(1);
    });

    it('should format text/csv for OpenAI responses API', async () => {
      const req = createMockRequest(15) as ServerRequest;
      const file = createMockDocFile(1, 'text/csv', 'data.csv');

      const mockContent = Buffer.from('a,b\n1,2').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI, useResponsesApi: true },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'input_file',
        filename: 'data.csv',
        file_data: `data:text/csv;base64,${mockContent}`,
      });
      expect(result.files).toHaveLength(1);
    });

    it('should format XLSX for Google/VertexAI as media block', async () => {
      const req = createMockRequest(25) as ServerRequest;
      const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const file = createMockDocFile(2, mimeType, 'report.xlsx');

      const mockContent = Buffer.from('xlsx-binary').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.GOOGLE },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'media',
        mimeType,
        data: mockContent,
      });
      expect(result.files).toHaveLength(1);
    });

    it('should format text/plain for standard OpenAI-like provider as file block', async () => {
      const req = createMockRequest(15) as ServerRequest;
      const file = createMockDocFile(1, 'text/plain', 'readme.txt');

      const mockContent = Buffer.from('readme content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.OPENAI },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]).toMatchObject({
        type: 'file',
        file: {
          filename: 'readme.txt',
          file_data: `data:text/plain;base64,${mockContent}`,
        },
      });
      expect(result.files).toHaveLength(1);
    });

    it('should skip non-Bedrock-document types for Bedrock provider', async () => {
      const req = createMockRequest() as ServerRequest;
      const file = createMockDocFile(1, 'application/zip', 'archive.zip');

      const mockContent = Buffer.from('zip-content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.BEDROCK },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(0);
      expect(result.files).toHaveLength(0);
    });

    it('should throw when generic file exceeds configured size limit', async () => {
      const req = createMockRequest(1, Providers.ANTHROPIC) as ServerRequest;
      const file = createMockDocFile(2, 'text/plain', 'large.txt');

      const largeContent = Buffer.alloc(2 * 1024 * 1024).toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: largeContent,
        metadata: file,
      });

      await expect(
        encodeAndFormatDocuments(
          req,
          [file],
          { provider: Providers.ANTHROPIC },
          mockStrategyFunctions,
        ),
      ).rejects.toThrow('File size');
    });

    it('should not push metadata when provider has no handler', async () => {
      const req = createMockRequest(15) as ServerRequest;
      const file = createMockDocFile(1, 'text/plain', 'test.txt');

      const mockContent = Buffer.from('content').toString('base64');
      mockedGetFileStream.mockResolvedValue({
        file,
        content: mockContent,
        metadata: file,
      });

      const result = await encodeAndFormatDocuments(
        req,
        [file],
        { provider: Providers.AZURE as Providers },
        mockStrategyFunctions,
      );

      expect(result.documents).toHaveLength(0);
      expect(result.files).toHaveLength(0);
    });
  });

  describe('concurrency guard', () => {
    it('bounds parallel getFileStream calls and returns all documents unchanged', async () => {
      const req = createMockRequest(50) as ServerRequest;
      const files = Array.from({ length: 6 }, (_, i) =>
        createMockDocFile(1, 'text/plain', `doc-${i}.txt`),
      );

      let active = 0;
      let peak = 0;
      mockedGetFileStream.mockImplementation(async (_req, file) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return {
          file,
          content: Buffer.from(`content-${file.filename}`).toString('base64'),
          metadata: file,
        };
      });

      const result = await encodeAndFormatDocuments(
        req,
        files,
        { provider: Providers.OPENAI, useResponsesApi: true },
        mockStrategyFunctions,
      );

      expect(peak).toBe(3);
      expect(result.documents).toHaveLength(6);
      expect(result.files).toHaveLength(6);
    });
  });

  describe('onValidationFailure', () => {
    const pdfBytes = (size: number): Buffer => {
      const buffer = Buffer.alloc(size);
      buffer.write('%PDF-1.4\n', 0);
      return buffer;
    };

    /** Serves each file its own bytes so the real validators see what production would. */
    const serveContents = (contents: Map<string, Buffer>): void => {
      mockedGetFileStream.mockImplementation(async (_req, file) => ({
        file,
        content: (contents.get(file.file_id) ?? Buffer.alloc(0)).toString('base64'),
        metadata: file,
      }));
    };

    type UnreadableSet = Record<'unreadable' | 'unstored' | 'empty' | 'readable', IMongoFile>;

    /** A failed read, a record with no stored object, a zero-byte object and a readable file. */
    const serveUnreadableSet = (): UnreadableSet => {
      const files: UnreadableSet = {
        unreadable: createMockDocFile(0.01, 'text/plain', 'unreadable.txt'),
        unstored: createMockDocFile(0.01, 'text/plain', 'unstored.txt'),
        empty: createMockDocFile(0.01, 'text/plain', 'empty.txt'),
        readable: createMockDocFile(0.01, 'text/plain', 'readable.txt'),
      };
      mockedGetFileStream.mockImplementation(async (_req, file) => {
        if (file.file_id === files.unreadable.file_id) {
          throw new Error('storage unavailable');
        }
        if (file.file_id === files.unstored.file_id) {
          return null;
        }
        const content =
          file.file_id === files.empty.file_id ? '' : Buffer.from('notes').toString('base64');
        return { file, content, metadata: file };
      });
      return files;
    };

    const encodeUnreadableSet = async (
      files: UnreadableSet,
      onValidationFailure?: NativeValidationMode,
    ): Promise<DocumentResult> => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const result = await encodeAndFormatDocuments(
          createMockRequest(15) as ServerRequest,
          [files.unreadable, files.unstored, files.empty, files.readable],
          { provider: Providers.OPENAI, onValidationFailure },
          mockStrategyFunctions,
        );
        expect(consoleError).toHaveBeenCalledWith(
          'Document processing failed:',
          expect.objectContaining({ message: 'storage unavailable' }),
        );
        return result;
      } finally {
        consoleError.mockRestore();
      }
    };

    /** Passes the case-insensitive provider gate but matches no case-sensitive block format. */
    const providerWithoutBlockFormat = 'OpenRouter' as Providers;

    beforeEach(() => {
      mockedValidatePdf.mockImplementation(realValidation.validatePdf);
      mockedValidateBedrockDocument.mockImplementation(realValidation.validateBedrockDocument);
    });

    describe('skip', () => {
      it('records a PDF over the configured limit as capacity, omits it and keeps the others', async () => {
        const req = createMockRequest(1) as ServerRequest;
        const oversized = createMockFile(2);
        const small = createMockFile(0.01);
        serveContents(
          new Map([
            [oversized.file_id, pdfBytes(mbToBytes(2))],
            [small.file_id, pdfBytes(1024)],
          ]),
        );

        const result = await encodeAndFormatDocuments(
          req,
          [oversized, small],
          { provider: Providers.OPENAI, onValidationFailure: 'skip' },
          mockStrategyFunctions,
        );

        expect(result.rejected).toEqual([{ file_id: oversized.file_id, reason: 'capacity' }]);
        expect(result.documents).toHaveLength(1);
        expect(result.files).toEqual([small]);
      });

      it('records an encrypted Anthropic PDF as integrity and keeps a readable one', async () => {
        const req = createMockRequest(30, Providers.ANTHROPIC) as ServerRequest;
        const encrypted = createMockFile(0.01);
        const readable = createMockFile(0.01);
        const encryptedBytes = pdfBytes(1024);
        encryptedBytes.write('/Encrypt ', 100);
        serveContents(
          new Map([
            [encrypted.file_id, encryptedBytes],
            [readable.file_id, pdfBytes(1024)],
          ]),
        );

        const result = await encodeAndFormatDocuments(
          req,
          [encrypted, readable],
          { provider: Providers.ANTHROPIC, onValidationFailure: 'skip' },
          mockStrategyFunctions,
        );

        expect(result.rejected).toEqual([{ file_id: encrypted.file_id, reason: 'integrity' }]);
        expect(result.documents).toEqual([
          expect.objectContaining({
            type: 'document',
            source: expect.objectContaining({ media_type: 'application/pdf' }),
          }),
        ]);
        expect(result.files).toEqual([readable]);
      });

      it('records Bedrock capacity and integrity failures with their own reasons', async () => {
        const req = createMockRequest() as ServerRequest;
        const largeCsv = createMockDocFile(5, 'text/csv', 'large.csv');
        const headerless = createMockDocFile(0.01, 'application/pdf', 'broken.pdf');
        const smallCsv = createMockDocFile(0.01, 'text/csv', 'small.csv');
        const brokenBytes = Buffer.alloc(1024);
        brokenBytes.write('INVALID', 0);
        serveContents(
          new Map([
            [largeCsv.file_id, Buffer.alloc(mbToBytes(5))],
            [headerless.file_id, brokenBytes],
            [smallCsv.file_id, Buffer.from('a,b\n1,2')],
          ]),
        );

        const result = await encodeAndFormatDocuments(
          req,
          [largeCsv, headerless, smallCsv],
          { provider: Providers.BEDROCK, onValidationFailure: 'skip' },
          mockStrategyFunctions,
        );

        expect(result.rejected).toEqual([
          { file_id: largeCsv.file_id, reason: 'capacity' },
          { file_id: headerless.file_id, reason: 'integrity' },
        ]);
        expect(result.documents).toEqual([
          expect.objectContaining({
            type: 'document',
            document: expect.objectContaining({ format: 'csv', name: 'small_csv' }),
          }),
        ]);
        expect(result.files).toEqual([smallCsv]);
      });

      it('records a generic file over the configured limit as capacity', async () => {
        const req = createMockRequest(1, Providers.ANTHROPIC) as ServerRequest;
        const large = createMockDocFile(2, 'text/plain', 'large.txt');
        const notes = createMockDocFile(0.01, 'text/plain', 'notes.txt');
        serveContents(
          new Map([
            [large.file_id, Buffer.alloc(mbToBytes(2))],
            [notes.file_id, Buffer.from('notes')],
          ]),
        );

        const result = await encodeAndFormatDocuments(
          req,
          [large, notes],
          { provider: Providers.ANTHROPIC, onValidationFailure: 'skip' },
          mockStrategyFunctions,
        );

        expect(result.rejected).toEqual([{ file_id: large.file_id, reason: 'capacity' }]);
        expect(result.files).toEqual([notes]);
        expect(result.documents).toHaveLength(1);
      });

      it('reports every file as unsupported when the provider has no document path', async () => {
        const req = createMockRequest(15) as ServerRequest;
        const pdf = createMockFile(1);
        const text = createMockDocFile(0.01, 'text/plain', 'notes.txt');

        const result = await encodeAndFormatDocuments(
          req,
          [pdf, text],
          { provider: Providers.AZURE, onValidationFailure: 'skip' },
          mockStrategyFunctions,
        );

        expect(result).toEqual({
          documents: [],
          files: [],
          rejected: [
            { file_id: pdf.file_id, reason: 'unsupported' },
            { file_id: text.file_id, reason: 'unsupported' },
          ],
        });
        expect(mockedGetFileStream).not.toHaveBeenCalled();
      });

      it('reports a type with no Bedrock document format as unsupported', async () => {
        const req = createMockRequest() as ServerRequest;
        const archive = createMockDocFile(0.01, 'application/zip', 'archive.zip');
        const csv = createMockDocFile(0.01, 'text/csv', 'data.csv');
        serveContents(new Map([[csv.file_id, Buffer.from('a,b\n1,2')]]));

        const result = await encodeAndFormatDocuments(
          req,
          [archive, csv],
          { provider: Providers.BEDROCK, onValidationFailure: 'skip' },
          mockStrategyFunctions,
        );

        expect(result.rejected).toEqual([{ file_id: archive.file_id, reason: 'unsupported' }]);
        expect(result.files).toEqual([csv]);
        expect(mockedGetFileStream).toHaveBeenCalledTimes(1);
      });

      it('reports a type Claude document input cannot take as unsupported', async () => {
        const req = createMockRequest(30, Providers.ANTHROPIC) as ServerRequest;
        const docx = createMockDocFile(
          0.01,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'report.docx',
        );
        const readme = createMockDocFile(0.01, 'text/markdown', 'readme.md');
        serveContents(new Map([[readme.file_id, Buffer.from('# heading')]]));

        const result = await encodeAndFormatDocuments(
          req,
          [docx, readme],
          { provider: Providers.ANTHROPIC, onValidationFailure: 'skip' },
          mockStrategyFunctions,
        );

        expect(result.rejected).toEqual([{ file_id: docx.file_id, reason: 'unsupported' }]);
        expect(result.files).toEqual([readme]);
        expect(mockedGetFileStream).toHaveBeenCalledTimes(1);
      });

      it('returns an empty rejected list when every file encodes', async () => {
        const req = createMockRequest(15) as ServerRequest;
        const file = createMockFile(0.01);
        serveContents(new Map([[file.file_id, pdfBytes(1024)]]));

        const result = await encodeAndFormatDocuments(
          req,
          [file],
          { provider: Providers.OPENAI, onValidationFailure: 'skip' },
          mockStrategyFunctions,
        );

        expect(result.rejected).toEqual([]);
        expect(result.files).toEqual([file]);
      });

      it('records unreadable, unstored and empty files as integrity and keeps the readable one', async () => {
        const files = serveUnreadableSet();

        const result = await encodeUnreadableSet(files, 'skip');

        expect(result.rejected).toEqual([
          { file_id: files.unreadable.file_id, reason: 'integrity' },
          { file_id: files.unstored.file_id, reason: 'integrity' },
          { file_id: files.empty.file_id, reason: 'integrity' },
        ]);
        expect(result.files).toEqual([files.readable]);
        expect(result.documents).toEqual([expect.objectContaining({ type: 'file' })]);
      });

      it('reports a file no block format exists for as unsupported', async () => {
        const req = createMockRequest() as ServerRequest;
        const notes = createMockDocFile(0.01, 'text/plain', 'notes.txt');
        serveContents(new Map([[notes.file_id, Buffer.from('notes')]]));

        const result = await encodeAndFormatDocuments(
          req,
          [notes],
          { provider: providerWithoutBlockFormat, onValidationFailure: 'skip' },
          mockStrategyFunctions,
        );

        expect(result).toEqual({
          documents: [],
          files: [],
          rejected: [{ file_id: notes.file_id, reason: 'unsupported' }],
        });
      });

      it('still rethrows a missing storage object', async () => {
        const req = createMockRequest(15) as ServerRequest;
        const missing = createMockFile(0.01);
        const present = createMockFile(0.01);
        mockedGetFileStream.mockImplementation(async (_req, file) => {
          if (file.file_id === missing.file_id) {
            throw new AttachmentObjectNotFoundError(missing.file_id);
          }
          return { file, content: pdfBytes(1024).toString('base64'), metadata: file };
        });

        await expect(
          encodeAndFormatDocuments(
            req,
            [missing, present],
            { provider: Providers.OPENAI, onValidationFailure: 'skip' },
            mockStrategyFunctions,
          ),
        ).rejects.toMatchObject({ code: 'ATTACHMENT_OBJECT_NOT_FOUND', fileId: missing.file_id });
      });
    });

    describe('throw', () => {
      it.each([undefined, 'throw'] as const)(
        'throws the unchanged PDF capacity error when the mode is %s',
        async (onValidationFailure) => {
          const req = createMockRequest(1) as ServerRequest;
          const file = createMockFile(2);
          serveContents(new Map([[file.file_id, pdfBytes(mbToBytes(2))]]));

          await expect(
            encodeAndFormatDocuments(
              req,
              [file],
              { provider: Providers.OPENAI, onValidationFailure },
              mockStrategyFunctions,
            ),
          ).rejects.toThrow('PDF validation failed: PDF file size (2MB) exceeds the 1MB limit');
        },
      );

      it('throws the unchanged Bedrock capacity error', async () => {
        const req = createMockRequest() as ServerRequest;
        const file = createMockDocFile(5, 'text/csv', 'large.csv');
        serveContents(new Map([[file.file_id, Buffer.alloc(mbToBytes(5))]]));

        await expect(
          encodeAndFormatDocuments(
            req,
            [file],
            { provider: Providers.BEDROCK },
            mockStrategyFunctions,
          ),
        ).rejects.toThrow(
          'Document validation failed: File size (5.0MB) exceeds the 4.5MB limit for Bedrock',
        );
      });

      it('throws the unchanged generic capacity error', async () => {
        const req = createMockRequest(1, Providers.ANTHROPIC) as ServerRequest;
        const file = createMockDocFile(2, 'text/plain', 'large.txt');
        serveContents(new Map([[file.file_id, Buffer.alloc(mbToBytes(2))]]));

        await expect(
          encodeAndFormatDocuments(
            req,
            [file],
            { provider: Providers.ANTHROPIC },
            mockStrategyFunctions,
          ),
        ).rejects.toThrow('File size (~2.0MB) exceeds the configured limit for anthropic');
      });

      it('logs and leaves out unreadable and unstored files and keeps an empty one in files', async () => {
        const files = serveUnreadableSet();

        const result = await encodeUnreadableSet(files);

        expect(result).not.toHaveProperty('rejected');
        expect(result.files).toEqual([files.empty, files.readable]);
        expect(result.documents).toEqual([expect.objectContaining({ type: 'file' })]);
      });

      it('leaves out a file no block format exists for without recording it', async () => {
        const req = createMockRequest() as ServerRequest;
        const notes = createMockDocFile(0.01, 'text/plain', 'notes.txt');
        serveContents(new Map([[notes.file_id, Buffer.from('notes')]]));

        const result = await encodeAndFormatDocuments(
          req,
          [notes],
          { provider: providerWithoutBlockFormat },
          mockStrategyFunctions,
        );

        expect(result).toEqual({ documents: [], files: [] });
      });

      it('leaves rejected off the result, including for files the provider cannot take', async () => {
        const req = createMockRequest(30, Providers.ANTHROPIC) as ServerRequest;
        const docx = createMockDocFile(
          0.01,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'report.docx',
        );
        const readme = createMockDocFile(0.01, 'text/markdown', 'readme.md');
        serveContents(new Map([[readme.file_id, Buffer.from('# heading')]]));

        const anthropicResult = await encodeAndFormatDocuments(
          req,
          [docx, readme],
          { provider: Providers.ANTHROPIC },
          mockStrategyFunctions,
        );
        const azureResult = await encodeAndFormatDocuments(
          req,
          [readme],
          { provider: Providers.AZURE },
          mockStrategyFunctions,
        );

        expect(anthropicResult).not.toHaveProperty('rejected');
        expect(anthropicResult.files).toEqual([readme]);
        expect(azureResult).toEqual({ documents: [], files: [] });
      });
    });
  });
});
