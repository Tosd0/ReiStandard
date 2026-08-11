/**
 * last_error 是唯一一列明文落库的「为什么没发出去」，所以长得像凭据的串一律
 * 遮掉。但脱敏不能把有用的东西一起吃了——模型 ID 长得跟「短前缀 + 长随机串」
 * 的 key 很像，遮掉它，上游那句「你写的这个模型不存在」就只剩「有个东西不存
 * 在」，而模型名写错正是这套错误细节要解决的头号场景。
 *
 * 遮什么、怎么遮由 @rei-standard/amsg-shared 的 redactCredentials 说了算
 * （规则本身的用例在 shared/test/redact-credentials.test.mjs）；这里盯的是
 * server 这一侧确实走了那条规则，以及 500 字符的截断。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeErrorSummary } from '../src/server/lib/errors.js';

describe('错误摘要脱敏', () => {
  it('模型 ID 原样留着', () => {
    for (const model of [
      'gpt-4o-mini-2024-07-18',
      'claude-3-5-sonnet-20241022',
      'gpt-4-turbo-preview-2024-04-09',
      'gemini-2.0-flash-thinking-exp-01-21',
      'text-embedding-3-small',
      'deepseek-reasoner',
    ]) {
      const summary = sanitizeErrorSummary(`The model \`${model}\` does not exist`);
      assert.match(summary, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), summary);
    }
  });

  it('「短前缀 + 长随机串」的 key 照旧遮掉', () => {
    for (const [text, secret] of [
      ['Incorrect API key provided: sk-proj-AbCdEf0123456789GhIjKlMn.', 'sk-proj-AbCdEf0123456789GhIjKlMn'],
      ['auth failed for xai-AbCdEfGh01234567890123456789', 'xai-AbCdEfGh01234567890123456789'],
      ['Authorization: Bearer sk-abc123def456ghi789jkl', 'sk-abc123def456ghi789jkl'],
      // 尾巴带 `-` / `_` 的 Key：只遮掉前半截同样是把凭据写进了明文列。
      ['Incorrect API key provided: sk-9aBcDeFgHiJkLmNo_PqRsTu', 'sk-9aBcDeFgHiJkLmNo_PqRsTu'],
      ['Incorrect API key provided: sk-abcd_efgh_ijkl_mnop_qrst', 'sk-abcd_efgh_ijkl_mnop_qrst'],
    ]) {
      const summary = sanitizeErrorSummary(text);
      assert.ok(!summary.includes(secret), `凭据没遮住：${summary}`);
      for (const segment of secret.split(/[-_]/)) {
        if (segment.length < 6) continue;
        assert.ok(!summary.includes(segment), `凭据只遮了一半，${segment} 还在：${summary}`);
      }
      assert.match(summary, /redacted/);
    }
  });

  it('超长的摘要截断到 500 字符', () => {
    // 用带空格的长句：连成一整串的长随机串会先被当成 base64 片段遮掉，量不到截断。
    const summary = sanitizeErrorSummary(`upstream said: ${'blah '.repeat(400)}`);
    assert.equal(summary.length, 498);
    assert.ok(summary.endsWith('…'), summary.slice(-10));
  });
});
