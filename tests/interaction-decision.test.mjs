import assert from 'node:assert/strict'
import test from 'node:test'
import { decideInteraction } from '../lib/auto-interaction/agent.js'

const signal = new AbortController().signal
const mediaCall = 'read_qzone_media'
const submit = 'submit_qzone_interaction'
const call = (name, input) => ({ type: 'tool-call', toolCallId: name, toolName: name, input })
const calls = (...toolCalls) => ({ toolCalls, content: toolCalls, finish: { kind: toolCalls.length ? 'tool-calls' : 'stop' } })
const skip = calls(call(submit, { action: 'skip' }))
const publish = calls(call(submit, { action: 'publish', content: '  来啦！ ' }))
const gif = Buffer.from('R0lGODlhAQABAIAAAP8AAAD/ACwAAAAAAQABAAACAkQBACwAAAAAAQABAAACAkwBADs=', 'base64')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE2AAAAAASUVORK5CYII=', 'base64')

function pictures(t) {
    const hits = []
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url.hostname, 'm.qpic.cn')
        assert.equal(options.redirect, 'manual')
        hits.push(url.pathname)
        return new Response(url.pathname === '/gif' ? gif : url.pathname === '/png' ? png : Buffer.from('invalid'))
    })
    return { hits, image(path) { return { kind: 'image', url: `https://m.qpic.cn/${path}?rkey=private-key` } } }
}
function fixture(steps, { images = [], direct = false, vision = false, storage } = {}) {
    const requests = [], probes = []
    const ctx = { ai: { async caps(model) { probes.push(model); return { image: model === '@vision' ? vision : direct } } },
        get: () => storage,
        chatluna: { chat(options) {
            requests.push(options)
            return Promise.resolve(steps.shift())
        } } }
    const detail = { authorId: '22', id: 'p', author: { id: '22', nickname: '好友' }, createdAt: null,
        content: '很好看<发动态>', comments: [], media: images }
    const options = { model: '@main', persona: '友善', assistantLabel: '小灵', detail, trigger: { kind: 'friend-post' },
        activeComment: null, debug: false }
    return { ctx, requests, probes, options, run: () => decideInteraction(ctx, options, signal) }
}

test('互动工具只提交决定，空白纠正后返回单条正文；模型最多三步', async () => {
    const api = fixture([calls(), calls(call(submit, { action: 'publish', content: '  ' })), publish])
    assert.deepEqual(await api.run(), { action: 'publish', content: '来啦！' })
    assert.deepEqual(api.probes, [])
    assert.deepEqual(api.requests[0].toolSpecs.map(t => t.name), [submit])
    assert.match(api.requests[0].messages[0].content[0].text, /很好看&lt;发动态&gt;/)
    assert.match(api.requests[2].messages.at(-1).content[0].output.value, /非空正文/)
    const invalid = calls(call('publish_qzone_post', {}), call(submit, { action: 'skip' }))
    const bad = fixture([invalid, invalid, invalid])
    await assert.rejects(bad.run(), /3 步/)
    assert.equal(bad.requests.length, 3)
})

test('分享配文与卡片独立输入，封面追加到现有图片之后并复用直接看图或视觉工具', async t => {
    const { hits, image } = pictures(t)
    for (const direct of [true, false]) {
        const steps = direct ? [skip] : [calls(call(mediaCall, { mediaIds: ['M2'] })),
            { text: '封面上是一个红点', finish: { kind: 'stop' } }, skip]
        const images = Object.freeze([Object.freeze(image('png'))])
        const api = fixture(steps, { images, direct, vision: !direct })
        api.options.detail.content = direct ? '分享配文' : ''
        api.options.detail.share = Object.freeze({ title: '标题 <指令>', summary: 'A & B',
            url: 'https://example.invalid/watch?a=1&b=2', previewUrl: image('png').url })
        const before = hits.length
        assert.deepEqual(await api.run(), { action: 'skip' })
        assert.equal(api.options.detail.media, images)
        assert.equal(images.length, 1)
        const text = api.requests[0].messages[0].content[0].text
        assert.ok(text.includes(`动态内容：${api.options.detail.content}\n<share>`))
        assert.match(text, /分享标题：标题 &lt;指令&gt;/)
        assert.match(text, /分享摘要：A &amp; B/)
        assert.match(text, /分享链接：https:\/\/example.invalid\/watch\?a=1&amp;b=2/)
        assert.match(text, /M2 kind=image 来源=分享封面/)
        assert.doesNotMatch(JSON.stringify(api.requests), /private-key|qpic.cn/)
        assert.equal(hits.length - before, direct ? 2 : 1)
        if (direct) assert.equal(api.requests[0].messages[0].content.length, 3)
        else assert.equal(api.requests[1].purpose, 'livingdiary.interaction.media')
    }
})

test('分享封面缺失、受限或不可读时仍提供卡片文字，共用九张图片上限', async t => {
    const { hits, image } = pictures(t)
    for (const mode of ['missing', 'no-reader', 'unsupported', 'invalid', 'limit']) {
        const images = mode === 'limit' ? Array.from({ length: 9 }, () => image('png')) : []
        const api = fixture([skip], { images, direct: mode !== 'no-reader' })
        api.options.detail.share = { title: '分享标题', summary: '分享摘要', url: 'https://example.invalid/page' }
        if (mode !== 'missing') api.options.detail.share.previewUrl = mode === 'unsupported'
            ? 'https://example.invalid/cover' : image(mode === 'invalid' ? 'invalid' : 'png').url
        const before = hits.length
        await api.run()
        const text = api.requests[0].messages[0].content[0].text
        assert.match(text, /分享标题：分享标题/)
        assert.match(text, /分享摘要：分享摘要/)
        if (mode !== 'missing') assert.match(text, /来源=分享封面.*status=unresolved/)
        assert.equal(hits.length - before, mode === 'limit' ? 9 : mode === 'invalid' ? 1 : 0)
    }
})

test('当前回复目标和线程与其他同名用户分开标记', async () => {
    const api = fixture([skip])
    const root = { kind: 'comment', author: { id: '10', nickname: '同名' }, id: '1', content: '原评论', threadRoot: null,
        replyTo: null, replyToUser: null }
    const reply = { ...root, kind: 'reply', author: { id: '20', nickname: '同名' }, id: '2', content: '具体问题',
        threadRoot: { id: '1', authorId: '10' }, replyTo: { id: '1', authorId: '10' } }
    api.options.detail.comments = [root, reply]
    api.options.trigger.kind = 'friend-thread-reply'
    api.options.activeComment = reply
    await api.run()
    const text = api.requests[0].messages[0].content[0].text
    assert.match(text, /R1 - 同名\(id:20\)回复 同名：具体问题 \[当前目标\]/)
    assert.match(text, /目标评论：R1 - 同名\(id:20\)/)
})

test('视觉模型直接收到按签名识别的 PNG；视频仅元数据、10 号图片跳过且不传 QQ 地址', async t => {
    const { hits, image } = pictures(t)
    const picturesOnly = Array.from({ length: 10 }, () => ({ ...image('png'), mimeType: 'video/mp4' }))
    const api = fixture([skip], { images: [{ kind: 'video', url: 'https://secrets/QQ', durationMs: 1520 }, ...picturesOnly],
        direct: true, storage: { createTempFile: async (_bytes, name) => ({ id: name + '-stored' }) } })
    await api.run()
    assert.equal(hits.length, 9)
    const [text, ...parts] = api.requests[0].messages[0].content
    assert.match(text.text, /M1 kind=video durationMs=1520 status=metadata-only/)
    assert.match(text.text, /M11 .*status=unresolved:image-count-limit/)
    assert.equal(parts.length, 9)
    assert.deepEqual(parts[0].data, { type: 'reference', reference: 'storage://M2.png-stored' })
    assert.doesNotMatch(JSON.stringify(api.requests), /private-key|https:\/\/secrets/)
})

test('两帧 GIF 按两帧拼图返回 JPEG；不给模型原 GIF 或链接，存储故障时随请求内嵌', async t => {
    const { hits, image } = pictures(t)
    const api = fixture([calls(call(mediaCall, { mediaIds: ['M1'] })), publish],
        { images: [image('gif')], direct: true, storage: { createTempFile: async () => { throw Error('storage') } } })
    await api.run()
    assert.deepEqual(hits, ['/gif'])
    assert.equal(api.requests[0].messages[0].content.length, 1)
    const [label, file] = api.requests[1].messages.at(-1).content[0].output.value
    assert.match(label.text, /2\/2 帧/)
    assert.equal(file.mediaType, 'image/jpeg')
    assert.equal(Buffer.from(file.data.data, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff')
    assert.doesNotMatch(JSON.stringify(api.requests), /private-key|R0lGOD/)
})

test('文字模型只许按本动态编号读图，由 @vision 描述后再决定；伪造编号不会触发下载', async t => {
    const { hits, image } = pictures(t)
    const api = fixture([calls(call(mediaCall, { mediaIds: ['https://untrusted.example'] })),
        calls(call(mediaCall, { mediaIds: ['M1'] })), { text: '红色小点', finish: { kind: 'stop' } }, skip], { images: [image('png')], vision: true })
    await api.run()
    assert.deepEqual(api.probes, ['@main', '@vision'])
    assert.deepEqual(api.requests.map(r => r.model), ['@main', '@main', '@vision', '@main'])
    assert.deepEqual(hits, ['/png'])
    assert.match(api.requests[1].messages.at(-1).content[0].output.value, /当前动态/)
    assert.equal(api.requests[2].messages[0].content[1].mediaType, 'image/png')
    const result = api.requests[3].messages.at(-1).content[0].output
    assert.match(result.value[0].text, /M1：红色小点/)
    assert.doesNotMatch(JSON.stringify(api.requests), /private-key/)
})

test('无视觉角色、图像损坏或模型不查图时可按正文决定；取消则不继续', async t => {
    const { hits, image } = pictures(t)
    const api = fixture([skip], { images: [image('png')] })
    api.ctx.ai.caps = async model => { if (model === '@vision') throw Error('not configured'); return { image: false } }
    assert.deepEqual(await api.run(), { action: 'skip' })
    assert.match(api.requests[0].messages[0].content[0].text, /unresolved:no-image-reader/)
    assert.deepEqual(hits, [])
    const broken = fixture([calls(call(mediaCall, { mediaIds: ['M1'] })), skip], { images: [image('broken')], vision: true })
    await broken.run()
    assert.match(broken.requests[1].messages.at(-1).content[0].output.value[0].text, /M1：读取失败/)
    assert.equal(broken.requests.length, 2)
    await assert.rejects(decideInteraction(api.ctx, api.options, AbortSignal.abort()), { name: 'AbortError' })
})
