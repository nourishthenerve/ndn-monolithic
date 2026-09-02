// 2026-09-02: the form's starting state, and specifically the one field in
// it that decides whether anything a person writes is ever readable.
//
// The owner reported the blog and workshop tabs as empty twice. Both times
// the content had saved correctly — as a **draft**, because "Publish
// straight away" started unticked and the public read endpoint returns
// published items only (`services/api/src/content-repository.ts`). So
// "Save" did exactly what it said and nothing anyone wanted: the post
// existed, and no reader could reach it.
//
// Asserted on the *default object* rather than through the rendered form,
// because the default is the whole bug: every other part of the chain was
// already correct and stayed untouched.
import { describe, expect, it } from 'vitest';

import {
  buildCreateBlogRequestBody,
  buildCreateWorkshopRequestBody,
} from './authoring-request.js';
import { EMPTY_BLOG, EMPTY_WORKSHOP } from './AuthoringPanel.js';

describe('a new post publishes unless you say otherwise', () => {
  it('starts with "publish straight away" on, for both forms', () => {
    expect(EMPTY_BLOG.publishNow).toBe(true);
    expect(EMPTY_WORKSHOP.publishNow).toBe(true);
  });

  it('sends status "published" for an untouched blog form', () => {
    // The one field the public read filters on. `draft` here is the bug.
    expect(buildCreateBlogRequestBody({ ...EMPTY_BLOG, id: 'a-post' }).status).toBe('published');
  });

  it('sends status "published" for an untouched workshop form', () => {
    const body = buildCreateWorkshopRequestBody(
      { ...EMPTY_WORKSHOP, id: 'a-workshop' },
      '2026-10-01T10:00:00.000Z',
    );
    expect(body.status).toBe('published');
  });

  it('still sends "draft" when the box is unticked — the rare case is one click, not unavailable', () => {
    expect(
      buildCreateBlogRequestBody({ ...EMPTY_BLOG, id: 'a-post', publishNow: false }).status,
    ).toBe('draft');
  });
});
