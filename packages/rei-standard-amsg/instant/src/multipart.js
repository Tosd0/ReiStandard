// multipart transport 的线协议常量（kind / encoding / version 与接收端限额
// 默认值）与发送端切片构造，单一来源都在 @rei-standard/amsg-shared —— sw 的
// 重组端、amsg-server 的发送端认的是同一份。
// 这里 re-export 保持本包既有导出名不变。
export {
  MULTIPART_MESSAGE_KIND,
  DEFAULT_MULTIPART_TTL_MS,
  DEFAULT_MULTIPART_MAX_CHUNKS,
  DEFAULT_MULTIPART_MAX_TOTAL_BYTES,
  DEFAULT_MULTIPART_CHUNK_BYTES,
  buildMultipartPushPayloads,
} from '@rei-standard/amsg-shared';
