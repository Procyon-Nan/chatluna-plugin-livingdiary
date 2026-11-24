import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import { h, Universal } from '@satorijs/core'
import { OneBotMessageEncoder } from 'koishi-plugin-adapter-onebot'
import Tools from '@chatluna/tool'
import { QzoneNotFoundError } from 'qzone-sdk'
import * as diary from '../lib/index.js'
import { registerVideoTool } from '../lib/qzone/video-tool.js'

const src = 'https://photovideo.photo.qq.com/demo.mp4?clip=1&quality=2'
const video = { kind: 'video', url: src }
const makePost = (id, authorId, nickname, media, day) => ({
    id, authorId, author: { id: authorId, nickname }, media, createdAt: '2026-11-' + day + 'T07:26:08.000Z'
})
const timeline = [
    makePost('b', '2', 'Procyon B', [video], '24'), makePost('old', '1', 'Procyon', [video], '21'),
    makePost('text', '1', 'Procyon', [], '24'), makePost('chosen', '1', 'Procyon', [video], '23')
]
async function setup(t, posts = timeline) {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    const gate = { video: true }, agent = {}, routeId = 'onebot:test'
    const rules = { values: { 'chat.rich': gate }, get: () => gate }
    ctx.provide('chat', {
        channels: { ofRoute: () => [{ live: { agent }, inbound: { rules, routeId } }] },
        expressions: () => [{ name: 'video', enabled: true }]
    })
    await ctx.plugin(Tools)
    const reads = []
    await ctx.plugin({ inject: ['chat', 'tools'], apply(scope) {
        registerVideoTool(scope, { allowUserIds: ['123'] }, {
            async listFeedPage(query) { reads.push([query.scope, query.userId, query.limit]); return { items: posts } },
            async getPost({ post }) {
                reads.push([post.authorId, post.id])
                const match = posts.find(p => p.authorId === post.authorId && p.id === post.id)
                if (!match) throw new QzoneNotFoundError('动态不存在')
                return match
            }
        })
    } })
    const wake = { user: '123', platform: 'onebot', source: 'chat', route: routeId }
    const principal = { turnId: 'turn', routeId, source: 'chat', wakingPrincipals: [wake], subject: wake, mixed: false, contextTainted: false }
    const run = (args, who = principal) => ctx.tools.execute({ name: 'qzone_get_video', args, agent, principal: who })
    return { run, principal, gate, reads }
}

test('按昵称查询选定视频；模拟回复抵达 OneBot 的群消息接口一次', async t => {
    const { run, reads } = await setup(t, timeline.slice(1))
    const result = await run({ author: 'pRocyo' })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(result.value.postId, 'chosen')
    assert.deepEqual(reads, [['friends', undefined, 20], ['1', 'chosen']])
    const sends = []
    const encoder = Object.assign(Object.create(OneBotMessageEncoder.prototype), {
        children: [], stack: [{ type: 'message', author: {}, children: [] }], results: [], channelId: '100',
        session: { event: { channel: { type: Universal.Channel.Type.TEXT } } },
        bot: { session: () => ({ app: { emit() {} }, event: { message: {} } }),
            internal: { sendGroupMsg: async (id, segments) => { sends.push([id, segments]); return 1 } } }
    })
    const reply = h('message', result.value.videos.map(url => h('video', { src: url }))).toString()
    for (const element of h.parse(reply)) await encoder.visit(element)
    await encoder.flush()
    assert.deepEqual(sends, [['100', [{ type: 'video', data: { file: src, cache: 0 } }]]])
})

test('区分前缀重名和精确匹配，只查询指定作者与动态', async t => {
    const { run, reads } = await setup(t)
    assert.deepEqual((await run({ author: 'Procyo' })).value.candidates.map(a => a.id), ['2', '1'])
    assert.equal((await run({ author: 'Procyon' })).value.postId, 'chosen')
    assert.equal((await run({ author: '2' })).value.postId, 'b')
    assert.match((await run({ author: '1', postId: 'text' })).value.message, /没有可转发/)
    assert.match((await run({ author: 'missing' })).value.message, /20 条好友动态/)
    assert.deepEqual(reads, [['friends', undefined, 20], ['friends', undefined, 20], ['1', 'chosen'],
        ['profile', '2', 20], ['2', 'b'], ['1', 'text'], ['friends', undefined, 20]])
})

test('指定动态不存在或 ID 为空时不改查最新视频', async t => {
    const { run, reads } = await setup(t)
    assert.match((await run({ author: '1', postId: 'b' })).value.message, /未找到指定作者/)
    assert.equal((await run({ author: '1', postId: '   ' })).ok, false)
    assert.deepEqual(reads, [['1', 'b']])
})

test('非请求者、定时唤醒或关闭视频规则时不读取空间也不返回地址', async t => {
    const { run, reads, principal, gate } = await setup(t)
    for (const who of [{ ...principal, subject: { user: '456', platform: 'onebot' } },
        { ...principal, source: 'schedule' }, { ...principal, source: 'mixed', subject: undefined }]) {
        assert.equal((await run({ author: '1' }, who)).ok, false)
    }
    gate.video = false
    const result = await run({ author: '1' })
    assert.equal(result.ok, false)
    assert.match(result.error.message, /未开启视频/)
    assert.deepEqual(reads, [])
})

test('关闭发布工具仍注册只读视频工具', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    ctx.provide('satori', { bots: [] })
    ctx.provide('chat', {})
    await ctx.plugin(Tools)
    await ctx.plugin(diary, { enablePublishTool: false })
    const entries = ctx.tools.catalog().map(item => item.definition.name)
    assert.ok(entries.includes('qzone_get_video'))
    assert.ok(!entries.includes('qzone_publish'))
})
