/**
 * 数据库初始化 API
 * ReiStandard v1.1.0
 *
 * 功能：一键创建 scheduled_messages 表及所有索引
 * 使用：访问一次后即可删除此文件
 *
 * ⚠️ 安全警告：
 * 1. 仅在首次部署时使用
 * 2. 初始化完成后立即删除此文件
 * 3. 生产环境建议添加额外的认证保护
 *
 * 📌 Neon Database 用户提示：
 * 如果使用 Neon Serverless Database，需要将
 * await sql(index.sql)
 * 改为
 * await sql.query(index.sql)
 */

const { neon } = require('@neondatabase/serverless');

/**
 * GET /api/v1/init-database
 * 创建数据库表和索引
 */
module.exports = async function(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      success: false,
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: '仅支持 GET 和 POST 请求'
      }
    }));
  }

  if (req.method === 'GET') {
    return handleGet(req, res);
  } else {
    return handlePost(req, res);
  }
};

// Netlify 格式导出
exports.handler = async function(event) {
  // 构造类 Node.js req/res 对象
  const req = {
    method: event.httpMethod,
    headers: event.headers || {}
  };

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

async function handleGet(req, res) {
  try {
    // 可选：添加简单的认证保护（推荐）
    const authHeader = req.headers.authorization || '';
    const expectedAuth = `Bearer ${process.env.INIT_SECRET || 'CHANGE_ME_IN_ENV'}`;

    if (authHeader.trim() !== expectedAuth) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: '需要认证。请在请求头中添加: Authorization: Bearer {INIT_SECRET}'
        }
      }));
    }

    // 连接数据库
    const sql = neon(process.env.DATABASE_URL);

    console.log('[init-database] 开始初始化数据库...');

    // 1. 创建主表
    await sql`
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        -- 主键
        id SERIAL PRIMARY KEY,

        -- 用户标识（用于加密密钥派生和数据隔离）
        user_id VARCHAR(255) NOT NULL,

        -- 跨设备查询标识符
        uuid VARCHAR(36),

        -- 全字段加密存储
        -- 包含所有隐私数据：contactName, avatarUrl, messageSubtype, userMessage,
        -- recurrenceType, apiUrl, apiKey, primaryModel, completePrompt, 
        -- pushSubscription, metadata

        encrypted_payload TEXT NOT NULL,

        -- 📌 索引字段（明文，用于查询优化）
        message_type VARCHAR(50) NOT NULL CHECK (message_type IN ('fixed', 'prompted', 'auto', 'instant')),
        next_send_at TIMESTAMP WITH TIME ZONE NOT NULL,

        -- 状态管理
        status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        retry_count INTEGER DEFAULT 0,

        -- 时间戳
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;

    console.log('[init-database] ✅ 表 scheduled_messages 创建成功');

    // 2. 创建索引
    const indexes = [
      {
        name: 'idx_pending_tasks_optimized',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_pending_tasks_optimized
          ON scheduled_messages (status, next_send_at, id, retry_count)
          WHERE status = 'pending'
        `,
        description: '主查询索引（Cron Job 查找待处理任务）'
      },
      {
        name: 'idx_cleanup_completed',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_cleanup_completed
          ON scheduled_messages (status, updated_at)
          WHERE status IN ('sent', 'failed')
        `,
        description: '清理查询索引（定期清理已完成/失败任务）'
      },
      {
        name: 'idx_failed_retry',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_failed_retry
          ON scheduled_messages (status, retry_count, next_send_at)
          WHERE status = 'failed' AND retry_count < 3
        `,
        description: '失败重试索引（查找需要重试的失败任务）'
      },
      {
        name: 'idx_user_id',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_user_id
          ON scheduled_messages (user_id)
        `,
        description: '用户任务查询索引（查询特定用户的所有任务）'
      },
      {
        name: 'idx_uuid',
        sql: `
          CREATE INDEX IF NOT EXISTS idx_uuid
          ON scheduled_messages (uuid)
          WHERE uuid IS NOT NULL
        `,
        description: 'UUID查询索引（跨设备查询）'
      }
    ];

    const indexResults = [];

    for (const index of indexes) {
      try {
        await sql(index.sql);
        console.log(`[init-database] ✅ 索引 ${index.name} 创建成功`);
        indexResults.push({
          name: index.name,
          status: 'success',
          description: index.description
        });
      } catch (error) {
        console.error(`[init-database] ❌ 索引 ${index.name} 创建失败:`, error.message);
        indexResults.push({
          name: index.name,
          status: 'failed',
          description: index.description,
          error: error.message
        });
      }
    }

    // 3. 验证表是否存在
    const tableCheck = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'scheduled_messages'
    `;

    if (tableCheck.length === 0) {
      throw new Error('表创建验证失败');
    }

    // 4. 获取表的列信息
    const columns = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'scheduled_messages'
      ORDER BY ordinal_position
    `;
    
    // 验证关键列是否存在
    const columnNames = columns.map(c => c.column_name);
    const requiredColumns = ['id', 'user_id', 'uuid', 'encrypted_payload', 'message_type', 'next_send_at', 'status', 'retry_count'];
    const missingColumns = requiredColumns.filter(col => !columnNames.includes(col));
    
    if (missingColumns.length > 0) {
      console.warn('[init-database] ⚠️  缺少关键列:', missingColumns);
    }

    console.log('[init-database] ✅ 数据库初始化完成');

    // 返回成功响应
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      success: true,
      message: '数据库初始化成功！建议立即删除此 API 文件。',
      data: {
        table: 'scheduled_messages',
        columnsCreated: columns.length,
        indexesCreated: indexResults.filter(r => r.status === 'success').length,
        indexesFailed: indexResults.filter(r => r.status === 'failed').length,
        details: {
          columns: columns.map(c => ({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable === 'YES'
          })),
          indexes: indexResults
        },
        nextSteps: [
          '1. 验证表和索引已正确创建',
          '2. 立即删除 /app/api/v1/init-database/route.js 文件',
          '3. 从 .env 中删除 INIT_SECRET（可选）',
          '4. 开始使用 ReiStandard API'
        ]
      }
    }));

  } catch (error) {
    console.error('[init-database] 初始化失败:', error);

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      success: false,
      error: {
        code: 'INITIALIZATION_FAILED',
        message: '数据库初始化失败',
        details: {
          errorType: error.name,
          errorMessage: error.message,
          hint: '请检查 DATABASE_URL 是否正确，以及数据库连接是否可用'
        }
      }
    }));
  }
}

/**
 * POST /api/v1/init-database
 * 重置数据库（删除表后重新创建）
 *
 * ⚠️ 危险操作：会删除所有数据！
 */
async function handlePost(req, res) {
  try {
    // 强制要求认证
    const authHeader = req.headers.authorization || '';
    const expectedAuth = `Bearer ${process.env.INIT_SECRET || 'CHANGE_ME_IN_ENV'}`;

    if (authHeader.trim() !== expectedAuth) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: '需要认证'
        }
      }));
    }

    // 额外确认参数
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }
    const parsedBody = JSON.parse(body);

    if (parsedBody.confirm !== 'DELETE_ALL_DATA') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        success: false,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: '需要在请求体中提供确认参数: { "confirm": "DELETE_ALL_DATA" }'
        }
      }));
    }

    const sql = neon(process.env.DATABASE_URL);

    console.log('[init-database] ⚠️  开始重置数据库（删除所有数据）...');

    // 删除表（CASCADE 会自动删除所有索引）
    await sql`DROP TABLE IF EXISTS scheduled_messages CASCADE`;
    console.log('[init-database] ✅ 旧表已删除');

    // 重新创建表和索引（调用 GET 逻辑）
    return await handleGet(req, res);

  } catch (error) {
    console.error('[init-database] 重置失败:', error);

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      success: false,
      error: {
        code: 'RESET_FAILED',
        message: '数据库重置失败',
        details: {
          errorType: error.name,
          errorMessage: error.message
        }
      }
    }));
  }
}
