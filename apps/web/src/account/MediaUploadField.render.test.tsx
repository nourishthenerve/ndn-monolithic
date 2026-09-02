// @vitest-environment jsdom
// 2026-09-02: the image control both authoring forms use.
//
// What is worth testing here is not the happy path — it is the ordering.
// `onUploaded` must fire only once the object exists, because the key it
// reports is about to be written into a record that will outlive the
// upload URL. A component that reported the key on presign would produce
// posts pointing at objects nobody ever uploaded, and the page would show
// a broken image with no way to tell why.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionClient } from '../auth/session.js';

import { MediaUploadField, MAX_IMAGE_BYTES } from './MediaUploadField.js';

afterEach(cleanup);

const STRINGS = {
  label: 'Image (optional)',
  hint: 'A JPEG, PNG or WebP up to 5 MB.',
  uploading: 'Uploading the image…',
  uploaded: 'Image uploaded.',
  remove: 'Remove image',
  tooLarge: 'That image is larger than 5 MB.',
  wrongType: 'That file type is not supported.',
  failed: 'That image could not be uploaded. Please try again.',
  previewAlt: 'Preview of the image you uploaded',
};

const signedIn: SessionClient = {
  authorization: () => Promise.resolve('token-1'),
} as unknown as SessionClient;

function fileOf(name: string, type: string, size = 1024): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function ok(body: unknown): Response {
  return { ok: true, status: 201, json: () => Promise.resolve(body) } as Response;
}

function renderField(overrides: Partial<Parameters<typeof MediaUploadField>[0]> = {}) {
  const onUploaded = vi.fn();
  const requestUploadUrl = vi
    .fn()
    .mockResolvedValue(ok({ uploadUrl: 'https://s3.example/signed', key: 'media/content/id-a.png' }));
  const putFile = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
  const result = render(
    <MediaUploadField
      strings={STRINGS}
      presignPath="/content/media-upload-url"
      client={signedIn}
      onUploaded={onUploaded}
      requestUploadUrl={requestUploadUrl}
      putFile={putFile}
      {...overrides}
    />,
  );
  return { ...result, onUploaded, requestUploadUrl, putFile };
}

function choose(file: File) {
  const input = screen.getByLabelText(STRINGS.label);
  fireEvent.change(input, { target: { files: [file] } });
}

describe('MediaUploadField', () => {
  it('presigns, uploads, and reports the key from the presign — not from the PUT', async () => {
    const { onUploaded, requestUploadUrl, putFile } = renderField();

    choose(fileOf('hero.png', 'image/png'));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith('media/content/id-a.png'));
    expect(requestUploadUrl).toHaveBeenCalledWith('token-1', {
      fileName: 'hero.png',
      contentType: 'image/png',
    });
    expect(putFile).toHaveBeenCalledWith('https://s3.example/signed', expect.any(File));
  });

  it('does not report a key when the upload itself fails', async () => {
    // The object does not exist. Reporting the key anyway would write a
    // record pointing at nothing — a broken image on a published page,
    // and nothing in the data to say why.
    const { onUploaded } = renderField({
      putFile: vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response),
    });

    choose(fileOf('hero.png', 'image/png'));

    expect(await screen.findByText(STRINGS.failed)).toBeTruthy();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('does not report a key when the presign is refused', async () => {
    const { onUploaded, putFile } = renderField({
      requestUploadUrl: vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response),
    });

    choose(fileOf('hero.png', 'image/png'));

    expect(await screen.findByText(STRINGS.failed)).toBeTruthy();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(putFile).not.toHaveBeenCalled();
  });

  it('refuses an unsupported type before asking for a URL', async () => {
    const { requestUploadUrl } = renderField();

    choose(fileOf('notes.pdf', 'application/pdf'));

    expect(await screen.findByText(STRINGS.wrongType)).toBeTruthy();
    // A presigned URL minted for a file the server will refuse is a
    // capability issued for nothing.
    expect(requestUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses an oversized file before asking for a URL', async () => {
    const { requestUploadUrl } = renderField();

    choose(fileOf('huge.jpg', 'image/jpeg', MAX_IMAGE_BYTES + 1));

    expect(await screen.findByText(STRINGS.tooLarge)).toBeTruthy();
    expect(requestUploadUrl).not.toHaveBeenCalled();
  });

  it('shows the uploaded image back, from its public URL', async () => {
    renderField({ value: 'media/content/id-a.png' });

    const image = await screen.findByAltText(STRINGS.previewAlt);
    expect(image.getAttribute('src')).toBe('/media/content/id-a.png');
  });

  it('renders no preview for a key outside the public prefix', () => {
    // `mediaUrl` refuses it, and the component renders nothing rather than
    // a broken `src` — the case that matters is a key naming an assessment
    // attachment, where a working link would be the actual harm.
    renderField({ value: 'assessments/pat-1/scan.pdf' });

    expect(screen.queryByAltText(STRINGS.previewAlt)).toBeNull();
  });

  it('clears the key when the image is removed', async () => {
    const { onUploaded } = renderField({ value: 'media/content/id-a.png' });

    fireEvent.click(await screen.findByRole('button', { name: STRINGS.remove }));

    expect(onUploaded).toHaveBeenCalledWith(undefined);
  });

  it('reports a failure rather than uploading when there is no session', async () => {
    const { onUploaded, requestUploadUrl } = renderField({
      client: { authorization: () => Promise.resolve(undefined) } as unknown as SessionClient,
    });

    choose(fileOf('hero.png', 'image/png'));

    expect(await screen.findByText(STRINGS.failed)).toBeTruthy();
    expect(requestUploadUrl).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
  });
});
