---
"@rei-standard/amsg-server": minor
---

必然失败的投递不再白跑三轮，`PUT /update-message` 认它该认的字段、也不再谎报改了什么

**1. instant 任务的重试判定跟定时任务对齐**

`messageType: 'instant'` 的任务失败后会重试三轮。原来这条路只看 hook 抛没抛 `NonRetryableError`，定时任务那条退避阶梯却还会看错误码和推送状态码——于是「用户压根没登记推送订阅」「推送服务回 410 说这条订阅没了」这类必然同败的错误，在 instant 上照样重试满三轮，每轮都把整轮 LLM 生成重跑一遍。

现在两条路共用同一份判定（永久性错误码 / 终态推送状态码 / payload 超限 / hook 标注的确定性失败），instant 任务遇到这些当场返回，`error.permanent` 为 `true`。说不清是什么毛病的失败（网络抖动之类）照常重试满。

**2. fire-time hook 的契约违约带上了稳定的 `code`，也算确定性失败**

宿主 hook 返回了库不认的东西、或者轮数用尽也没等到 `finish`——这些错误原来是裸 `Error`，错误码只写在消息文本的前缀里，投递侧读到的 `errorCode` 是 `null`，于是按普通投递失败排退避阶梯，每一跳重试都把 `onBeforeFire` 和一整轮 LLM 重跑一遍。

现在它们都带 `permanent: true` 和一个稳定的 `code`：

`AGENTIC_BAD_BEFORE_FIRE` / `AGENTIC_BAD_DECISION` / `AGENTIC_EMPTY_TOOL_REQUEST` / `AGENTIC_LOOP_EXCEEDED` / `AGENTIC_SCHEDULE_FAILED`

错误消息和类型都没变（决策校验抛的仍是 `TypeError`，`scheduleTask` 的参数护栏仍是 `TypeError` / `RangeError`），按消息文本或类型分流的宿主代码不受影响。

部署级的配置 / 适配器能力错误是另一档，见下面的 `DeploymentConfigError`。`AGENTIC_TOTAL_TIMEOUT`（整条 fire 链超出 `totalTimeoutMs`）也走退避重试：这一轮慢不代表下一轮也慢。

**2b. 部署配错了走退避重试，新增 `DeploymentConfigError`**

没配 `onLLMOutput` / `executeToolCalls`，或者自定义适配器缺 `createTask` / `deleteTaskByUuid` / `getTaskByUuid` / `upsertClientState`——这类错误抛的是新导出的 `DeploymentConfigError`，带 `code`（`AGENTIC_CONFIG_ERROR` / `AGENTIC_SCHEDULE_UNSUPPORTED` / `AGENTIC_CANCEL_UNSUPPORTED` / `AGENTIC_RENEW_UNSUPPORTED` / `AGENTIC_STATE_WRITE_UNSUPPORTED`）但不带 `permanent`，走普通的退避阶梯。

坏的不是某一条任务，是这个部署：同一个坏部署下每条到点的任务都撞同一个错，判终态等于把那段时间里每条一次性任务都永久标 `failed`，运维改好配置重新部署也捞不回来（行已不在 `pending`，`PUT /update-message` 回 409）。留在阶梯上，配置一修好，还在阶梯上的任务下一跳就正常发出去。VAPID 配错回的 400 / 401 / 403 一直是这么处理的。

**3. hook 建的任务也过任务内容大小闸门**

`scheduleTask` 建任务原来不量大小——`POST /schedule-message` 和 `PUT /update-message` 都过这道闸门，只有它绕过去了。hook 往 `metadata` 里塞一坨大对象就会一路走到落库那步，撞上存储的单行上限，抛出来的正是当初加闸门要消灭的那种看不出所以然的错。现在超限当场抛 `RangeError`（`code: 'TASK_PAYLOAD_TOO_LARGE'`），一行都不落库。

这道闸门排在建任务额度之前，跟其余参数护栏（`contactName` / `uuid` / `tzId` …）一致：正文超限也是「这次调用的参数不合法」，不占 `maxScheduledTasksPerFire` 的额度，hook 捕获之后换份小 `metadata` 重排照样排得进去。

**4. `userMessage` 必须是字符串**

`POST /schedule-message` 和 `PUT /update-message` 原来只看 `userMessage` 是不是真值。传个数字进来会被收下、落库，到点投递时才炸在正文切分上——那时早已离开 HTTP 请求，用户看到的只是一条任务莫名其妙失败，还连着重试三轮同样地失败。现在这两个入口当场返回 `400`。

**5. `PUT /update-message` 收 `messageSubtype` 和 `llmExtraBody`**

这两个字段 `POST /schedule-message` 一直收，更新接口的合并白名单里却没有——请求带上它们会拿到 `200`，库里一个字节没变。现在能改了，显式传 `null` 表示改回默认（分别是投递时的 `'chat'` 和「不透传额外参数」）。

**6. `updatedFields` 只列真正落库的字段**

响应里的 `updatedFields` 原来是把请求里的键照单列回去。这个接口不接受的键、拼错的键、传了 `null` 走「不改」语义的字段，都会被报成「改了」，而库里其实没动。现在只列真正落进这次更新的那些。
