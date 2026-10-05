/* eslint-disable i18next/no-literal-string */
import React from 'react';
import type { TFile, TMessage, TFileReadingNotice } from 'librechat-data-provider';
import { fireEvent, render, screen } from 'test/layout-test-utils';
import { getFileType } from '~/utils';
import Files from '../Files';

let mockFileMap: Record<string, Partial<TFile>> = {};

jest.mock('~/Providers', () => ({
  useFileMapContext: () => mockFileMap,
  useShareContext: () => ({}),
}));
jest.mock('../Image', () => ({ alignRight }: { alignRight?: boolean }) => (
  <div data-testid="image-preview" data-aligned-right={String(alignRight)}>
    image preview
  </div>
));
jest.mock(
  '../FilePreviewDialog',
  () =>
    ({ open, deliveryPath }: { open: boolean; deliveryPath?: string }) =>
      open ? <div>preview: {deliveryPath}</div> : null,
);

const PDF_TITLE = getFileType('application/pdf').title;

beforeEach(() => {
  mockFileMap = {};
});

const renderFiles = (files: Partial<TFile>[]) => render(<Files message={{ files } as TMessage} />);

const report = (reading?: TFileReadingNotice): Partial<TFile> => ({
  file_id: 'report',
  filename: 'report.pdf',
  type: 'application/pdf',
  reading,
});

/** Stands in for a server newer than this client, which can name readers this build has no words for. */
const futureNotice = (reader: string, limitation?: string) =>
  ({ reader, limitation }) as TFileReadingNotice;

it('exposes extracted image text without changing ordinary image previews', () => {
  renderFiles([
    { file_id: 'text-image', filename: 'scan.png', type: 'image/png', llmDeliveryPath: 'text' },
    { file_id: 'image', type: 'image/png' },
  ]);
  expect(screen.getAllByText('image preview')).toHaveLength(1);
  expect(screen.getByTestId('image-preview')).toHaveAttribute('data-aligned-right', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'scan.png' }));
  expect(screen.getByText('preview: text')).toBeInTheDocument();
});

describe('reading notice', () => {
  it.each([
    ['provider', 'Sent to the model'],
    ['text', 'Included as text'],
    ['search', 'Searchable with File Search'],
    ['code', 'Available to Run Code'],
    ['unavailable', 'Not read in this message'],
  ] as const)('captions a file read by %s in place of its type', (reader, caption) => {
    renderFiles([report({ reader })]);
    expect(screen.getByText(caption)).toBeInTheDocument();
    expect(screen.queryByText(PDF_TITLE)).not.toBeInTheDocument();
  });

  it.each([
    ['code_unavailable', "spreadsheet analysis isn't available here"],
    ['too_large_direct', 'too large to send directly'],
    ['text_too_long', 'text too long to include'],
    ['text_truncated', 'only the beginning fit'],
    ['too_large_together', "didn't fit with the other attachments"],
    ['not_prepared', "couldn't be prepared for this message"],
    ['text_only', 'only extracted text was kept'],
    ['not_allowed', 'not allowed for this model'],
    ['no_reader', 'no available tool can read this type'],
    ['original_missing', 'the original file is no longer available'],
  ] as const)('states the %s limitation alongside the reader', (limitation, reason) => {
    renderFiles([report({ reader: 'unavailable', limitation })]);
    expect(screen.getByText(`Not read in this message (${reason})`)).toBeInTheDocument();
  });

  it('carries the notice in the accessible name of the chip', () => {
    renderFiles([report({ reader: 'search', limitation: 'too_large_direct' })]);
    expect(
      screen.getByRole('button', {
        name: 'report.pdf: Searchable with File Search (too large to send directly)',
      }),
    ).toBeInTheDocument();
  });

  it('keeps the file type and the bare filename without a notice', () => {
    renderFiles([report()]);
    expect(screen.getByText(PDF_TITLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'report.pdf' })).toBeInTheDocument();
  });

  it('falls back to the file type for a reader it does not recognize', () => {
    renderFiles([report(futureNotice('preparing', 'text_too_long'))]);
    expect(screen.getByText(PDF_TITLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'report.pdf' })).toBeInTheDocument();
    expect(screen.queryByText(/text too long/)).not.toBeInTheDocument();
  });

  it('shows the reader alone for a limitation it does not recognize', () => {
    renderFiles([report(futureNotice('code', 'quota_exceeded'))]);
    expect(screen.getByRole('button', { name: 'report.pdf: Available to Run Code' })).toBeVisible();
    expect(screen.queryByText(/quota/)).not.toBeInTheDocument();
  });

  it('keeps the notice the message carries when the file map supplies the delivery path', () => {
    mockFileMap = { report: { file_id: 'report', llmDeliveryPath: 'none' } };
    renderFiles([report({ reader: 'code' })]);
    fireEvent.click(screen.getByRole('button', { name: 'report.pdf: Available to Run Code' }));
    expect(screen.getByText('preview: none')).toBeInTheDocument();
  });

  it('shows an image nothing read as a captioned chip, not a delivered-looking preview', () => {
    renderFiles([
      {
        file_id: 'scan',
        filename: 'scan.tiff',
        type: 'image/tiff',
        reading: { reader: 'unavailable', limitation: 'not_allowed' },
      },
    ]);
    expect(screen.queryByTestId('image-preview')).not.toBeInTheDocument();
    expect(
      screen.getByText('Not read in this message (not allowed for this model)'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'scan.tiff: Not read in this message (not allowed for this model)',
      }),
    ).toBeInTheDocument();
  });

  it('keeps the preview for an image a reader took', () => {
    renderFiles([
      {
        file_id: 'photo',
        filename: 'photo.png',
        type: 'image/png',
        reading: { reader: 'provider' },
      },
    ]);
    expect(screen.getByTestId('image-preview')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /photo\.png/ })).not.toBeInTheDocument();
  });

  it('gives the caption the subtitle typography, room to wrap, and its full text on hover', () => {
    renderFiles([report({ reader: 'search', limitation: 'too_large_direct' })]);
    const caption = screen.getByText('Searchable with File Search (too large to send directly)');
    expect(caption).toHaveClass('text-text-secondary', 'break-words');
    expect(caption).not.toHaveClass('truncate');
    expect(caption).toHaveAttribute(
      'title',
      'Searchable with File Search (too large to send directly)',
    );
  });

  it('still opens the preview from a captioned chip', () => {
    renderFiles([{ ...report({ reader: 'provider' }), llmDeliveryPath: 'provider' }]);
    fireEvent.click(screen.getByRole('button', { name: 'report.pdf: Sent to the model' }));
    expect(screen.getByText('preview: provider')).toBeInTheDocument();
  });
});
