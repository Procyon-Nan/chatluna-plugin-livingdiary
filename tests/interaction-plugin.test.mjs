import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import AI from '@chatluna/ai-runtime'
import * as verbs from '@chatluna/ai-runtime/ops'
import ChatLuna from '@chatluna/core'
import Prompt from '@chatluna/prompt'
import { chatKind } from '@chatluna/preset'
import { characterKind } from '@chatluna/engine-character'
import { renderPersona } from '../lib/persona.js'
import { Config } from '../lib/config.js'
import { registerAutoInteraction } from '../lib/auto-interaction/index.js'

test('独立互动渲染 chat 和 character 的系统段，保留角色风格与示例', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(Prompt)
    ctx.prompt.variable({ name: 'display', mutable: false }, ({ env }) => env.botName)
    const render = (kind, data) => renderPersona({
        prompt: ctx.prompt, presets: { blocks: preset => kind.blocks(preset.id, preset.data) }
    }, { id: 'p', name: '人设 A', kind: kind.id, data }, new Date())
    const blocks = [{ id: 'p', content: '人设：{display}', enabled: true, zone: 'system', role: 'system' }]
    assert.equal(await render(chatKind, { blocks }), '人设：人设 A')
    const data = { persona: '人设：{display}', style: '悠闲', example: '你好。', context: '当前群聊' }
    const persona = await render(characterKind, data)
    assert.match(persona, /人设：人设 A[\s\S]*悠闲[\s\S]*你好。/)
    assert.doesNotMatch(persona, /当前群聊/)
})

test('真实模型调度：无需 LivingMemory，按空间人设与互动模型只评论白名单好友的新动态', async t => {
    const start = Date.UTC(2026, 10, 10, 12)
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: start })
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(ChatLuna)
    await ctx.plugin(AI)
    await ctx.plugin(verbs)
    await ctx.plugin(Prompt)
    ctx.provide('presets', {
        get: id => id === 'space' ? { id, name: '观星者', kind: 'chat', status: 'ok' } : undefined,
        blocks: () => [{ id: 'who', zone: 'system', content: '我喜欢夜空。' }]
    })

    const requests = []
    ctx.ai.provide('local', { id: 'local', chat: id => ({
        id, spec: 'v1', modality: 'chat', provider: 'local', caps: () => ({}),
        async *stream({ params }) {
            requests.push({ id, params })
            const toolName = 'submit_qzone_interaction', input = { action: 'publish', content: '今晚一起看星星！' }
            yield { type: 'start', warnings: [] }
            yield { type: 'block-start', index: 0, kind: 'tool-call' }
            yield { type: 'tool-input', index: 0, toolCallId: '1', toolName, delta: JSON.stringify(input) }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', toolCallId: '1', toolName, input } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
        }
    }) })
    const post = (id, authorId, at) => ({
        id, authorId, author: { id: authorId, nickname: '好友' }, content: id, createdAt: new Date(at).toISOString(),
        comments: [], commentsComplete: true, media: [], likeCount: 0, commentCount: 0, liked: false
    })
    const timeline = [post('启动前', '200', start - 1000)]
    const writes = []
    const qzone = {
        status: () => ({ bot: { selfId: '100' }, client: { accountId: '100' } }),
        listFeedPage: async () => ({ items: timeline, nextCursor: null }),
        getPost: async ({ post }) => timeline.find(item => item.id === post.id),
        async comment({ post, content }) { writes.push([post.id, content]); return { outcome: 'accepted' } }
    }
    const reports = { digest: null, interaction: null }
    const config = Config({
        allowUserIds: ['300'], interactionAllowUserIds: ['200'], personaPresetId: 'space',
        mainModel: 'local:diary', subModel: 'local:social', enableFriendPostComment: true,
        interactionMonitorPostLimit: 0, interactionPollIntervalMinutes: 1
    })
    const plugin = await ctx.plugin({
        inject: ['ai', 'chatluna', 'prompt', 'presets'],
        apply: scope => registerAutoInteraction(scope, config, qzone, reports)
    })
    const settle = () => new Promise(resolve => setImmediate(resolve))
    await settle()
    assert.equal(reports.interaction().phase, 'ready')
    timeline.unshift(post('有命令权限的人', '300', start + 1000), post('今晚看星星', '200', start + 1000))
    for (let i = 0; i < 2; i++) { t.mock.timers.tick(60_000); await settle() }
    assert.deepEqual(writes, [['今晚看星星', '今晚一起看星星！']])
    assert.equal(requests.length, 1)
    assert.equal(requests[0].id, 'social')
    assert.match(requests[0].params.system, /我喜欢夜空/)
    await plugin.dispose()
    assert.equal(reports.interaction, null)
})
