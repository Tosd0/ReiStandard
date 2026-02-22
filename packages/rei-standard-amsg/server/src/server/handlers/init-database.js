/**
 * Handler: init-database
 * ReiStandard SDK v1.1.0
 *
 * @param {Object} ctx - Server context injected by createReiServer.
 * @returns {{ GET: function, POST: function }}
 */

import { REQUIRED_COLUMNS } from '../adapters/schema.js';
import { parseJsonBody } from '../lib/request.js';

export function createInitDatabaseHandler(ctx) {
  async function GET(headers) {
    if (!ctx.initSecret) {
      return {
        status: 500,
        body: { success: false, error: { code: 'INIT_SECRET_MISSING', message: 'initSecret 未配置，请在 createReiServer 配置中提供 initSecret' } }
      };
    }

    const authHeader = (headers['authorization'] || '').trim();
    const expectedAuth = `Bearer ${ctx.initSecret}`;

    if (authHeader !== expectedAuth) {
      return {
        status: 401,
        body: { success: false, error: { code: 'UNAUTHORIZED', message: '需要认证。请在请求头中添加: Authorization: Bearer {INIT_SECRET}' } }
      };
    }

    const result = await ctx.db.initSchema();

    const columnNames = result.columns.map(c => c.name);
    const missingColumns = REQUIRED_COLUMNS.filter(col => !columnNames.includes(col));
    if (missingColumns.length > 0) {
      console.warn('[init-database] ⚠️  Missing columns:', missingColumns);
    }

    return {
      status: 200,
      body: {
        success: true,
        message: '数据库初始化成功！建议立即删除此 API 文件。',
        data: {
          table: 'scheduled_messages',
          columnsCreated: result.columnsCreated,
          indexesCreated: result.indexesCreated,
          indexesFailed: result.indexesFailed,
          details: { columns: result.columns, indexes: result.indexes },
          nextSteps: [
            '1. 验证表和索引已正确创建',
            '2. 立即删除 /app/api/v1/init-database/route.js 文件',
            '3. 从 .env 中删除 INIT_SECRET（可选）',
            '4. 开始使用 ReiStandard API'
          ]
        }
      }
    };
  }

  async function POST(headers, body) {
    if (!ctx.initSecret) {
      return {
        status: 500,
        body: { success: false, error: { code: 'INIT_SECRET_MISSING', message: 'initSecret 未配置，请在 createReiServer 配置中提供 initSecret' } }
      };
    }

    const authHeader = (headers['authorization'] || '').trim();
    const expectedAuth = `Bearer ${ctx.initSecret}`;

    if (authHeader !== expectedAuth) {
      return {
        status: 401,
        body: { success: false, error: { code: 'UNAUTHORIZED', message: '需要认证' } }
      };
    }

    const parsedBody = parseJsonBody(body);
    if (!parsedBody.ok) {
      return {
        status: 400,
        body: { success: false, error: parsedBody.error }
      };
    }

    if (parsedBody.data.confirm !== 'DELETE_ALL_DATA') {
      return {
        status: 400,
        body: { success: false, error: { code: 'CONFIRMATION_REQUIRED', message: '需要在请求体中提供确认参数: { "confirm": "DELETE_ALL_DATA" }' } }
      };
    }

    await ctx.db.dropSchema();
    return GET(headers);
  }

  return { GET, POST };
}
