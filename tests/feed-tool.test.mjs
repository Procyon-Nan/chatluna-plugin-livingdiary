import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import Tools from '@chatluna/tool'
import * as diary from '../lib/index.js'
import { registerFeedTool } from '../lib/qzone/feed-tool.js'

const name = 'qzone_list_feeds'
const subject = { user: '123', platform: 'onebot', source: 'chat' }
const principal = { turnId: 'turn', source: 'chat', wakingPrincipals: [subject], subject, mixed: false, contextTainted: false }

async function setup(t, listFeedPage) {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(Tools)
    await ctx.plugin({ inject: ['tools'], apply(scope) {
        registerFeedTool(scope, { allowUserIds: ['123'], feedsDefaultLimit: 7 }, { listFeedPage })
    } })
    return (args, who = principal) => ctx.tools.execute({ name, args, principal: who })
}

test('动态工具保留好友流顺序、完整配文和动态引用，同一范围可继续翻页', async t => {
    const post = { id: 'a', authorId: '456', author: { nickname: '甲' }, content: '第一行\n第二行',
        createdAt: '2026-11-24T00:00:00Z', likeCount: 3, commentCount: 1,
        media: [{ kind: 'image' }, { kind: 'video' }, { kind: 'image' }] }
    const card = { title: '音乐', summary: '试听', url: 'https://example.com/song' }
    const shared = { ...post, id: 'b', content: '', createdAt: '2026-11-25T00:00:00Z', media: [], share: { ...card, previewUrl: 'cover' } }
    const queries = []
    const run = await setup(t, async ({ signal, ...query }) => {
        assert.ok(signal instanceof AbortSignal)
        queries.push(query)
        return query.cursor ? { items: [], nextCursor: null } : { items: [post, shared], nextCursor: 'next' }
    })
    const first = await run({ scope: 'friends' })
    assert.equal(first.ok, true, JSON.stringify(first.error))
    const summary = { id: 'a', authorId: '456', nickname: '甲', createdAt: post.createdAt, content: post.content,
        likeCount: 3, commentCount: 1, mediaCounts: { image: 2, video: 1, audio: 0, file: 0 } }
    assert.deepEqual(first.value, { items: [summary, { ...summary, id: 'b', createdAt: shared.createdAt,
        content: '', mediaCounts: { ...summary.mediaCounts, image: 0, video: 0 }, share: card }], nextCursor: 'next' })
    assert.deepEqual((await run({ scope: 'friends', cursor: first.value.nextCursor })).value, { items: [], nextCursor: null })
    for (const args of [{ scope: 'self', limit: 1 }, { userId: '456', limit: 10 }]) assert.equal((await run(args)).ok, true)
    assert.deepEqual(queries, [
        { scope: 'friends', limit: 7, cursor: undefined }, { scope: 'friends', limit: 7, cursor: 'next' },
        { scope: 'self', limit: 1, cursor: undefined }, { scope: 'profile', userId: '456', limit: 10, cursor: undefined }
    ])
})

test('未授权和无效查询不读取动态；游标失效不重读首页', async t => {
    const reads = []
    const run = await setup(t, query => { reads.push(query); throw new Error('分页游标已失效') })
    const stranger = { ...subject, user: '456' }
    assert.equal((await run({ scope: 'self' }, { ...principal, subject: stranger, wakingPrincipals: [stranger] })).ok, false)
    for (const args of [{}, { scope: 'friends', userId: '456' }, { scope: 'profile' }, { userId: '昵称' },
        { scope: 'self', cursor: '' }, ...[0, 11, 2.5].map(limit => ({ scope: 'self', limit }))]) {
        assert.equal((await run(args)).ok, false, JSON.stringify(args))
    }
    assert.equal(reads.length, 0)
    const expired = await run({ scope: 'friends', cursor: 'expired' })
    assert.equal(expired.ok, false)
    assert.match(expired.error.message, /游标已失效/)
    assert.deepEqual(reads.map(q => q.cursor), ['expired'])
})

test('关闭发布后，插件仍注册前台只读动态工具', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    ctx.provide('satori', { bots: [] })
    await ctx.plugin(Tools)
    await ctx.plugin(diary, { enablePublishTool: false })
    const definitions = ctx.tools.catalog().map(item => item.definition)
    const feed = definitions.find(tool => tool.name === name)
    assert.equal(feed.traits.effect, 'read')
    assert.equal(feed.traits.background, false)
    assert.ok(!definitions.some(tool => tool.name === 'qzone_publish'))
})
