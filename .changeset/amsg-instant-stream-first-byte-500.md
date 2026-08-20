---
"@rei-standard/amsg-instant": patch
---

Node 适配器：响应流在首字节前就失败时回干净的 500，不再断连

`toNodeHandler` / `toVercelNodeHandler` 收到的 Response 流如果在吐出第一个字节之前就出错（典型形态：`start` / 首次 `pull` 里懒加载资源失败），原来客户端看到的是一次 connection reset（`fetch()` 直接抛 `TypeError: fetch failed`），状态码和错误码一概读不到。现在这一档回 `500 { success: false, error: { code: 'ADAPTER_ERROR', message } }`，跟适配器其他阶段的故障同一个信封，服务端也照旧记一行能归因的日志。

「连接直接断开」这个行为保持不变，但只属于它该在的场景：字节已经发出去一部分、流中途才失败——响应头早已发出，追加 JSON 信封只是往流里塞垃圾，断连才能让调用方看出这是一条没收完的流。首字节前失败时客户端一个字节都没收到，断连没有任何信息量，所以收回 500 信封这档。

实现上是在进 `pipeline` 之前先手动读一次首块：`pipeline` 无论因为什么失败都会先把 `res` 销毁，销毁完就只剩断连一条路；首块读失败时 `res` 还一个字节都没沾，走的还是外层原有的 500 兜底。首块读到了才写响应头开始转发，客户端不会因此多等——Node 本来就攒着响应头等第一个字节一起发。
