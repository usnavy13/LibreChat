import { FileSources, mergeFileConfig } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { extractFileContext, getAttachmentTitleText, resolveFileTokenLimit } from './context';

const file = (filename?: string): TFile => ({ filename }) as TFile;

describe('getAttachmentTitleText', () => {
  it('returns an empty string when there are no files', () => {
    expect(getAttachmentTitleText()).toBe('');
    expect(getAttachmentTitleText(null)).toBe('');
    expect(getAttachmentTitleText([])).toBe('');
  });

  it('lists a single filename', () => {
    expect(getAttachmentTitleText([file('report.pdf')])).toBe('Attached file(s): report.pdf');
  });

  it('lists every filename', () => {
    expect(getAttachmentTitleText([file('a.pdf'), file('b.csv')])).toBe(
      'Attached file(s): a.pdf, b.csv',
    );
  });

  it('skips files that carry no filename', () => {
    expect(getAttachmentTitleText([file(), file('kept.txt')])).toBe('Attached file(s): kept.txt');
  });

  it('returns an empty string when no file has a filename', () => {
    expect(getAttachmentTitleText([file(), file()])).toBe('');
  });
});

type TextAttachment = {
  file_id: string;
  filename: string;
  text: string;
  source: string;
  llmDeliveryPath: string;
};

const textFile = (file_id: string, text: string): TextAttachment => ({
  file_id,
  filename: `${file_id}.txt`,
  text,
  source: FileSources.local,
  llmDeliveryPath: 'text',
});

const requestWithLimit = (fileTokenLimit?: number, configLimit?: number): ServerRequest =>
  ({
    body: { fileTokenLimit },
    config: { fileConfig: { fileTokenLimit: configLimit } },
  }) as ServerRequest;

describe('resolveFileTokenLimit', () => {
  it('prefers the request override over the configured limit', () => {
    expect(resolveFileTokenLimit(requestWithLimit(25, 50))).toBe(25);
  });

  it('falls back to the configured limit', () => {
    expect(resolveFileTokenLimit(requestWithLimit(undefined, 50))).toBe(50);
  });

  it('falls back to the default limit without a request', () => {
    expect(resolveFileTokenLimit()).toBe(mergeFileConfig(undefined).fileTokenLimit);
  });
});

describe('extractFileContext options', () => {
  const tokenLimit = 10;

  it('reuses a known token count instead of counting the text again', async () => {
    const tokenCountFn = jest.fn((text: string): number => text.length);
    const attachment = textFile('short', 'fits');
    const knownTokenCount = jest.fn((_file: TextAttachment): number | undefined => 4);

    const result = await extractFileContext({
      attachments: [attachment],
      req: requestWithLimit(tokenLimit),
      tokenCountFn,
      knownTokenCount,
    });

    expect(result).toContain('# "short.txt"\nfits\n');
    expect(knownTokenCount).toHaveBeenCalledWith(attachment);
    expect(tokenCountFn).not.toHaveBeenCalled();
  });

  it('never counts the full text of a truncated file whose count is known', async () => {
    const tokenCountFn = jest.fn((text: string): number => text.length);
    const longText = 'x'.repeat(50);

    await extractFileContext({
      attachments: [textFile('long', longText)],
      req: requestWithLimit(tokenLimit),
      tokenCountFn,
      knownTokenCount: () => longText.length,
    });

    expect(tokenCountFn).toHaveBeenCalled();
    expect(tokenCountFn).not.toHaveBeenCalledWith(longText);
  });

  it('counts the text when the known count is unavailable', async () => {
    const tokenCountFn = jest.fn((text: string): number => text.length);

    await extractFileContext({
      attachments: [textFile('short', 'fits')],
      req: requestWithLimit(tokenLimit),
      tokenCountFn,
      knownTokenCount: () => undefined,
    });

    expect(tokenCountFn).toHaveBeenCalledWith('fits');
  });

  it('follows truncated text with a notice only when asked to', async () => {
    const tokenCountFn = (text: string): number => text.length;
    const attachments = [textFile('long', 'x'.repeat(50)), textFile('short', 'fits')];
    const notice = '[Truncated: only the beginning of "long.txt" fits; the rest is omitted.]';

    const marked = await extractFileContext({
      attachments,
      req: requestWithLimit(tokenLimit),
      tokenCountFn,
      markTruncation: true,
    });
    const unmarked = await extractFileContext({
      attachments,
      req: requestWithLimit(tokenLimit),
      tokenCountFn,
    });

    expect(marked).toMatch(/# "long\.txt"\nx+\n\[Truncated: [^\n]+\]\n/);
    expect(marked).toContain(notice);
    expect(marked?.split('[Truncated:')).toHaveLength(2);
    expect(unmarked).not.toContain('[Truncated:');
    expect(marked?.replace(`\n${notice}`, '')).toBe(unmarked);
  });

  it('adds no notice to a file that fits', async () => {
    const result = await extractFileContext({
      attachments: [textFile('short', 'fits')],
      req: requestWithLimit(tokenLimit),
      tokenCountFn: (text: string): number => text.length,
      markTruncation: true,
    });

    expect(result).not.toContain('[Truncated:');
  });

  it('keeps the classic output byte-for-byte without options', async () => {
    const result = await extractFileContext({
      attachments: [textFile('alpha', 'first'), textFile('beta', 'y'.repeat(20))],
      req: requestWithLimit(tokenLimit),
      tokenCountFn: (text: string): number => text.length,
    });

    expect(result).toBe(
      'Attached document(s):\n```md# "alpha.txt"\nfirst\n\n\n---\n\n# "beta.txt"\nyyyyyyyyy\n\n```',
    );
  });
});
