/**
 * 数据库初始化 API
 * ReiStandard v1.1.0
 *
 * 功能：创建 scheduled_messages 与 system_config 表及索引
 */

const { neon } = require('@neondatabase/serverless');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    return {
      status: 500,
      body: {
        success: false,
        error: {
          code: 'DATABASE_URL_MISSING',
          message: '缺少 DATABASE_URL 环境变量'
        }
      }
    };
  }

  const sql = neon(process.env.DATABASE_URL);

  // 1. 业务数据表
  await sql`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      uuid VARCHAR(36),
      encrypted_payload TEXT NOT NULL,
      message_type VARCHAR(50) NOT NULL CHECK (message_type IN ('fixed', 'prompted', 'auto', 'instant')),
      next_send_at TIMESTAMP WITH TIME ZONE NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
      retry_count INTEGER DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  // 2. 系统配置表（存放主密钥）
  await sql`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  // 3. 索引
  const indexes = [
    {
      name: 'idx_pending_tasks_optimized',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_pending_tasks_optimized
        ON scheduled_messages (status, next_send_at, id, retry_count)
        WHERE status = 'pending'
      `
    },
    {
      name: 'idx_cleanup_completed',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_cleanup_completed
        ON scheduled_messages (status, updated_at)
        WHERE status IN ('sent', 'failed')
      `
    },
    {
      name: 'idx_failed_retry',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_failed_retry
        ON scheduled_messages (status, retry_count, next_send_at)
        WHERE status = 'failed' AND retry_count < 3
      `
    },
    {
      name: 'idx_user_id',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_user_id
        ON scheduled_messages (user_id)
      `
    },
    {
      name: 'idx_uuid',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_uuid
        ON scheduled_messages (uuid)
        WHERE uuid IS NOT NULL
      `
    }
  ];

  const indexResults = [];
  for (const index of indexes) {
    try {
      await sql(index.sql);
      indexResults.push({ name: index.name, status: 'success' });
    } catch (error) {
      indexResults.push({ name: index.name, status: 'failed', error: error.message });
    }
  }

  const messageColumns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'scheduled_messages'
    ORDER BY ordinal_position
  `;

  const systemColumns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'system_config'
    ORDER BY ordinal_position
  `;

  return {
    status: 200,
    body: {
      success: true,
      message: '数据库初始化成功',
      data: {
        tables: ['scheduled_messages', 'system_config'],
        messageTableColumns: messageColumns.map((c) => c.column_name),
        systemConfigColumns: systemColumns.map((c) => c.column_name),
        indexesCreated: indexResults.filter((r) => r.status === 'success').length,
        indexesFailed: indexResults.filter((r) => r.status === 'failed').length,
        indexes: indexResults,
        nextSteps: [
          '1. 调用 /api/v1/init-master-key 一次性生成主密钥并妥善保存',
          '2. 客户端使用 UUID v4 作为 X-User-Id',
          '3. 客户端通过 /api/v1/get-user-key 获取用户密钥并缓存'
        ]
      }
    }
  };
}

module.exports = async function(req, res) {
  try {
    if (req.method !== 'GET') {
      return sendJson(res, 405, {
        success: false,
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: '仅支持 GET 请求'
        }
      });
    }

    const result = await initDatabase();
    return sendJson(res, result.status, result.body);
  } catch (error) {
    console.error('[init-database] 初始化失败:', error);
    return sendJson(res, 500, {
      success: false,
      error: {
        code: 'INITIALIZATION_FAILED',
        message: '数据库初始化失败',
        details: {
          errorType: error.name,
          errorMessage: error.message
        }
      }
    });
  }
};

exports.handler = async function(event) {
  const req = { method: event.httpMethod };
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(data) {
      this.body = data;
    }
  };

  await module.exports(req, res);

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body
  };
};
