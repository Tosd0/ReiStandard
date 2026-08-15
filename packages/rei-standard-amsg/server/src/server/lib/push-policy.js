/**
 * 「这条 push 值不值得占用推送通道」——发送前的最后一道判定。
 *
 * 订阅是按 `userVisibleOnly: true` 建的：每条 push 都欠用户一次可见反馈。到
 * 了客户端不会弹通知的 payload（`reasoning` / `tool_request` / `error`，以及
 * 显式 `notification: { show: false }` 的那些）推过去只是白白违约一次——
 * Firefox 对这类 push 有配额、超了退订，iOS 给新订阅几天宽限期、过后一条就
 * 吊销订阅，而且掉订阅是静默发生的，服务端只看得到后续推送返回 410。
 *
 * 这些内容本来就整批落进了 `message_outbox`（见 lib/outbox-store.js），客户端
 * 上线 `GET /outbox?since=` 一条不少地补得回来。所以不推它们、只落行：既不动
 * 内容的到达性，又不拿订阅去换一条根本不会显示的横幅。
 *
 * 唯一的例外是**这一批没落进 outbox**（适配器没实现、或落行失败）。那时推送
 * 是这条内容唯一的腿，再砍掉内容就真没了——宁可违约一次，也不能让它凭空消失。
 *
 * 想让某一条照样弹，给它带上 `notification: { show: 'always' }`：这里读的是
 * 与 Service Worker 同一份 `notificationIntent`，宿主说了要弹就照推。逐条控制
 * 比一个「全推 / 全不推」的开关准，也不用为它记一套新语义。
 *
 * 跳过的那条不进 sentIds，所以 outbox 行上的 `delivered_at` 保持为空——客户端
 * 下次补收正好拿到它，这是「跳过推送」能成立的前提。
 */

import { notificationIntent } from '@rei-standard/amsg-shared';

/**
 * 这条 push 要不要真的发出去。
 *
 * @param {Record<string, unknown>} push - 定稿后的 push 对象
 * @param {Object}  options
 * @param {boolean} options.outboxed - 这一批是否真的落进了 outbox
 * @returns {boolean}
 */
export function shouldSendPush(push, { outboxed }) {
  if (!outboxed) return true;
  return notificationIntent(push) !== 'never';
}
