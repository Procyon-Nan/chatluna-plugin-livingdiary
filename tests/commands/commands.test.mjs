import assert from 'node:assert/strict'
import test from 'node:test'
import { h } from 'koishi'
import { registerCommands } from '../../lib/commands/index.js'

function commands(service, allowUserIds = ['23'], reports = { digest: null }) {
    const actions = new Map()
    const ctx = {
        command(declaration, _desc, { owner }) {
            assert.equal(owner, 'livingdiary')
            return {
                usage() { return this },
                option() { return this },
                action(fn) { actions.set(declaration.split(' ')[0], fn); return this }
            }
        }
    }
    registerCommands(ctx, { allowUserIds, feedsDefaultLimit: 5 }, service, reports)
    return actions
}
const session = { userId: '23', platform: 'onebot' }

test('私聊和群聊命令都检查平台和 QQ 号，同号其他平台及无人白名单不访问空间', async () => {
    const inaccessible = new Proxy({}, { get() { throw Error('unexpected Qzone access') } })
    for (const [allow, user] of [
        [['23'], { ...session, platform: 'discord' }],
        [['23'], { ...session, userId: '24' }],
        [['23'], undefined],
        [[], session]
    ]) {
        const actions = commands(inaccessible, allow)
        for (const name of ['qzone.publish', 'qzone.status', 'qzone.feeds', 'qzone.delete']) {
            assert.match(await actions.get(name)({ session: user }), /未授权/)
        }
    }
})

test('feeds 默认读自己的空间，可以指定目标 QQ，查询限定十条', async () => {
    const requests = []
    const listFeedPage = async query => {
        requests.push(query)
        return { items: [{ id: 'post-123', createdAt: null, author: { nickname: '用户' }, content: '动态正文', likeCount: 2, commentCount: 1, liked: false }] }
    }
    const feeds = commands({ listFeedPage }).get('qzone.feeds')
    assert.match(await feeds({ session }), /用户：动态正文[\s\S]*动态 ID：post-123/)
    assert.doesNotMatch(await feeds({ session: { ...session, platform: 'milky' }, options: { target: '123' } }, 999), /动态 ID：/)
    assert.deepEqual(requests, [{ scope: 'self', limit: 5 }, { scope: 'profile', userId: '123', limit: 10 }])
})

test('空间昵称和正文中的消息标签只按文字显示', async () => {
    const nickname = '<at type="all"/>'
    const content = 'A & B <img src="https://example.invalid/a"/>'
    const feeds = commands({ listFeedPage: async () => ({ items: [
        { createdAt: null, author: { nickname }, content, likeCount: 0, commentCount: 0 }
    ] }) }).get('qzone.feeds')
    const elements = h.normalize(await feeds({ session }))
    assert.deepEqual(elements.map(e => e.type), ['text'])
    assert.ok(elements[0].attrs.content.includes(nickname + '：' + content))
})

test('分享卡片单独展示标题、摘要和完整链接，空字段省略且消息标签只显示为文本', async () => {
    const url = 'https://example.invalid/watch?id=' + 'x'.repeat(150) + '&from=qzone'
    for (const content of ['', '我的配文']) {
        const feeds = commands({ listFeedPage: async () => ({ items: [{
        id: 'share', createdAt: null, author: { nickname: '好友' }, content, likeCount: 2, commentCount: 1,
            share: { title: '<at type="all"/>', summary: '摘要'.repeat(60), url, previewUrl: 'https://m.qpic.cn/cover' }
        }] }) }).get('qzone.feeds')
        const elements = h.normalize(await feeds({ session }))
        assert.deepEqual(elements.map(e => e.type), ['text'])
        const text = elements[0].attrs.content
        assert.ok(text.includes(`好友：${content}（赞 2・评论 1）`))
        assert.ok(text.includes('分享：<at type="all"/>'))
        assert.ok(text.includes('摘要：' + '摘要'.repeat(50) + '…'))
        assert.ok(text.endsWith('链接：' + url))
        assert.ok(!text.includes('qpic.cn'))
    }
    const feeds = commands({ listFeedPage: async () => ({ items: [{
        id: 'share', createdAt: null, author: { nickname: '好友' }, content: '', likeCount: 0, commentCount: 0,
        share: { title: '', summary: '', url }
    }] }) }).get('qzone.feeds')
    const text = await feeds({ session })
    assert.doesNotMatch(text, /分享：|摘要：|undefined/)
    assert.match(text, /链接：/)
})

test('状态展示最近一次日记的触发方式、时间和处理结果', async () => {
    const reports = { digest: null }
    const service = { status: () => ({ bot: null, client: { initialized: false, rebind: { consecutiveFailures: 0 } } }) }
    const status = commands(service, ['23'], reports).get('qzone.status')
    assert.match(await status({ session }), /每日日记：未运行/)
    reports.digest = { trigger: 'scheduled', triggeredAt: '2026-11-11T03:00:00.000Z', result: 'skipped-empty', detail: '当日无记忆' }
    assert.match(await status({ session }), /每日日记：.*2026.*（定时）：跳过（当日无记忆）/)
})

test('手动发布读取顶层文本、图片和视频，表情及引用中的素材不会发布', async () => {
    const content = '  ' + '日记正文🌙'.repeat(30) + '\n\n  第二段  正文\t\n '
    const actions = new Map()
    const bodies = []
    const lookups = []
    const ctx = {
        command(decl) { return {
            usage() { return this }, option() { return this },
            action(fn) { actions.set(decl.split(' ')[0], fn); return this }
        } },
        get(key) {
            assert.equal(key, 'chatluna_storage')
            return { async getTempFile(id) { lookups.push(id); return { name: id === 'a' ? 'a.png' : 'b.mp4', size: 1, data: Buffer.from([7]) } } }
        }
    }
    registerCommands(ctx, { allowUserIds: ['23'] }, { async publish(req) { bodies.push(req); return { outcome: 'verified' } } }, { digest: null })
    const response = await actions.get('qzone.publish')({ session }, [
        h.text(content.slice(0, 80)), h.text(content.slice(80)), h('face', {}, h.image('https://example.invalid/face.png')),
        h('quote', {}, h.text('引用正文'), h.image('https://example.invalid/quoted.png'), h('video', {src: 'https://example.invalid/quoted.mp4'})),
        h.image('storage://a'), h('video', {src: 'storage://b', poster: 'https://example.invalid/cover.png'})
    ])
    assert.match(response, /发布成功/)
    assert.deepEqual(lookups, ['a', 'b'])
    assert.deepEqual(bodies, [{ content, images: [{ name: 'a.png', data: Buffer.from([7]) }], videos: [{ name: 'b.mp4', data: Buffer.from([7]) }] }])
})
