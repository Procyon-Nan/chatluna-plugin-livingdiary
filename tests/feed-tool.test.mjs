import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import Tools from '@chatluna/tool'
import * as diary from '../lib/index.js'
import { registerFeedTool } from '../lib/qzone/feed-tool.js'

const name = 'qzone_list_feeds'
const subject = { user: '123', platform: 'onebot', source: 'chat' }
const principal = { turnId: 'turn', source: 'chat', wakingPrincipals: [subject], subject, mixed: false, contextTainted: false }

async function setup(t, listFeedPage, services = {}) {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    for (const [key, value] of Object.entries(services)) ctx.provide(key, value)
    await ctx.plugin(Tools)
    await ctx.plugin({ inject: ['tools'], apply(scope) {
        registerFeedTool(scope, { allowUserIds: ['123', '789'], feedsDefaultLimit: 7 }, { listFeedPage })
    } })
    return (args, who = principal, tool = name, routeId = 'group:1') =>
        ctx.tools.execute({ name: tool, args, principal: { ...who, routeId }, agentId: 'bot' })
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
    const [firstPost, secondPost] = first.value.items
    assert.deepEqual(firstPost.media.map(m => m.kind), ['image', 'video', 'image'])
    assert.deepEqual(firstPost, { ...summary, media: firstPost.media })
    assert.equal(typeof secondPost.share.coverRef, 'string')
    assert.deepEqual(secondPost, { ...summary, id: 'b', createdAt: shared.createdAt, content: '', media: [],
        mediaCounts: { ...summary.mediaCounts, image: 0, video: 0 }, share: { ...card, coverRef: secondPost.share.coverRef } })
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
    assert.equal(definitions.find(tool => tool.name === 'qzone_read_media').traits.effect, 'read')
    assert.ok(!definitions.some(tool => tool.name === 'qzone_publish'))
})

test('按原序编号读取原图、视频和独立封面，工具结果包含对应的模型文件块', async t => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Ne8AAAAASUVORK5CYII=', 'base64')
    const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
    const image = 'https://m.qpic.cn/2.png', clip = 'https://photovideo.photo.qq.com/v.mp4', cover = 'https://m.qpic.cn/cover'
    const post = { id: 'p', authorId: '456', author: { nickname: '甲' }, media: [
        { kind: 'image', url: 'https://m.qpic.cn/1.png' }, { kind: 'image', url: image },
        { kind: 'video', url: clip, previewUrl: cover }
    ] }
    const visits = []
    t.mock.method(globalThis, 'fetch', async url => {
        visits.push(url.href)
        return new Response(url.href === clip ? mp4 : png)
    })
    const caps = { image: true, video: true }
    const run = await setup(t, async () => ({ items: [post], nextCursor: null }), {
        ai: { caps: async model => model === 'demo:chat' ? caps : {} },
        agents: { get: () => ({ session: {}, options: { config: { provider: 'demo', model: 'default' } } }) },
        model_selection: { get: () => ({ provider: 'demo', model: 'chat' }) }
    })
    const read = (ref, who = principal, route) => run({ ref }, who, 'qzone_read_media', route)
    const { media } = (await run({ scope: 'friends' })).value.items[0]
    assert.deepEqual(visits, [])
    for (const [ref, label, mime, bytes] of [[media[1].ref, '动态原图', 'image/png', png],
        [media[2].ref, '视频原片', 'video/mp4', mp4], [media[2].coverRef, '视频封面（静态图片）', 'image/png', png]]) {
        const result = await read(ref)
        assert.equal(result.ok, true, JSON.stringify(result.error))
        const [text, file] = result.content
        assert.equal(text.text, label)
        assert.equal(file.mediaType, mime)
        assert.deepEqual(Buffer.from(file.data.data, 'base64'), bytes)
    }
    mp4.write('avif', 8, 'ascii')
    assert.match((await read(media[2].ref)).error.message, /MP4 文件头/)
    caps.video = false
    assert.match((await read(media[2].ref)).error.message, /视频输入能力/)
    assert.match((await read(media[1].ref, principal, 'group:2')).error.message, /编号无效/)
    const other = { ...subject, user: '124' }
    assert.match((await read(media[1].ref, { ...principal, subject: other, wakingPrincipals: [other] })).error.message, /白名单/)
    const allowed = { ...subject, user: '789' }
    assert.match((await read(media[1].ref, { ...principal, subject: allowed, wakingPrincipals: [allowed] })).error.message, /编号无效/)
    const later = Date.now() + 16 * 60_000
    t.mock.method(Date, 'now', () => later)
    assert.match((await read(media[1].ref)).error.message, /已过期/)
    assert.deepEqual(visits, [image, clip, cover, clip])
})

test('文本模型通过 @vision 读取分享封面，链接和封面地址不进入视觉请求', async t => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const post = { id: 's', authorId: '456', author: { nickname: '甲' }, media: [],
        share: { title: '分享', summary: '', url: 'https://example.com/', previewUrl: 'https://m.qpic.cn/cover' } }
    const visits = []
    t.mock.method(globalThis, 'fetch', async url => { visits.push(url.href); return new Response(png) })
    const run = await setup(t, async () => ({ items: [post], nextCursor: null }), {
        ai: { caps: async model => ({ image: model === '@vision' }) },
        chatluna: { async chat(request) {
            assert.equal(request.model, '@vision')
            const [label, file] = request.messages[0].content
            assert.equal(label.text, '分享卡片封面')
            assert.deepEqual(Buffer.from(file.data.data, 'base64'), png)
            assert.doesNotMatch(JSON.stringify(request), /https?:/)
            return { text: '示例描述', finish: { kind: 'stop' } }
        } }
    })
    const page = await run({ scope: 'self' })
    const result = await run({ ref: page.value.items[0].share.coverRef }, principal, 'qzone_read_media')
    assert.deepEqual(result.content, [{ type: 'text', text: '分享卡片封面（@vision）：示例描述' }])
    assert.deepEqual(visits, [post.share.previewUrl])
})
