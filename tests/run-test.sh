#!/bin/bash

# 主动消息 API 测试快速启动脚本

set -e  # 遇到错误立即退出

echo "=============================="
echo "主动消息 API v2.0.1 测试启动脚本"
echo "=============================="
echo ""

# 检查 Node.js 版本
echo "检查 Node.js 版本..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ 错误: 需要 Node.js 20 或更高版本"
    echo "   当前版本: $(node -v)"
    exit 1
fi
echo "✅ Node.js 版本: $(node -v)"
echo ""

# 检查配置文件
if [ ! -f .env.test ]; then
    echo "❌ 错误: 找不到 .env.test 配置文件"
    echo ""
    echo "请执行以下步骤:"
    echo "  1. 复制配置模板: cp ../examples/.env.test.example .env.test"
    echo "  2. 编辑配置文件: nano .env.test"
    echo "  3. 填写必需配置项:"
    echo "     - API_BASE_URL"
    echo "     - TENANT_DATABASE_URL"
    echo ""
    exit 1
fi

echo "✅ 找到配置文件: .env.test"
echo ""

# 检查必需的环境变量
echo "加载环境变量..."
export $(cat .env.test | grep -v '^#' | grep -v '^$' | xargs)

MISSING_VARS=""

if [ -z "$API_BASE_URL" ]; then
    MISSING_VARS="$MISSING_VARS API_BASE_URL"
fi

if [ -z "$TENANT_DATABASE_URL" ]; then
    MISSING_VARS="$MISSING_VARS TENANT_DATABASE_URL"
fi

if [ -n "$MISSING_VARS" ]; then
    echo "❌ 错误: 以下必需的环境变量未设置:"
    for var in $MISSING_VARS; do
        echo "   - $var"
    done
    echo ""
    echo "请编辑 .env.test 文件并填写这些变量"
    exit 1
fi

echo "✅ 环境变量已加载"
echo ""

# 显示配置信息
echo "当前配置:"
echo "  API 地址: $API_BASE_URL"
echo "  测试用户: ${TEST_USER_ID:-自动生成}"
echo ""

# 询问是否继续
read -p "是否开始测试? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "测试已取消"
    exit 0
fi

echo ""
echo "=============================="
echo "开始执行测试"
echo "=============================="
echo ""

# 运行测试
node test-active-messaging-api.js

# 捕获退出码
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ 测试全部通过！"
else
    echo "❌ 测试失败，请查看上方日志"
fi

exit $EXIT_CODE
