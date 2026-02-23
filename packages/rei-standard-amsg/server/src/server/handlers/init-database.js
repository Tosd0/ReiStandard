/**
 * Handler: init-database
 * ReiStandard SDK v1.2.2
 *
 * @param {Object} ctx - Server context injected by createReiServer.
 * @returns {{ GET: function, POST: function }}
 */

import { REQUIRED_COLUMNS } from '../adapters/schema.js';

export function createInitDatabaseHandler(ctx) {
  async function GET() {
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
          tables: ['scheduled_messages', 'system_config'],
          columnsCreated: result.columnsCreated,
          indexesCreated: result.indexesCreated,
          indexesFailed: result.indexesFailed,
          details: { columns: result.columns, indexes: result.indexes },
          nextSteps: [
            '1. 调用 /api/v1/init-master-key 一次性生成主密钥并离线保存',
            '2. 客户端使用 UUID v4 作为 X-User-Id',
            '3. 客户端调用 /api/v1/get-user-key 获取 userKey 并缓存'
          ]
        }
      }
    };
  }

  return { GET };
}
