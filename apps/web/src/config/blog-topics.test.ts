import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blogThemeIds } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { blogTopics, topicHref } from './blog-topics.js';

// `apps/web/public/` — where Astro serves the topic illustrations from,
// resolved relative to this test so it runs the same from any `vitest`
// invocation (the same approach `services.test.ts` takes for its icons).
const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));

describe('blog topics config', () => {
  it('has exactly one topic per blog theme, in the catalogue order', () => {
    expect(blogTopics('en').map((topic) => topic.id)).toEqual([...blogThemeIds]);
  });

  it('every topic resolves to a real label in the default locale', () => {
    for (const topic of blogTopics('en')) {
      expect(topic.label, `${topic.id} has no label`).not.toBe('');
    }
  });

  it('every topic points at an illustration that actually exists in public/', () => {
    for (const topic of blogTopics('en')) {
      const file = join(publicDir, topic.icon.replace(/^\//, ''));
      expect(existsSync(file), `${topic.id} icon missing: ${topic.icon}`).toBe(true);
    }
  });

  it('links each topic to its own archive under the locale', () => {
    expect(topicHref('en', 'pain-science')).toBe('/en/blog/topic/pain-science');
    for (const topic of blogTopics('en')) {
      expect(topic.href).toBe(`/en/blog/topic/${topic.id}`);
    }
  });
});
