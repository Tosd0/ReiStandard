# Service Worker 标准规范 (Service Worker Specification)

> **⚠️ AI 编程助手使用须知**
>
> 本文档是 **Service Worker 实现标准规范**，定义了前端推送通知和离线功能的参考实现。
>
> **规范**：
> - ✅ 本标准定义的 **事件处理方式**、**缓存策略**、**通知数据结构**、**生命周期管理** 等为 **推荐实现方案**
> - ✅ Service Worker 实现可以根据具体需求灵活调整，**不强制要求完全遵循**本标准
> - ✅ 但 **通知数据结构应与 [主动消息API标准](./active-messaging-api.md) 保持一致**，以确保前后端协同工作
> - ✅ 如需扩展功能，可以通过 **可选配置** 或 **自定义事件** 实现
> - ✅ 如果实现的功能具有普遍应用场景，应提醒用户向仓库提交 **FEATURE REQUEST**，以便在后续版本的标准中正式实现
> - 💡 可以根据实际场景优化事件处理流程（如 `install`、`activate`、`push` 等）
> - 💡 可以根据项目需求调整缓存策略
>
> **发现问题时的处理**：
> - 如果发现标准中存在错误或不合理之处，应建议用户联系仓库负责人讨论
> - **不应该直接修改标准文档**，标准的修改需要经过仓库负责人的审核和批准

## 版本信息
- **版本号**: v1.0.0
- **最后更新**: 2025-10-17
- **状态**: Stable
- **关联标准**: [主动消息API端点标准](./active-messaging-api.md)

## 概述

本标准定义了支持主动消息推送功能的 Service Worker 实现规范，包括缓存策略、推送通知处理、生命周期管理等。遵循本标准可确保应用的离线可用性、推送通知的可靠性和版本更新的平滑性。

---

## 1. 核心功能要求

### 1.1 必需功能

| 功能 | 必需性 | 说明 |
|-----|--------|------|
| 静态资源缓存 | 可选 | 缓存应用核心资源以支持离线访问 |
| 推送通知接收 | 必需 | 接收和处理来自服务器的推送通知 |
| 通知显示 | 必需 | 显示推送通知给用户 |
| 通知点击处理 | 可选 | 处理用户点击通知的行为 |
| 版本管理 | 必需 | 管理 Service Worker 版本和更新 |

### 1.2 推荐功能

| 功能 | 说明 |
|-----|------|
| 动态缓存 | 缓存运行时请求的资源 |
| 离线回退 | 网络不可用时提供基本功能 |
| 后台同步 | 支持后台数据同步 |
| 通知操作按钮 | 为通知添加交互按钮 |

---

## 2. 基础配置

### 2.1 版本控制

```javascript
// 缓存版本命名规范
const CACHE_NAME = 'app-name-v{major}.{minor}.{patch}';
const CACHE_VERSION = Date.now(); // 用于日志和调试

// 示例
const CACHE_NAME = 'whale-llt-v1.0.0';
const CACHE_VERSION = Date.now();
```

**版本命名规则**:
- 格式: `{app-name}-v{major}.{minor}.{patch}`
- `major`: 重大功能变更或不兼容更新
- `minor`: 新增功能或小幅改动
- `patch`: Bug 修复或微小调整

### 2.2 缓存策略配置

```javascript
// 缓存配置
const CACHE_CONFIG = {
  // 静态资源缓存名称
  STATIC_CACHE: 'app-static-v1',

  // 动态资源缓存名称
  DYNAMIC_CACHE: 'app-dynamic-v1',

  // 图片缓存名称
  IMAGE_CACHE: 'app-images-v1',

  // 动态缓存最大条目数
  MAX_DYNAMIC_ITEMS: 50,

  // 图片缓存最大条目数
  MAX_IMAGE_ITEMS: 100,

  // 缓存超时时间（毫秒）
  CACHE_TIMEOUT: 5000
};
```

### 2.3 静态资源清单

```javascript
// 必需缓存的静态资源列表
const STATIC_ASSETS = [
  // 核心页面
  '/',
  '/index.html',
  '/manifest.json',

  // 样式文件
  '/css/style.css',

  // 脚本文件
  '/script.js',
  '/js/api.js',

  // 工具库
  '/lib/db.js',

  // 第三方CDN资源（如需要）
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js'
];
```

**资源清单要求**:
- 包含应用核心功能所需的所有资源
- 路径必须使用绝对路径或相对于根目录的路径
- CDN 资源需要支持 CORS

---

## 3. 生命周期事件处理

### 3.1 Install 事件

**功能**: 缓存静态资源，准备 Service Worker 运行环境

```javascript
self.addEventListener('install', event => {
  console.log('[SW] 安装中...', CACHE_VERSION);

  event.waitUntil(
    caches.open(CACHE_CONFIG.STATIC_CACHE)
      .then(cache => {
        console.log('[SW] 开始缓存静态资源');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[SW] 静态资源缓存完成');
        // 跳过等待，立即激活新版本
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('[SW] 安装失败:', error);
        throw error;
      })
  );
});
```

**重要规则**:
1. **必须**调用 `event.waitUntil()` 确保缓存完成
2. **必须**处理缓存失败的情况
3. **推荐**在缓存完成后调用 `self.skipWaiting()` 立即激活
4. **必须**记录安装过程的日志

### 3.2 Activate 事件

**功能**: 清理旧缓存，接管页面控制权

```javascript
self.addEventListener('activate', event => {
  console.log('[SW] 激活中...', CACHE_VERSION);

  event.waitUntil(
    Promise.all([
      // 清理旧缓存
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            // 保留当前版本的缓存
            const currentCaches = Object.values(CACHE_CONFIG);
            if (!currentCaches.includes(cacheName)) {
              console.log('[SW] 删除旧缓存:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      }),

      // 通知所有客户端更新
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'SW_ACTIVATED',
            version: CACHE_VERSION,
            timestamp: Date.now()
          });
        });
      })
    ])
    .then(() => {
      console.log('[SW] 激活完成，接管所有页面');
      // 立即接管所有页面
      return self.clients.claim();
    })
    .catch(error => {
      console.error('[SW] 激活失败:', error);
      throw error;
    })
  );
});
```

**重要规则**:
1. **必须**清理不再使用的旧缓存
2. **必须**调用 `self.clients.claim()` 接管页面
3. **推荐**通知客户端 Service Worker 已更新
4. **必须**记录激活过程的日志

### 3.3 Fetch 事件

**功能**: 拦截网络请求，实现缓存策略

```javascript
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 跳过非 HTTP/HTTPS 请求
  if (!url.protocol.startsWith('http')) {
    return;
  }

  event.respondWith(
    caches.match(request)
      .then(cachedResponse => {
        // 缓存命中，返回缓存
        if (cachedResponse) {
          return cachedResponse;
        }

        // 缓存未命中，发起网络请求
        return fetch(request)
          .then(networkResponse => {
            // 仅缓存成功的 GET 请求
            if (request.method === 'GET' && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();

              // 根据资源类型选择缓存
              const cacheKey = getCacheKey(url);
              if (cacheKey) {
                caches.open(cacheKey).then(cache => {
                  cache.put(request, responseClone);
                });
              }
            }

            return networkResponse;
          })
          .catch(error => {
            console.warn('[SW] Fetch 失败:', request.url, error);

            // 为关键资源提供离线回退
            if (request.destination === 'document') {
              return caches.match('/offline.html');
            }

            throw error;
          });
      })
  );
});

// 辅助函数：根据 URL 判断缓存类型
function getCacheKey(url) {
  if (url.pathname.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)) {
    return CACHE_CONFIG.IMAGE_CACHE;
  }
  if (url.pathname.match(/\.(js|css|html)$/i)) {
    return CACHE_CONFIG.DYNAMIC_CACHE;
  }
  return null;
}
```

**缓存策略**:
- **Cache First**: 优先使用缓存（适用于静态资源）
- **Network First**: 优先使用网络（适用于 API 请求）
- **Stale While Revalidate**: 返回缓存的同时更新缓存（适用于频繁更新的资源）

---

## 4. 推送通知处理（核心功能）

### 4.1 Push 事件

**功能**: 接收推送通知并显示给用户

```javascript
self.addEventListener('push', event => {
  console.log('[SW] 收到推送通知');

  // 解析推送数据
  let notificationData = {};
  try {
    notificationData = event.data ? event.data.json() : {};
  } catch (error) {
    console.error('[SW] 推送数据解析失败:', error);
    notificationData = {
      title: '新消息',
      message: event.data ? event.data.text() : '您有一条新消息'
    };
  }

  // 构建通知选项
  const options = buildNotificationOptions(notificationData);

  // 显示通知
  event.waitUntil(
    self.registration.showNotification(options.title, options)
      .then(() => {
        console.log('[SW] 通知已显示:', options.title);
      })
      .catch(error => {
        console.error('[SW] 通知显示失败:', error);
      })
  );
});

// 辅助函数：构建通知选项
function buildNotificationOptions(data) {
  return {
    title: data.title || `来自 ${data.contactName}`,
    body: data.message || '您有一条新消息',
    icon: data.avatarUrl || '/icons/default-avatar.png',
    badge: '/icons/badge.png',
    tag: data.messageId || `msg-${Date.now()}`,
    data: {
      url: '/',
      taskId: data.taskId,
      messageId: data.messageId,
      contactName: data.contactName,
      messageType: data.messageType,
      timestamp: data.timestamp || new Date().toISOString(),
      ...data.metadata
    },
    actions: [
      {
        action: 'open',
        title: '查看'
      },
      {
        action: 'dismiss',
        title: '关闭'
      }
    ],
    requireInteraction: false, // 自动关闭
    silent: false,
    vibrate: [200, 100, 200], // 震动模式
    renotify: true // 相同 tag 的通知会替换旧通知
  };
}
```

**通知数据结构**（与 [主动消息API标准](./active-messaging-api.md#72-字段说明) 一致）:

```json
{
  "title": "来自 Rei",
  "message": "早上好！今天的天气很不错呢。",
  "contactName": "Rei",
  "messageId": "msg_1705308000_abc123",
  "messageIndex": 1,
  "totalMessages": 3,
  "messageType": "auto",
  "messageSubtype": "chat",
  "taskId": 12345,
  "timestamp": "2025-01-15T09:00:00Z",
  "source": "scheduled",
  "avatarUrl": "https://example.com/avatar.png",
  "metadata": {}
}
```

### 4.2 NotificationClick 事件

**功能**: 处理用户点击通知的行为

```javascript
self.addEventListener('notificationclick', event => {
  const { notification, action } = event;
  const data = notification.data || {};

  console.log('[SW] 通知被点击:', {
    action,
    messageId: data.messageId,
    contactName: data.contactName
  });

  // 关闭通知
  notification.close();

  event.waitUntil(
    (async () => {
      // 处理操作按钮
      if (action === 'dismiss') {
        console.log('[SW] 用户关闭通知');
        return;
      }

      // 默认操作：打开应用
      const urlToOpen = new URL(data.url || '/', self.location.origin);

      // 添加查询参数以传递上下文
      if (data.messageId) {
        urlToOpen.searchParams.set('messageId', data.messageId);
      }
      if (data.contactName) {
        urlToOpen.searchParams.set('contact', data.contactName);
      }

      // 查找已打开的页面
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });

      // 如果有已打开的页面，聚焦并导航
      for (const client of windowClients) {
        if (client.url === urlToOpen.href && 'focus' in client) {
          await client.focus();
          // 发送消息通知页面
          client.postMessage({
            type: 'NOTIFICATION_CLICKED',
            data: data
          });
          return;
        }
      }

      // 没有已打开的页面，打开新页面
      if (self.clients.openWindow) {
        const newWindow = await self.clients.openWindow(urlToOpen.href);
        // 等待页面加载后发送消息
        if (newWindow) {
          setTimeout(() => {
            newWindow.postMessage({
              type: 'NOTIFICATION_CLICKED',
              data: data
            });
          }, 1000);
        }
      }
    })()
  );
});
```

**重要规则**:
1. **必须**调用 `notification.close()` 关闭通知
2. **推荐**复用已打开的页面而非总是打开新窗口
3. **必须**将通知数据传递给页面以便后续处理
4. **推荐**添加操作按钮提供快捷操作

### 4.3 NotificationClose 事件

**功能**: 处理用户关闭通知的行为（可选）

```javascript
self.addEventListener('notificationclose', event => {
  const { notification } = event;
  const data = notification.data || {};

  console.log('[SW] 通知被关闭（未点击）:', {
    messageId: data.messageId,
    contactName: data.contactName
  });

  // 可选：记录通知关闭事件用于分析
  event.waitUntil(
    fetch('/api/analytics/notification-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId: data.messageId,
        timestamp: Date.now()
      })
    }).catch(error => {
      console.warn('[SW] 记录通知关闭失败:', error);
    })
  );
});
```

---

## 5. 消息通信

### 5.1 接收来自页面的消息

```javascript
self.addEventListener('message', event => {
  const { type, data } = event.data || {};

  console.log('[SW] 收到页面消息:', type);

  switch (type) {
    case 'SKIP_WAITING':
      // 强制激活新版本
      self.skipWaiting();
      break;

    case 'CLEAR_CACHE':
      // 清理缓存
      event.waitUntil(
        caches.keys().then(cacheNames => {
          return Promise.all(
            cacheNames.map(name => caches.delete(name))
          );
        }).then(() => {
          event.ports[0]?.postMessage({ success: true });
        })
      );
      break;

    case 'GET_VERSION':
      // 返回版本信息
      event.ports[0]?.postMessage({
        version: CACHE_VERSION,
        cacheName: CACHE_NAME
      });
      break;

    default:
      console.warn('[SW] 未知消息类型:', type);
  }
});
```

### 5.2 向页面发送消息

```javascript
// 向所有客户端广播消息
async function broadcastMessage(message) {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });

  clients.forEach(client => {
    client.postMessage(message);
  });
}

// 使用示例
broadcastMessage({
  type: 'CACHE_UPDATED',
  timestamp: Date.now()
});
```

---

## 6. 高级功能

### 6.1 后台同步（Background Sync）

```javascript
self.addEventListener('sync', event => {
  console.log('[SW] 后台同步:', event.tag);

  if (event.tag === 'sync-messages') {
    event.waitUntil(
      syncMessages()
        .then(() => {
          console.log('[SW] 消息同步完成');
        })
        .catch(error => {
          console.error('[SW] 消息同步失败:', error);
          throw error; // 重新抛出以触发重试
        })
    );
  }
});

async function syncMessages() {
  // 从 IndexedDB 获取待同步的消息
  // 发送到服务器
  // 更新本地状态
}
```

### 6.2 定期后台同步（Periodic Background Sync）

```javascript
self.addEventListener('periodicsync', event => {
  console.log('[SW] 定期后台同步:', event.tag);

  if (event.tag === 'update-content') {
    event.waitUntil(
      updateContent()
        .then(() => {
          console.log('[SW] 内容更新完成');
        })
        .catch(error => {
          console.error('[SW] 内容更新失败:', error);
        })
    );
  }
});

async function updateContent() {
  // 更新缓存的内容
}
```

### 6.3 缓存清理策略

```javascript
// 限制缓存条目数量
async function limitCacheSize(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();

  if (keys.length > maxItems) {
    // 删除最旧的条目（FIFO）
    const deleteCount = keys.length - maxItems;
    await Promise.all(
      keys.slice(0, deleteCount).map(key => cache.delete(key))
    );
    console.log(`[SW] 清理缓存 ${cacheName}: 删除 ${deleteCount} 个条目`);
  }
}

// 在 fetch 事件中使用
self.addEventListener('fetch', event => {
  // ... fetch 处理逻辑

  // 缓存后清理
  event.waitUntil(
    limitCacheSize(CACHE_CONFIG.DYNAMIC_CACHE, CACHE_CONFIG.MAX_DYNAMIC_ITEMS)
  );
});
```

---

## 7. 错误处理

### 7.1 全局错误处理

```javascript
self.addEventListener('error', event => {
  console.error('[SW] 全局错误:', event.error);

  // 可选：上报错误到服务器
  fetch('/api/error-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: event.error?.message,
      stack: event.error?.stack,
      timestamp: Date.now()
    })
  }).catch(() => {
    // 忽略上报失败
  });
});

self.addEventListener('unhandledrejection', event => {
  console.error('[SW] 未处理的 Promise 拒绝:', event.reason);
});
```

### 7.2 缓存失败处理

```javascript
async function safeCacheAdd(cache, request) {
  try {
    await cache.add(request);
    return true;
  } catch (error) {
    console.warn('[SW] 缓存失败:', request, error);
    return false;
  }
}

// 使用示例
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_CONFIG.STATIC_CACHE)
      .then(async cache => {
        const results = await Promise.all(
          STATIC_ASSETS.map(url => safeCacheAdd(cache, url))
        );

        const failedCount = results.filter(r => !r).length;
        if (failedCount > 0) {
          console.warn(`[SW] ${failedCount} 个资源缓存失败`);
        }
      })
  );
});
```

---

## 8. 性能优化

### 8.1 预缓存策略

```javascript
// 关键资源立即缓存，次要资源延迟缓存
const CRITICAL_ASSETS = [
  '/',
  '/index.html',
  '/css/critical.css',
  '/js/app.js'
];

const SECONDARY_ASSETS = [
  '/css/theme.css',
  '/js/analytics.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_CONFIG.STATIC_CACHE)
      .then(cache => {
        // 立即缓存关键资源
        return cache.addAll(CRITICAL_ASSETS);
      })
      .then(() => {
        // 延迟缓存次要资源
        return caches.open(CACHE_CONFIG.STATIC_CACHE)
          .then(cache => cache.addAll(SECONDARY_ASSETS));
      })
      .catch(error => {
        console.warn('[SW] 次要资源缓存失败:', error);
        // 不阻止安装
      })
  );
});
```

### 8.2 缓存更新策略

```javascript
// Stale While Revalidate 策略
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_CONFIG.DYNAMIC_CACHE);
  const cachedResponse = await cache.match(request);

  const fetchPromise = fetch(request).then(networkResponse => {
    // 后台更新缓存
    cache.put(request, networkResponse.clone());
    return networkResponse;
  });

  // 返回缓存（如果有），否则等待网络响应
  return cachedResponse || fetchPromise;
}
```

---

## 9. 安全考虑

### 9.1 HTTPS 要求

- **必须**在 HTTPS 环境下运行（localhost 除外）
- **必须**验证所有外部资源的来源

### 9.2 内容安全策略（CSP）

```javascript
// 在缓存响应前添加安全头
function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
}
```

### 9.3 敏感数据处理

- **禁止**缓存包含敏感信息的响应（如 API Token）
- **必须**排除认证相关的请求

```javascript
function shouldCache(request) {
  const url = new URL(request.url);

  // 排除认证请求
  if (url.pathname.includes('/api/auth')) {
    return false;
  }

  // 排除包含 token 的请求
  if (url.searchParams.has('token')) {
    return false;
  }

  return true;
}
```

---

## 10. 测试与验证

### 10.1 功能测试清单

- [ ] Service Worker 成功注册
- [ ] 静态资源成功缓存
- [ ] 离线模式下应用可访问
- [ ] 推送通知成功接收
- [ ] 推送通知成功显示
- [ ] 点击通知正确打开页面
- [ ] 版本更新正确清理旧缓存
- [ ] 页面与 Service Worker 消息通信正常

### 10.2 推送通知测试

```javascript
// 测试推送通知（在浏览器控制台运行）
navigator.serviceWorker.ready.then(registration => {
  registration.showNotification('测试通知', {
    body: '这是一条测试消息',
    icon: '/icons/icon-192.png',
    tag: 'test',
    data: {
      url: '/',
      messageId: 'test-123'
    }
  });
});
```

### 10.3 性能监控

```javascript
// 记录缓存命中率
let cacheHits = 0;
let cacheMisses = 0;

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          cacheHits++;
        } else {
          cacheMisses++;
        }

        // 每 100 个请求记录一次
        if ((cacheHits + cacheMisses) % 100 === 0) {
          const hitRate = (cacheHits / (cacheHits + cacheMisses) * 100).toFixed(2);
          console.log(`[SW] 缓存命中率: ${hitRate}%`);
        }

        return response || fetch(event.request);
      })
  );
});
```

---

## 11. 浏览器兼容性

### 11.1 功能检测

```javascript
// 在主页面中检测支持
if ('serviceWorker' in navigator) {
  console.log('✅ Service Worker 支持');
} else {
  console.warn('❌ Service Worker 不支持');
}

if ('PushManager' in window) {
  console.log('✅ Push API 支持');
} else {
  console.warn('❌ Push API 不支持');
}

if ('Notification' in window) {
  console.log('✅ Notification API 支持');
} else {
  console.warn('❌ Notification API 不支持');
}
```

---

## 12. 部署要求

### 12.1 文件位置

- **必须**将 Service Worker 文件放在网站根目录（或应用根目录）
- **推荐**命名为 `service-worker.js` 或 `sw.js`

### 12.2 注册代码

```javascript
// 在主页面中注册 Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(registration => {
        console.log('✅ Service Worker 注册成功:', registration.scope);

        // 检查更新
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          console.log('🔄 发现新版本 Service Worker');

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // 新版本可用，提示用户刷新
              if (confirm('应用有新版本可用，是否刷新页面？')) {
                newWorker.postMessage({ type: 'SKIP_WAITING' });
                window.location.reload();
              }
            }
          });
        });
      })
      .catch(error => {
        console.error('❌ Service Worker 注册失败:', error);
      });
  });

  // 监听 Service Worker 控制权变化
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    console.log('🔄 Service Worker 已更新');
  });
}
```

### 12.3 HTTP 头部配置

```
# Service Worker 文件必须设置正确的 MIME 类型
Content-Type: application/javascript; charset=utf-8

# 禁用缓存以确保总是获取最新版本
Cache-Control: no-cache, no-store, must-revalidate
```

---

## 13. 故障排查

### 13.1 常见问题

#### 问题：Service Worker 未注册

**可能原因**:
- 不是 HTTPS 环境（localhost 除外）
- 文件路径错误
- 文件 MIME 类型错误

**解决方案**:
1. 检查浏览器控制台错误信息
2. 验证 Service Worker 文件可访问
3. 确认服务器返回正确的 Content-Type

#### 问题：推送通知未显示

**可能原因**:
- 通知权限未授予
- 推送订阅失效
- 推送数据格式错误

**解决方案**:
1. 检查通知权限状态
2. 重新订阅推送服务
3. 验证推送数据格式

#### 问题：缓存未更新

**可能原因**:
- Service Worker 未更新
- 旧版本仍在控制页面

**解决方案**:
1. 在 DevTools 中强制更新 Service Worker
2. 清除浏览器缓存
3. 使用 `skipWaiting()` 和 `clients.claim()`

### 13.2 调试工具

- **Chrome DevTools**: Application > Service Workers
- **Firefox DevTools**: Application > Service Workers
- **Safari Web Inspector**: Storage > Service Workers

---

## 14. 完整模板示例

```javascript
// service-worker.js
// 版本: 1.0.0
// 更新: 2025-10-13

// ==================== 配置 ====================
const CACHE_NAME = 'my-app-v1.0.0';
const CACHE_VERSION = Date.now();

const CACHE_CONFIG = {
  STATIC_CACHE: 'my-app-static-v1',
  DYNAMIC_CACHE: 'my-app-dynamic-v1',
  IMAGE_CACHE: 'my-app-images-v1',
  MAX_DYNAMIC_ITEMS: 50,
  MAX_IMAGE_ITEMS: 100
};

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js'
];

// ==================== Install ====================
self.addEventListener('install', event => {
  console.log('[SW] 安装中...', CACHE_VERSION);

  event.waitUntil(
    caches.open(CACHE_CONFIG.STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(error => console.error('[SW] 安装失败:', error))
  );
});

// ==================== Activate ====================
self.addEventListener('activate', event => {
  console.log('[SW] 激活中...', CACHE_VERSION);

  event.waitUntil(
    Promise.all([
      caches.keys().then(cacheNames => {
        const currentCaches = Object.values(CACHE_CONFIG);
        return Promise.all(
          cacheNames.map(name => {
            if (!currentCaches.includes(name)) {
              console.log('[SW] 删除旧缓存:', name);
              return caches.delete(name);
            }
          })
        );
      }),
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'SW_ACTIVATED',
            version: CACHE_VERSION
          });
        });
      })
    ])
    .then(() => self.clients.claim())
  );
});

// ==================== Fetch ====================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (!url.protocol.startsWith('http')) {
    return;
  }

  event.respondWith(
    caches.match(request)
      .then(response => response || fetch(request))
      .catch(error => {
        console.warn('[SW] Fetch 失败:', request.url);
        if (request.destination === 'document') {
          return caches.match('/offline.html');
        }
        throw error;
      })
  );
});

// ==================== Push ====================
self.addEventListener('push', event => {
  console.log('[SW] 收到推送通知');

  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { title: '新消息', message: '您有一条新消息' };
  }

  const options = {
    body: data.message || '您有一条新消息',
    icon: data.avatarUrl || '/icons/icon-192.png',
    badge: '/icons/badge.png',
    tag: data.messageId || `msg-${Date.now()}`,
    data: data,
    actions: [
      { action: 'open', title: '查看' },
      { action: 'dismiss', title: '关闭' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '新消息', options)
  );
});

// ==================== Notification Click ====================
self.addEventListener('notificationclick', event => {
  const { notification, action } = event;
  notification.close();

  if (action === 'dismiss') {
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window' })
      .then(clients => {
        for (const client of clients) {
          if (client.url === '/' && 'focus' in client) {
            client.postMessage({
              type: 'NOTIFICATION_CLICKED',
              data: notification.data
            });
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow('/');
        }
      })
  );
});

// ==================== Message ====================
self.addEventListener('message', event => {
  const { type } = event.data || {};

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ==================== Error ====================
self.addEventListener('error', event => {
  console.error('[SW] 错误:', event.error);
});
```

---

## 15. 变更日志

### v1.0.0 (2025-10-13) - 初始版本

**核心功能**:
- 定义 Service Worker 生命周期事件处理规范
- 定义推送通知接收和显示规范
- 定义缓存策略和资源管理规范
- 定义消息通信机制

**标准定义**:
- 版本控制规范
- 错误处理规范
- 性能优化建议
- 安全要求
- 测试清单

---

## 16. 许可与贡献

### 16.1 许可证

本标准文档采用 **CC BY-NC-SA 4.0** 协议发布。

### 16.2 贡献指南

欢迎对本标准提出改进建议：
1. 提交 Issue 描述问题或建议
2. Fork 仓库并创建 Pull Request
3. 遵循现有文档格式
4. 清晰描述变更原因和影响

或在 QQ 群内提出相关建议。

---

## 17. 相关资源

- **Service Worker API**: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
- **Push API**: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- **Notification API**: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API
- **Cache API**: https://developer.mozilla.org/en-US/docs/Web/API/Cache
- **主动消息API标准**: [active-messaging-api.md](./active-messaging-api.md)
