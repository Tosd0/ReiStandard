# 主动消息 API 本地测试指南

这是一个用于在本地开发环境测试主动消息 API 的综合测试脚本，涵盖了所有端点和功能。

> **📚 相关文档**：
> - **API 技术规范**：[standards/active-messaging-api.md](../standards/active-messaging-api.md)
> - **部署指南**：[examples/README.md](../examples/README.md)
> - **生产环境测试**：[VERCEL_TEST_DEPLOY.md](./VERCEL_TEST_DEPLOY.md)

## 功能特性

✅ **完整的端点测试**
- GET `/api/v1/get-master-key` - 获取加密主密钥
- POST `/api/v1/schedule-message` - 创建定时任务（fixed, prompted, auto, instant）
- GET `/api/v1/messages` - 查询任务列表
- PUT `/api/v1/update-message/:id` - 更新任务
- DELETE `/api/v1/cancel-message/:id` - 取消任务
- POST `/api/v1/send-notifications` - 触发通知发送（Cron）

✅ **加密测试**
- 自动派生用户专属密钥
- AES-256-GCM 加密/解密
- 完整的端到端加密流程

✅ **参数验证测试**
- 缺少加密头部
- 缺少用户 ID
- 无效的消息类型
- 无效的时间格式

✅ **自动清理**
- 测试完成后自动删除所有创建的测试数据

## 使用方法

### 1. 准备环境

需要 Node.js 20+（推荐使用当前 LTS）

```bash
node --version  # 确保 >= 20.0.0
```

### 2. 配置测试参数

**⚠️ 重要**: 必须正确配置以下三个环境变量，否则测试将无法运行：
- `API_BASE_URL`: 主动消息 API 服务器地址（不是 AI API 地址）
- `CRON_SECRET`: Cron Job 认证密钥
- `ENCRYPTION_KEY`: 64位十六进制加密主密钥

**API_BASE_URL 使用场景说明**：
- ✅ **测试脚本需要**：用于指定要测试的主动消息 API 地址
- ❌ **API 服务本身不需要**：API 服务运行时不需要此变量
- 📌 **说明**：这个变量仅用于测试工具，不是 API 服务的必需配置

**测试说明**: 测试时不会真正调用 AI API，只测试主动消息 API 的端点连通性。

#### 方法一：使用快速启动脚本（推荐）

```bash
# 1. 复制配置模板（从 examples 目录）
cp ../examples/.env.test.example .env.test

# 2. 编辑配置文件（填写必需的三个变量）
nano .env.test

# 3. 运行快速启动脚本（会自动检查配置）
./run-test.sh
```

快速启动脚本会：
- 检查 Node.js 版本
- 验证配置文件存在
- 检查必需的环境变量
- 询问是否开始测试
- 自动运行测试并显示结果

#### 方法二：使用环境变量文件（手动）

```bash
# 1. 复制配置模板（从 examples 目录）
cp ../examples/.env.test.example .env.test

# 2. 编辑配置文件
nano .env.test

# 3. 生成加密密钥（如果还没有）
openssl rand -hex 32

# 4. 加载环境变量并运行测试
export $(cat .env.test | xargs) && node test-active-messaging-api.js
```

**Windows PowerShell**:
```powershell
# 加载环境变量
Get-Content .env.test | ForEach-Object {
  if ($_ -match '^([^#][^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}

# 运行测试
node test-active-messaging-api.js
```

#### 方法三：使用命令行参数（临时测试）

```bash
API_BASE_URL=https://your-domain.com \
CRON_SECRET=your_secret \
ENCRYPTION_KEY=$(openssl rand -hex 32) \
node test-active-messaging-api.js
```

**注意**:
- `ENCRYPTION_KEY` 必须与服务器端配置的密钥一致
- 如果密钥不一致，测试中的加密/解密会失败

### 3. 运行测试

```bash
# 直接运行
node test-active-messaging-api.js

# 或赋予执行权限后运行
chmod +x test-active-messaging-api.js
./test-active-messaging-api.js
```

### 4. 查看测试结果

测试脚本会输出彩色的测试报告：

```
============================================================
主动消息 API 综合测试
============================================================
ℹ️  API 地址: https://your-domain.com
ℹ️  测试用户 ID: test_user_1697123456
ℹ️  开始时间: 2025-10-13 20:00:00

============================================================
测试 1: GET /api/v1/get-master-key
============================================================
ℹ️  发送请求...
✅ 成功获取主密钥 (version: 1)
ℹ️  用户专属密钥已派生: 1234567890abcdef...

============================================================
测试 2: POST /api/v1/schedule-message (fixed 类型)
============================================================
ℹ️  加密请求体...
ℹ️  发送请求...
✅ 任务创建成功！任务ID: 12345
ℹ️  UUID: 550e8400-e29b-41d4-a716-446655440000
ℹ️  下次发送时间: 2025-10-13T20:01:00Z

...

============================================================
测试报告
============================================================
总计: 8 个测试
通过: 8 个
失败: 0 个
成功率: 100.0%

结束时间: 2025-10-13 20:05:00
```

## 测试流程说明

测试按以下顺序执行：

1. **获取主密钥** - 从服务器获取加密主密钥并派生用户专属密钥
2. **创建固定消息** - 测试 `fixed` 类型消息（不需要 AI）
3. **创建 prompted 消息** - 测试用户提示词消息（需要 AI）
4. **创建 auto 消息** - 测试完全自动消息（需要 AI）
5. **查询任务列表** - 验证创建的任务是否正确保存
6. **更新任务** - 测试更新任务的发送时间和内容
7. **触发通知发送** - 模拟 Cron Job 触发通知
8. **参数验证测试** - 测试各种错误场景
9. **清理测试数据** - 删除所有创建的测试任务

## 常见问题

### Q: 测试失败怎么办？

A: 检查以下几点：
1. API 服务器是否正常运行
2. 配置参数是否正确（特别是 `CRON_SECRET` 和 `ENCRYPTION_KEY`）
3. 数据库连接是否正常
4. 查看服务器日志了解详细错误

### Q: 如何跳过某些测试？

A: 修改脚本中的 `tests` 数组，注释掉不需要的测试：

```javascript
const tests = [
  { name: '获取主密钥', fn: testGetMasterKey, critical: true },
  // { name: '创建 prompted 消息', fn: testCreatePromptedMessage, critical: false },  // 跳过此测试
  { name: '创建 auto 消息', fn: testCreateAutoMessage, critical: false },
  // ...
];
```

### Q: 如何测试线上环境？

A: 修改 `API_BASE_URL` 为实际 API。

**注意**: 测试会在线上创建真实数据，但会在测试结束后自动清理。

### Q: 测试数据未清理怎么办？

A: 如果测试中断导致数据未清理，可以手动查询并删除：

```bash
# 使用测试脚本的用户 ID 查询任务
curl -X GET "https://your-domain.com/api/v1/messages?status=pending" \
  -H "X-User-Id: test_user_1697123456"

# 手动删除任务
curl -X DELETE "https://your-domain.com/api/v1/cancel-message/{uuid}" \
  -H "X-User-Id: test_user_1697123456"
```

或者直接在数据库中删除：

```sql
DELETE FROM scheduled_messages WHERE user_id LIKE 'test_user_%';
```

## Serverless 部署注意事项

如果 API 部署在 Serverless 平台（如 Vercel），需要注意：

1. **配置 Protection Bypass** - 如果启用了 Vercel Protection，需要设置 `VERCEL_PROTECTION_BYPASS`

## 自定义测试

你可以轻松添加自定义测试用例：

```javascript
async function testCustomScenario() {
  logSection('自定义测试: 测试某个特定场景');

  // 你的测试逻辑
  const result = await someApiCall();

  if (result.success) {
    logSuccess('测试通过！');
    return true;
  } else {
    logError('测试失败！');
    return false;
  }
}

// 添加到测试列表
const tests = [
  // ...
  { name: '自定义场景', fn: testCustomScenario, critical: false },
];
```

## 许可

本测试脚本遵循与主标准相同的许可证（CC BY-NC-SA 4.0）。
