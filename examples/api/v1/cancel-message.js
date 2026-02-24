/**
 * DELETE /api/v1/cancel-message?id={uuid}
 * 功能：取消/删除已存在的定时任务（CommonJS，兼容 Vercel 与 Netlify）
 * ReiStandard v2.0.0-pre1
 */

const { isValidUUIDv4 } = require('../../lib/validation');
const { resolveTenantFromRequest } = require('../../lib/tenant-context');

function normalizeHeaders(h) {
  const out = {};
  for (const k in h || {}) out[k.toLowerCase()] = h[k];
  return out;
}

function sendNodeJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function core(url, headers) {
  const tenantResult = await resolveTenantFromRequest(headers, url);
  if (!tenantResult.ok) {
    return tenantResult.response;
  }

  const h = normalizeHeaders(headers);
  const u = new URL(url, 'https://dummy');
  const taskUuid = u.searchParams.get('id');
  if (!taskUuid) {
    return { status: 400, body: { success: false, error: { code: 'TASK_ID_REQUIRED', message: '缺少任务ID' } } };
  }
  const userId = h['x-user-id'];
  if (!userId) {
    return { status: 400, body: { success: false, error: { code: 'USER_ID_REQUIRED', message: '缺少用户标识符' } } };
  }
  if (!isValidUUIDv4(userId)) {
    return { status: 400, body: { success: false, error: { code: 'INVALID_USER_ID_FORMAT', message: 'X-User-Id 必须是 UUID v4 格式' } } };
  }

  // TODO: 删除数据库中的任务（按 uuid + userId）
  console.log('[cancel-message] Task cancelled:', { taskUuid, userId });
  return { status: 200, body: { success: true, data: { uuid: taskUuid, message: '任务已成功取消', deletedAt: new Date().toISOString() } } };
}

module.exports = async function(req, res) {
  try {
    if (req.method !== 'DELETE') return sendNodeJson(res, 405, { error: 'Method not allowed' });
    const result = await core(req.url, req.headers);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[cancel-message] Error:', error);
    return sendNodeJson(res, 500, { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误，请稍后重试' } });
  }
};

exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'DELETE') return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
    const url = event.rawUrl || `https://dummy${event.path}${event.rawQuery ? '?' + event.rawQuery : ''}`;
    const result = await core(url, event.headers || {});
    return { statusCode: result.status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(result.body) };
  } catch (error) {
    console.error('[cancel-message] Error:', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误，请稍后重试' } }) };
  }
};
