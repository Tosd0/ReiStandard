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

/**
 * 跟模型 ID 同形的凭据：全小写、按短横线分成一串短段，光看形状跟
 * `gpt-4o-mini-2024-07-18` 分不开。one-api / new-api / LiteLLM 这类自建中转发
 * 的就是这个样子，上游 401 会把它原样回显。
 */
const MODEL_SHAPED_CREDENTIALS = [
  'sk-550e8400-e29b-41d4-a716-446655440000',
  'sk-abc123def456-ghi789jkl012',
  'key-1a2b3c4d5e6f-7a8b9c0d1e2f',
  // 前缀不在已知凭据名单里，靠 uuid 形状 / 随机段认出来。
  'relay-12345678-abcd-1234-abcd-123456789012',
  'relay-abc123def456-ghi789jkl012',
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

  it('跟模型 ID 同形的凭据也要遮掉', () => {
    for (const secret of MODEL_SHAPED_CREDENTIALS) {
      const out = redactCredentials(`Incorrect API key provided: ${secret}.`);
      assert.ok(!out.includes(secret), `凭据没遮住：${out}`);
      for (const segment of secret.split(/[-_]/)) {
        if (segment.length < 6) continue;
        assert.ok(!out.includes(segment), `凭据只遮了一半，${segment} 还在：${out}`);
      }
      assert.match(out, /\[redacted\]/);
    }
  });

  it('48~64 字符的模型 ID 不会被长随机串那条规则吃掉', () => {
    // 模型名一长（52 字符）就落进「48 字符以上一律遮掉」的射程，遮完那句
    // 「你写的这个模型不存在」就只剩「有个东西不存在」。句尾带不带句号都要认。
    const model = 'deepseek-ai.deepseek-v3-0324-thinking-preview-latest';
    assert.ok(model.length > 48 && model.length <= 64, `样本长度得落在这个区间：${model.length}`);
    assert.equal(redactCredentials(`invalid model: ${model}`), `invalid model: ${model}`);
    assert.equal(redactCredentials(`invalid model: ${model}.`), `invalid model: ${model}.`);
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
