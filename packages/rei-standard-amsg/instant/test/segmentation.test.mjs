import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentTextWithProtectedBlocks } from '../src/segmentation.js';

test('segmentation utility', async (t) => {
  const defaultOptions = {
    splitText: (text) => text.split('\n'),
    sanitizeText: (text) => text.trim(),
  };

  await t.test('1. splits normal text with splitText', () => {
    const text = 'hello\nworld\n!';
    const result = segmentTextWithProtectedBlocks(text, defaultOptions);
    assert.deepEqual(result, [
      { raw: 'hello', sanitized: 'hello', protect: false },
      { raw: 'world', sanitized: 'world', protect: false },
      { raw: '!', sanitized: '!', protect: false },
    ]);
  });

  await t.test('2. single multi-line protected block is not split', () => {
    const text = '```html\n<div>\n  test\n</div>\n```';
    const result = segmentTextWithProtectedBlocks(text, {
      ...defaultOptions,
      protectedPatterns: [
        { pattern: /```[\s\S]*?```/ }
      ]
    });
    assert.deepEqual(result, [
      {
        raw: '```html\n<div>\n  test\n</div>\n```',
        sanitized: '```html\n<div>\n  test\n</div>\n```',
        protect: true
      }
    ]);
  });

  await t.test('3. plain text around protected block is split normally', () => {
    const text = 'line 1\n```code\nline 2\nline 3\n```\nline 4';
    const result = segmentTextWithProtectedBlocks(text, {
      ...defaultOptions,
      protectedPatterns: [
        { pattern: /```[\s\S]*?```/ }
      ]
    });
    assert.deepEqual(result, [
      { raw: 'line 1', sanitized: 'line 1', protect: false },
      { raw: '```code\nline 2\nline 3\n```', sanitized: '```code\nline 2\nline 3\n```', protect: true },
      { raw: 'line 4', sanitized: 'line 4', protect: false },
    ]);
  });

  await t.test('4. multiple sequential protected blocks maintain order', () => {
    const text = '[[A]]\nbetween\n[[B]]';
    const result = segmentTextWithProtectedBlocks(text, {
      ...defaultOptions,
      protectedPatterns: [
        { pattern: /\[\[.*?\]\]/ }
      ]
    });
    assert.deepEqual(result, [
      { raw: '[[A]]', sanitized: '[[A]]', protect: true },
      { raw: 'between', sanitized: 'between', protect: false },
      { raw: '[[B]]', sanitized: '[[B]]', protect: true },
    ]);
  });

  await t.test('5. preview is used for sanitized, but raw keeps original text', () => {
    const text = '<think>\nprocessing...\n</think>\nanswer';
    const result = segmentTextWithProtectedBlocks(text, {
      ...defaultOptions,
      protectedPatterns: [
        {
          pattern: /<think>[\s\S]*?<\/think>/,
          preview: '[Thought Process]',
          meta: { type: 'thought' }
        }
      ]
    });
    assert.deepEqual(result, [
      {
        raw: '<think>\nprocessing...\n</think>',
        sanitized: '[Thought Process]',
        protect: true,
        meta: { type: 'thought' }
      },
      { raw: 'answer', sanitized: 'answer', protect: false }
    ]);
  });

  await t.test('6. fallbacks to sanitizeText/raw when preview is not provided', () => {
    const text = '<<RAW>>';
    const result = segmentTextWithProtectedBlocks(text, {
      splitText: (t) => [t],
      sanitizeText: (t) => t.replace(/[<>]/g, ''),
      protectedPatterns: [
        { pattern: /<<.*?>>/ }
      ]
    });
    assert.deepEqual(result, [
      {
        raw: '<<RAW>>',
        sanitized: 'RAW', // Fallback to sanitizeText
        protect: true
      }
    ]);
  });

  await t.test('7. acts like splitText + sanitizeText when protectedPatterns is omitted', () => {
    const text = 'foo\nbar';
    const result = segmentTextWithProtectedBlocks(text, defaultOptions);
    assert.deepEqual(result, [
      { raw: 'foo', sanitized: 'foo', protect: false },
      { raw: 'bar', sanitized: 'bar', protect: false }
    ]);
  });

  await t.test('8. handles overlapping patterns (earliest match wins, then longest)', () => {
    // Pattern 1: [A-B]
    // Pattern 2: [A-C]
    // Text: [A-C]
    const text = '123456';
    const result = segmentTextWithProtectedBlocks(text, {
      ...defaultOptions,
      splitText: (t) => [t],
      protectedPatterns: [
        { pattern: /234/, preview: 'short' },
        { pattern: /2345/, preview: 'long' }
      ]
    });
    
    // Earliest match is at index 1 for both. The longest should win (2345).
    assert.deepEqual(result, [
      { raw: '1', sanitized: '1', protect: false },
      { raw: '2345', sanitized: 'long', protect: true },
      { raw: '6', sanitized: '6', protect: false }
    ]);
  });
});
