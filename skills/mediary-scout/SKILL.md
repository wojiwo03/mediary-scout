---
name: mediary-scout
description: >-
  操作本机运行的 Mediary Scout（自托管媒体获取 agent）——改配置、找片/下片、查库存与进度，全程走本地 HTTP API，无需打开桌面客户端。
  Use when the user wants to find, download, or track movies / TV shows / anime through Mediary Scout, check download progress, inspect their tracked library, change Mediary settings (quality / language / LLM / drives), or trigger a patrol sweep.
  触发词：「帮我找 XX」「帮我下 XX」「XX 下好了吗」「XX 下载到哪了」「我在追哪些剧」「我的库存」「缺哪几集」「把画质改成 4K」「改成中文字幕优先」「触发一次巡检」「跑一遍巡检」。
  Triggers: find/download a movie/show/anime, check download or acquisition progress, list what I'm tracking, show missing episodes, change quality preference to 4K, set preferred language, trigger/force a patrol, read or update Mediary Scout config.
---

# Mediary Scout — Agent 操作面

你在通过本地 HTTP API 操作用户本机运行的 Mediary Scout。所有细节（完整 schema、错误码、字段清单）在 `references/api.md`。

## 1. 连接（每次先做）

发现文件在 `~/.mediary/agent.json`（权限 0600），内容：
`{ "baseUrl": "http://127.0.0.1:<port>", "token": "<hex>", "version": "<app version>" }`

```bash
cat ~/.mediary/agent.json
```

- **文件不存在** → 用户还没启动过。让用户打开 **Mediary Scout 桌面 app**（首启会生成 token 并写这个文件），然后重试。
- **文件存在但 curl connection refused** → app 没在运行。让用户启动 Mediary Scout 桌面 app。
- **文件存在且能连** → 继续。

之后所有调用都用这两个变量：

```bash
TOKEN=$(jq -r .token ~/.mediary/agent.json)
BASE=$(jq -r .baseUrl ~/.mediary/agent.json)
```

请求统一带 `-H "Authorization: Bearer $TOKEN"`。

## 2. 能力速查（用户说什么 → 调什么）

| 用户意图 | 端点 | curl |
|---|---|---|
| 查当前配置（画质/语言/LLM/推送…） | `GET /api/agent/config` | `curl -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/config"` |
| 改配置（画质、HDR、片源阶梯、升级策略、选片方式、识别词、语言、扫描时间…，传啥改啥） | `PUT /api/agent/config` | `curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"qualityPreference":"high","acquisitionSelectionMode":"rules"}' "$BASE/api/agent/config"` |
| 「帮我找/下 XX」 | `POST /api/agent/acquire` | `curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"query":"进击的巨人","type":"tv","season":2}' "$BASE/api/agent/acquire"` |
| 「触发一次巡检」「跑一遍巡检」 | `POST /api/agent/patrol` | `curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/patrol"` |
| 「我在追哪些剧」「缺哪几集」「我的库存」 | `GET /api/agent/library` | `curl -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/library"` |
| 「XX 下好了吗」「下载到哪了」「最近在忙啥」 | `GET /api/agent/activity` | `curl -H "Authorization: Bearer $TOKEN" "$BASE/api/agent/activity?limit=20"` |

`acquire` body 字段：`query`(必填)、`type`(`"tv"`/`"movie"`/`null`)、`season`(数字/`null`)、`storageId`(`"cs_…"`/`null`，缺省用 primary drive)、`tmdbId`(数字/`null`，用于消歧重发)、`qualityUpgrade`(布尔，显式升级已入库画质)。

画质/DV/HDR/片源/音轨只在召回后读候选标题，**不要**让用户把这些词写进搜索 query。`acquisitionSelectionMode`：`auto`（默认，有 LLM 走 agent，否则规则选片）/ `agent` / `rules`（`non_agent` 同 `rules`）。`customIdentifierWords` 是 MoviePilot 语法识别词数组（屏蔽 / `from => to` / 集偏移）；规则选片与画质升级会套用，内置词先生效。网盘分享若把季/画质写在文件夹、集数写在文件名，规则选片会联合解析。定时追更补集与定时画质升级是两项独立任务、共用巡检时间；要巡检也升级须 `patrolQualityUpgrade: true`。`GET /api/agent/config` 的 `qualityLadderSummary` 是当前阶梯的可读摘要。详见仓库 `docs/quality-upgrade-and-hdr.md`。

## 3. 关键规则（必须遵守）

1. **409 歧义 → 交给用户挑，绝不瞎猜。** `acquire` 命中多个高分候选时返回 `409 { "candidates": [top5] }`。把候选（标题/年份/tmdbId）列给用户，让用户选一个，再带 `"tmdbId": <所选>` 重发同一 `acquire`。禁止自行替用户拍板。
2. **脱敏值绝不回写。** `GET config` 里秘密字段只露尾 4 位或显示为 `***`（如 `"apiKey": "sk-***7f2a"`、`"tmdbApiKey": "***"`）。**任何以 `***` 开头或含 `***` 的值都禁止写回 `PUT config`**——服务端会 400，且回写会毁掉真凭据。
3. **秘密字段只在用户明确给出新值时才写。** LLM apiKey、tmdbApiKey、prowlarr.apiKey、推送密钥等，只有用户在本次对话里明确提供了新的明文值，才放进 `PUT` body。用户没提就别碰这些字段。
4. **storages 只读。** `GET config` 会列出 `storages`（id/brand/name，不含凭据）；`PUT config` 不接受 `storages`，改盘绑定要在桌面 app 里做。
5. **未运行 / 未配置。** 端点隐身（返回 404、非预期结构）时：多半是 app 没运行或该环境没配 agent token——提示用户启动桌面 app，别把 404 当「没找到片」（找片的「无匹配」也是 404，用返回体区分：有 `candidates` 是歧义，有 `matched`/`status` 是成功，纯 404 且带 no-token 语义是未启用）。

完整请求/响应 schema、全部错误码（404 无 token / 无匹配、401 token 错、409 候选、403 demo、400 校验）、字段级说明见 `references/api.md`。
