import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { Readable } from 'stream';
import { FileSources, megabyte } from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import type { UploadFallbackTextExtractors } from '~/files/upload/fallback';
import type { ProvisionService } from '~/files/provision/service';
import type { TurnReadingFile } from './turn';
import type { ServerRequest } from '~/types';
import { DOCUMENT_PARSER_MAX_FILE_SIZE, parseDocument } from '~/files/documents/crud';
import { AttachmentObjectNotFoundError } from '~/files/encode/utils';
import { MAX_STORED_EXTRACTED_TEXT_BYTES } from '~/files/extract';
import { ContentFilterError } from '~/middleware/contentFilter';
import { UninspectableFileError } from '~/protection/files';
import { createFileTextDeriver } from './derive';
import { parseTextNative } from '~/files/text';

type OpenStoredFile = ProvisionService['openStoredFile'];

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const documentsDir = path.join(__dirname, '../documents');

let workDir: string;
let sequence = 0;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-derive-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const newRequest = (): ServerRequest => ({}) as ServerRequest;

/** A deferred message attachment whose original lives at `sourcePath` in local storage. */
function storedFile(
  overrides: Partial<TurnReadingFile> & Pick<TurnReadingFile, 'type' | 'filename'>,
): TurnReadingFile {
  sequence += 1;
  return {
    file_id: `derive-spec-${process.pid}-${sequence}`,
    source: FileSources.local,
    filepath: `/uploads/u1/${overrides.filename}`,
    bytes: 1024,
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
    ...overrides,
  };
}

/** Local storage: every open streams the file at `sourcePath`, observed. */
const localStorage = (sourcePath: string) =>
  jest.fn<ReturnType<OpenStoredFile>, Parameters<OpenStoredFile>>(async () =>
    fs.createReadStream(sourcePath),
  );

function writeSource(name: string, content: string | Buffer): string {
  const filePath = path.join(workDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

const tempCopies = (file: TurnReadingFile): string[] =>
  fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`derive-${file.file_id}-`));

/** The real built-in extractors, observed. */
function spiedExtractors() {
  return {
    parseDocument: jest.fn(parseDocument),
    parseTextNative: jest.fn(parseTextNative),
  } satisfies UploadFallbackTextExtractors;
}

describe('createFileTextDeriver', () => {
  it('derives a workbook from its stored original with the document parser', async () => {
    const req = newRequest();
    const file = storedFile({ type: XLSX, filename: 'sample.xlsx' });
    const samplePath = path.join(documentsDir, 'sample.xlsx');
    const openStoredFile = localStorage(samplePath);
    const extractors = spiedExtractors();

    const result = await createFileTextDeriver({ req, openStoredFile, extractors })(file);

    expect(result).toEqual({
      status: 'derived',
      text: 'Sheet One:\nData,on,first,sheet\nSecond Sheet:\nData,On\nSecond,Sheet\n',
      textDerivation: { outcome: 'complete', extractor: 'document_parser', at: expect.any(Number) },
    });
    expect(openStoredFile).toHaveBeenCalledWith(file, req, undefined);
    expect(extractors.parseDocument).toHaveBeenCalledWith({
      file: expect.objectContaining({
        originalname: 'sample.xlsx',
        mimetype: XLSX,
        size: fs.statSync(samplePath).size,
      }),
    });
    expect(extractors.parseTextNative).not.toHaveBeenCalled();
    expect(tempCopies(file)).toEqual([]);
  });

  it('derives a CSV with the native reader', async () => {
    const content = 'region,total\nwest,4';
    const file = storedFile({ type: 'text/csv', filename: 'sales.csv', bytes: content.length });
    const extractors = spiedExtractors();

    const result = await createFileTextDeriver({
      req: newRequest(),
      openStoredFile: localStorage(writeSource('sales.csv', content)),
      extractors,
    })(file);

    expect(result).toEqual({
      status: 'derived',
      text: content,
      textDerivation: { outcome: 'complete', extractor: 'native_text', at: expect.any(Number) },
    });
    expect(extractors.parseTextNative).toHaveBeenCalledTimes(1);
    expect(extractors.parseDocument).not.toHaveBeenCalled();
  });

  it('fails too_large from the record alone, without opening the original', async () => {
    const openStoredFile = localStorage(path.join(documentsDir, 'sample.xlsx'));
    const derive = createFileTextDeriver({ req: newRequest(), openStoredFile });

    await expect(
      derive(
        storedFile({
          type: XLSX,
          filename: 'big.xlsx',
          bytes: DOCUMENT_PARSER_MAX_FILE_SIZE + 1,
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      textDerivation: {
        outcome: 'failed',
        extractor: 'document_parser',
        reason: 'too_large',
        at: expect.any(Number),
      },
      persist: true,
    });
    await expect(
      derive(
        storedFile({
          type: 'text/csv',
          filename: 'big.csv',
          bytes: MAX_STORED_EXTRACTED_TEXT_BYTES + 1,
        }),
      ),
    ).resolves.toMatchObject({ status: 'failed', textDerivation: { reason: 'too_large' } });
    expect(openStoredFile).not.toHaveBeenCalled();
  });

  it('fails expansion_limit for a workbook that inflates past the zip guard', async () => {
    const zip = new JSZip();
    zip.file('xl/worksheets/sheet1.xml', Buffer.alloc(26 * megabyte, 0));
    const bomb = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    const file = storedFile({ type: XLSX, filename: 'bomb.xlsx', bytes: bomb.length });

    await expect(
      createFileTextDeriver({
        req: newRequest(),
        openStoredFile: localStorage(writeSource('bomb.xlsx', bomb)),
      })(file),
    ).resolves.toMatchObject({
      status: 'failed',
      textDerivation: { outcome: 'failed', reason: 'expansion_limit' },
      persist: true,
    });
  });

  it('fails empty for a document without text and for blank text', async () => {
    await expect(
      createFileTextDeriver({
        req: newRequest(),
        openStoredFile: localStorage(path.join(documentsDir, 'empty.docx')),
      })(storedFile({ type: DOCX, filename: 'empty.docx' })),
    ).resolves.toMatchObject({
      status: 'failed',
      textDerivation: { reason: 'empty', extractor: 'document_parser' },
      persist: true,
    });
    await expect(
      createFileTextDeriver({
        req: newRequest(),
        openStoredFile: localStorage(writeSource('blank.csv', ' \n ')),
      })(storedFile({ type: 'text/csv', filename: 'blank.csv' })),
    ).resolves.toMatchObject({ status: 'failed', textDerivation: { reason: 'empty' } });
  });

  it('blocks text a content policy flags or cannot inspect with its policy error', async () => {
    const flagging: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private token', regex: 'PRIVATE-[A-Z]+' }],
        },
      },
    };
    const blocking: FiltersConfig = {
      files: { pii: { fields: ['extracted_text'], starterPatterns: [], uninspectable: 'block' } },
    };

    await expect(
      createFileTextDeriver({
        req: newRequest(),
        filters: flagging,
        openStoredFile: localStorage(writeSource('flagged.csv', 'token,PRIVATE-SECRET')),
      })(storedFile({ type: 'text/csv', filename: 'flagged.csv' })),
    ).resolves.toEqual({ status: 'blocked', error: expect.any(ContentFilterError) });
    await expect(
      createFileTextDeriver({
        req: newRequest(),
        filters: blocking,
        openStoredFile: localStorage(path.join(documentsDir, 'empty.docx')),
      })(storedFile({ type: DOCX, filename: 'empty.docx' })),
    ).resolves.toEqual({ status: 'blocked', error: expect.any(UninspectableFileError) });
  });

  it('fails original_missing, which persists, when storage no longer holds the original', async () => {
    const missing = [
      localStorage(path.join(workDir, 'deleted.csv')),
      jest.fn<ReturnType<OpenStoredFile>, Parameters<OpenStoredFile>>(async (file) => {
        throw new AttachmentObjectNotFoundError(file.file_id);
      }),
      jest.fn<ReturnType<OpenStoredFile>, Parameters<OpenStoredFile>>(async () => {
        throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      }),
    ];
    for (const openStoredFile of missing) {
      const file = storedFile({ type: 'text/csv', filename: 'deleted.csv' });
      await expect(
        createFileTextDeriver({ req: newRequest(), openStoredFile })(file),
      ).resolves.toEqual({
        status: 'failed',
        textDerivation: {
          outcome: 'failed',
          extractor: 'native_text',
          reason: 'original_missing',
          at: expect.any(Number),
        },
        persist: true,
      });
      expect(tempCopies(file)).toEqual([]);
    }
  });

  it('skips a transient storage error and a source with no download contract', async () => {
    const throwing = (error: Error) =>
      jest.fn<ReturnType<OpenStoredFile>, Parameters<OpenStoredFile>>(async () => {
        throw error;
      });
    const unreachable = throwing(new Error('socket hang up'));
    const missingBucket = throwing(
      Object.assign(new Error('The specified bucket does not exist'), {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const bareNotFound = throwing(Object.assign(new Error('Not Found'), { status: 404 }));
    const noContract = jest.fn<ReturnType<OpenStoredFile>, Parameters<OpenStoredFile>>(
      async () => null,
    );

    for (const openStoredFile of [unreachable, missingBucket, bareNotFound, noContract]) {
      await expect(
        createFileTextDeriver({ req: newRequest(), openStoredFile })(
          storedFile({ type: 'text/csv', filename: 'later.csv' }),
        ),
      ).resolves.toEqual({ status: 'skipped', reason: 'storage_unavailable' });
    }
  });

  it('skips a type no built-in extractor reads without opening it', async () => {
    const openStoredFile = localStorage(path.join(documentsDir, 'sample.xlsx'));

    await expect(
      createFileTextDeriver({ req: newRequest(), openStoredFile })(
        storedFile({ type: 'application/zip', filename: 'bundle.zip' }),
      ),
    ).resolves.toEqual({ status: 'skipped', reason: 'no_extractor' });
    expect(openStoredFile).not.toHaveBeenCalled();
  });

  it('removes the temporary copy when the request is aborted mid-download', async () => {
    const controller = new AbortController();
    const file = storedFile({ type: 'text/csv', filename: 'slow.csv' });
    const source = new Readable({ read() {} });
    source.push('region,total\n');
    let markOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve;
    });
    const openStoredFile = jest.fn<ReturnType<OpenStoredFile>, Parameters<OpenStoredFile>>(
      async () => {
        markOpened();
        return source;
      },
    );

    const pending = createFileTextDeriver({ req: newRequest(), openStoredFile })(
      file,
      controller.signal,
    );
    await opened;
    for (let attempt = 0; attempt < 50 && tempCopies(file).length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(tempCopies(file)).toHaveLength(1);

    controller.abort();

    await expect(pending).resolves.toEqual({ status: 'skipped', reason: 'aborted' });
    expect(tempCopies(file)).toEqual([]);
    expect(source.destroyed).toBe(true);
  });

  it('skips, without keeping anything, when the temporary copy cannot be written', async () => {
    const file = storedFile({ type: 'text/csv', filename: 'nowhere.csv' });
    const tmpdir = jest.spyOn(os, 'tmpdir').mockReturnValue(path.join(workDir, 'missing-tmp'));
    try {
      await expect(
        createFileTextDeriver({
          req: newRequest(),
          openStoredFile: localStorage(writeSource('nowhere.csv', 'a,b')),
        })(file),
      ).resolves.toEqual({ status: 'skipped', reason: 'storage_unavailable' });
    } finally {
      tmpdir.mockRestore();
    }
  });

  it('derives each file once per deriver, which the host builds once per request', async () => {
    const file = storedFile({ type: 'text/csv', filename: 'once.csv' });
    const openStoredFile = localStorage(writeSource('once.csv', 'a,b'));
    const derive = createFileTextDeriver({ req: newRequest(), openStoredFile });

    const [a, b] = await Promise.all([derive(file), derive({ ...file })]);

    expect(a).toBe(b);
    expect(a).toMatchObject({ status: 'derived', text: 'a,b' });
    expect(openStoredFile).toHaveBeenCalledTimes(1);

    await createFileTextDeriver({ req: newRequest(), openStoredFile })(file);
    expect(openStoredFile).toHaveBeenCalledTimes(2);
  });

  it('forgets a derivation its caller aborted, so the next caller derives under its own signal', async () => {
    const file = storedFile({ type: 'text/csv', filename: 'retry.csv' });
    const openStoredFile = localStorage(writeSource('retry.csv', 'a,b'));
    const derive = createFileTextDeriver({ req: newRequest(), openStoredFile });

    await expect(derive(file, AbortSignal.abort())).resolves.toEqual({
      status: 'skipped',
      reason: 'aborted',
    });
    await new Promise((resolve) => setImmediate(resolve));

    await expect(derive(file)).resolves.toMatchObject({ status: 'derived', text: 'a,b' });
    expect(openStoredFile).toHaveBeenCalledTimes(1);
  });
});
