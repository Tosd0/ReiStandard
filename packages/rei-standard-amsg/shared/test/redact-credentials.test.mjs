/**
 * 脱敏规则的单一事实来源：amsg-server 的 `sanitizeErrorSummary`（落库的
 * last_error 明文列）和 amsg-instant 的 cloudflare 适配器（跨域 502 响应体）
 * 都调这一份。
 *
 * 两头都要顾：漏掉一个 Key 就是把凭据写进明文列并回给浏览器；把模型 ID 一起
 * 遮了，上游那句「你写的这个模型不存在」就只剩「有个东西不存在」，而模型名写
 * 错正是这套错误细节要解决的头号场景。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactCredentials } from '../src/index.js';

/** 模型 ID：全小写字母数字、被 `-` / `.` 切成短段，原样留着。 */
const MODEL_IDS = [
  'gpt-4o-mini-2024-07-18',
  'claude-3-5-sonnet-20241022',
  'gpt-4-turbo-preview-2024-04-09',
  'gemini-2.0-flash-thinking-exp-01-21',
  'text-embedding-3-small',
  'deepseek-reasoner',
];

/**
 * 凭据：一律遮掉。后三条的尾巴带 `-` / `_`，按「必须以一长串字母数字收尾」去
 * 卡的话只会遮掉前半截，或者整条都遮不住。
 */
const CREDENTIALS = [
  'sk-proj-AbCdEf0123456789GhIjKlMn',
  'xai-AbCdEfGh01234567890123456789',
  'sk-abc123def456ghi789jkl',
  'sk-9aBcDeFgHiJkLmNo_PqRsTu',
  'sk-abcd_efgh_ijkl_mnop_qrst',
  'sk-ant-api03-T0k3n_W1th-Mixed_Separators-9xYz',
];

describe('redactCredentials', () => {
  it('模型 ID 原样留着', () => {
    for (const model of MODEL_IDS) {
      const out = redactCredentials(`The model \`${model}\` does not exist`);
      assert.ok(out.includes(model), `模型名被吃掉了：${out}`);
    }
  });

  it('长得像凭据的串整条遮掉，不留半截', () => {
    for (const secret of CREDENTIALS) {
      const out = redactCredentials(`Incorrect API key provided: ${secret}.`);
      assert.ok(!out.includes(secret), `凭据没遮住：${out}`);
      // 只遮掉前半截同样算漏：把 Key 按分隔符切开，任何一段都不该留在输出里。
      for (const segment of secret.split(/[-_]/)) {
        if (segment.length < 6) continue;
        assert.ok(!out.includes(segment), `凭据只遮了一半，${segment} 还在：${out}`);
      }
      assert.match(out, /\[redacted\]/);
    }
  });

  it('Bearer 头连值一起遮掉', () => {
    const out = redactCredentials('Authorization: Bearer sk-abc123def456ghi789jkl');
    assert.equal(out, 'Authorization: Bearer [redacted]');
  });

  it('光长随机串（base64 / JWT 片段）也不放行', () => {
    const blob = 'QWxhZGRpbjpvcGVuc2VzYW1lQWxhZGRpbjpvcGVuc2VzYW1l0123456789';
    const out = redactCredentials(`unexpected token ${blob} in response`);
    assert.ok(!out.includes(blob), out);
  });

  it('一句普通报错不会被改动', () => {
    const plain = 'Upstream returned 503 Service Unavailable after 3 attempts';
    assert.equal(redactCredentials(plain), plain);
  });
});
