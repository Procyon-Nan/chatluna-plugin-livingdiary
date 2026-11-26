import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { Context } from 'cordis'
import * as diary from '../lib/index.js'
import Tools from '@chatluna/tool'
import Permissions from '@chatluna/permission'
import { QzoneClient } from 'qzone-sdk'
import { fileRefTableOf } from '@chatluna/transform'
import { registerPublishTool } from '../lib/publishing/tool.js'
import { publishPost } from '../lib/publishing/publish.js'

test('对话两图两视频的原文件经真实 SDK 组成一条动态，缺项或上传失败不重发', async t => {
    const photo = width => {
        const bytes = Buffer.alloc(24)
        Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes)
        bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(16, 20)
        return bytes
    }
    const clip = marker => Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,marker])
    const originals = { 'a.png': photo(16), 'b.png': photo(32), 'a.mp4': clip(1), 'b.mp4': clip(2) }
    let downloads = 0, scans = 0, reads = 0
    const server = createServer((req, res) => {
        downloads++
        assert.equal(req.url, '/a.mp4')
        res.end(originals['a.mp4'])
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const remote = `http://127.0.0.1:${server.address().port}/a.mp4`
    const blocks = [
        { type: 'file', mediaType: 'image/png', filename: 'a.png', data: { type: 'data', data: originals['a.png'].toString('base64') } },
        { type: 'file', mediaType: 'image/png', filename: 'b.png', data: { type: 'reference', reference: 'storage://b.png' } },
        { type: 'file', mediaType: 'video/mp4', filename: 'a.mp4', data: { type: 'url', url: remote }, preview: { type: 'reference', reference: 'storage://cover' } },
        { type: 'file', mediaType: 'video/mp4', filename: 'b.mp4', data: { type: 'reference', reference: 'storage://b.mp4' } }
    ]
    const messages = [{ role: 'user', content: [{ type: 'envelope', content: blocks.slice(0, 3), quoted: { content: [blocks[3]] } }] }]
    const files = fileRefTableOf(messages)
    const subject = { source: 'chat', platform: 'onebot', user: '23' }
    const call = { principal: {source: 'chat', subject, wakingPrincipals: [subject]},
        agent: {options: {conversationKey: 'current'}, session: {messages() { scans++; return messages }}},
        signal: new AbortController().signal }
    for (const scenario of ['complete', 'formatted-content', 'missing-video', 'upload-failed']) {
        const content = scenario === 'formatted-content'
            ? '  模型配写的正文🌙\n\n 图片和视频  一起发布。 '
            : '模型配写的正文🌙\n\n图片和视频一起发布。'
        const input = {content, images: blocks.slice(0, 2).map(b => files.refOf(b)), videos: blocks.slice(2).map(b => files.refOf(b))}
        const requests = [], uploadedImages = [], uploadedVideos = []
        let submits = 0, tool
        const client = new QzoneClient({session: {cookies: 'uin=o1234; p_skey=test'}, fetch: async (url, init) => {
            const request = new Request(url, init)
            const path = new URL(url).pathname
            requests.push(path)
            if (path.includes('/FileBatchControl/')) return Response.json({data: {session: 'upload', slice_size: 1024}})
            if (path.endsWith('/FileUploadVideo')) {
                const body = await request.formData()
                uploadedVideos.push(Buffer.from(await body.get('data').arrayBuffer()))
                if (scenario === 'upload-failed' && uploadedVideos.length === 2) return Response.json({ret: -5})
                return Response.json({data: {biz: {sVid: `v${uploadedVideos.length}`}}})
            }
            if (path.endsWith('cgi_upload_image')) {
                const form = new URLSearchParams(await request.text())
                const name = form.get('filename')
                uploadedImages.push([name, Buffer.from(form.get('picfile'), 'base64')])
                return Response.json({data: {albumid: 'album', lloc: name, sloc: name, type: 3, height: 16, width: 16}})
            }
            if (path.endsWith('emotion_cgi_publish_v6')) {
                submits++
                const form = new URLSearchParams(await request.text())
                assert.equal(form.get('con'), content)
                assert.equal(form.get('richtype'), '1\n3\n3')
                const [photos, ...videos] = form.get('richval').split('\n')
                assert.deepEqual(photos.split('\t').map(p => p.split(',')[2]), ['a.png', 'b.png'])
                assert.deepEqual(videos.map(v => new URLSearchParams(v).get('vid')), ['v1', 'v2'])
                return Response.json({tid: 'mixed'})
            }
            assert.ok(path.endsWith('emotion_cgi_msgdetail_v6'), path)
            return Response.json({tid: 'mixed', uin: '1234', content, pic: [
                {url3: 'https://m.qpic.cn/a.png'}, {url3: 'https://m.qpic.cn/b.png'},
                ...(scenario === 'missing-video' ? ['v1'] : ['v1', 'v2']).map(vid => ({video_info: {
                    vid, url3: `https://cache.tv.qq.com/qqplayerout.swf?v=${vid}`, url1: 'https://m.qpic.cn/cover.png'
                }}))
            ]})
        }})
        const ctx = { tools: {define(value) {tool = value}}, logger: {warn() {}}, get() { return {async getTempFile(key) {
            reads++
            assert.ok(Object.hasOwn(originals, key), key)
            return {name: key, size: originals[key].length, data: originals[key]}
        }} } }
        registerPublishTool(ctx, {allowUserIds: ['23']}, {publish: request => client.publishPost(request)})
        try {
            const before = [reads, scans, downloads]
            const denied = {...subject, user: '24'}
            await assert.rejects(tool.run(input, {...call, principal: {source: 'chat', subject: denied, wakingPrincipals: [denied]}}), /白名单/)
            assert.deepEqual([reads, scans, downloads], before)
            assert.equal(requests.length, 0)
            const result = await tool.run(input, call)
            assert.equal(result.outcome, {complete: 'verified', 'formatted-content': 'verified', 'missing-video': 'accepted', 'upload-failed': 'failed'}[scenario], JSON.stringify({result, requests}))
            assert.equal(scans, before[1] + 1)
            assert.deepEqual(uploadedVideos, [originals['a.mp4'], originals['b.mp4']])
            assert.equal(submits, scenario === 'upload-failed' ? 0 : 1)
            if (scenario !== 'upload-failed') assert.deepEqual(uploadedImages, [['a.png', originals['a.png']], ['b.png', originals['b.png']]])
            assert.equal(requests.some(p => p.includes('video_get_data')), false)
        } finally { await client.close() }
    }
})

test('视频读取支持内联原文件和纯视频发布，无效附件、超限、取消及错误格式终止发布', async t => {
    const clip = Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0])
    const inline = {type: 'file', mediaType: 'video/mp4', data: {type: 'data', data: clip.toString('base64')}}
    const uri = {...inline, data: {type: 'data', data: 'data:video/mp4;base64,' + clip.toString('base64')}}
    const image = {type: 'file', mediaType: 'image/png', data: {type: 'data', data: 'aW1hZ2U='}}
    const text = {...inline, data: {type: 'text', text: '视频不可用'}}
    const files = fileRefTableOf([{role: 'user', content: [inline, uri, image, text]}])
    const writes = [], reads = []
    const controller = new AbortController()
    const ctx = { logger: {warn() {}}, get() {return {async getTempFile(key) {
        reads.push(key)
        if (key === 'gone') return null
        if (key === 'large') return {name: 'large.mp4', size: 128 * 1024 * 1024 + 1, get data() {assert.fail('must reject before loading')} }
        if (key === 'cancel') controller.abort()
        return {name: 'original.mp4', size: clip.length, data: clip}
    }}} }
    const qzone = {async publish(request) {writes.push(request); return {outcome: 'verified'}}}
    const publish = videos => publishPost(ctx, qzone, {content: '', videos}, controller.signal, files)
    assert.equal((await publish([files.refOf(inline), files.refOf(uri), '/files/original.mp4'])).outcome, 'verified')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].content, '')
    assert.deepEqual(writes[0].videos.map(v => Buffer.from(v.data)), [clip, clip, clip])
    assert.ok(writes[0].videos.every(v => v.name))
    const cases = [[files.refOf(image), /不是视频/], [files.refOf(text), /原文件不可读取/],
        ['i' + '0'.repeat(64), /未找到/], ['storage://gone', /临时视频不可用/], ['storage://large', /大小超过/]]
    for (const [ref, error] of cases) {
        const result = await publish([files.refOf(inline), ref])
        assert.equal(result.outcome, 'failed'); assert.match(result.message, error); assert.match(result.message, /第 2 段视频/)
    }
    assert.equal(writes.length, 1)
    const noSession = await publishPost(ctx, qzone, {content: '', videos: [files.refOf(inline)]})
    assert.match(noSession.message, /当前聊天会话/)
    let bodyCancelled = false
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({cancel() {bodyCancelled = true}}), {headers: {'content-length': String(128 * 1024 * 1024 + 1)}}))
    assert.match((await publish(['https://example.invalid/large.mp4?token=SECRET'])).message, /大小超过/)
    assert.ok(bodyCancelled)
    globalThis.fetch.mock.mockImplementation(async () => new Response(null, {status: 404}))
    const expired = await publish(['https://example.invalid/gone.mp4?token=SECRET'])
    assert.match(expired.message, /视频地址已过期/); assert.doesNotMatch(expired.message, /SECRET/)
    globalThis.fetch.mock.mockImplementation(async () => new Response('not mp4'))
    const client = new QzoneClient({session: {cookies: 'uin=o1234; p_skey=test'}, fetch: assert.fail})
    try {
        const result = await publishPost(ctx, {publish: request => client.publishPost(request)}, {content: '', videos: ['https://example.invalid/not-video']})
        assert.equal(result.outcome, 'failed'); assert.match(result.message, /MP4/)
    } finally {await client.close()}
    await assert.rejects(publish(['storage://cancel']), {name: 'AbortError'})
    const count = reads.length
    await assert.rejects(publish(['storage://original']), {name: 'AbortError'})
    assert.equal(reads.length, count)
    assert.equal(writes.length, 1)
})

test('工具按当前会话 ref 读取原图，引用、多种数据形式和直接地址保持顺序', async t => {
    let downloads = 0, scans = 0
    const server = createServer((_request, response) => { downloads++; response.end('remote') })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const url = `http://127.0.0.1:${server.address().port}/photo.png`
    const stored = { type: 'file', mediaType: 'image/png', filename: 'original.png',
        data: { type: 'reference', reference: 'storage://original' },
        preview: { type: 'reference', reference: 'storage://preview' } }
    const inline = { type: 'file', mediaType: 'image/png', filename: 'inline.png',
        data: { type: 'data', data: Buffer.from('inline').toString('base64') } }
    const uri = { type: 'file', mediaType: 'image/png', filename: 'uri.png',
        data: { type: 'data', data: 'data:image/png;base64,' + Buffer.from('uri').toString('base64') } }
    const remote = { type: 'file', mediaType: 'image/png', filename: 'remote.png', data: { type: 'url', url } }
    const messages = [{ role: 'user', meta: { quote: { content: [inline] } }, content: [
        { type: 'envelope', content: [stored, uri], quoted: { content: [remote] } }
    ] }]
    const table = fileRefTableOf(messages)
    let tool
    const reads = [], writes = []
    const ctx = { tools: { define(value) { tool = value } }, logger: { warn() {} }, get() {
        return { async getTempFile(id) {
            reads.push(id)
            assert.equal(id, 'original')
            return { name: 'stored.png', data: Buffer.from('original') }
        } }
    } }
    registerPublishTool(ctx, { allowUserIds: ['23'] }, { async publish(request) { writes.push(request); return { outcome: 'verified' } } })
    const subject = { source: 'chat', platform: 'onebot', user: '23' }
    const call = { principal: { source: 'chat', subject, wakingPrincipals: [subject] },
        agent: { options: { conversationKey: 'current' }, session: { messages() { scans++; return messages } } },
        signal: new AbortController().signal }
    const images = [stored, inline, uri, remote].map(block => table.refOf(block))
    const result = await tool.run({ content: '配文', images: [...images, 'storage://original'] }, call)
    assert.equal(result.outcome, 'verified')
    assert.equal(scans, 1)
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].images.map(image => [image.name, Buffer.from(image.data).toString()]), [
        ['original.png', 'original'], ['inline.png', 'inline'], ['uri.png', 'uri'], ['remote.png', 'remote'], ['stored.png', 'original']
    ])
    assert.deepEqual(reads, ['original', 'original'])
    assert.equal(downloads, 1)
    const other = { ...subject, user: '24' }
    await assert.rejects(tool.run({ content: '', images }, {
        ...call, principal: { source: 'chat', subject: other, wakingPrincipals: [other] }
    }), /白名单/)
    assert.equal(scans, 1)
    assert.equal(reads.length, 2)
    assert.equal(downloads, 1)
    assert.equal(writes.length, 1)
    const withoutAgent = { ...call, agent: undefined }
    assert.equal((await tool.run({ content: '', images: [url] }, withoutAgent)).outcome, 'verified')
    assert.equal((await tool.run({ content: '', images: [images[0]] }, withoutAgent)).outcome, 'failed')
    assert.equal(downloads, 2)
    assert.equal(writes.length, 2)
    const noHistory = { ...call, agent: { options: call.agent.options, session: { messages: assert.fail } } }
    assert.equal((await tool.run({ content: '', images: ['storage://original'] }, noHistory)).outcome, 'verified')
    assert.equal((await tool.run({ content: '纯文字' }, noHistory)).outcome, 'verified')
    assert.equal(writes.length, 4)
})

test('无效或不可读取的图片编号终止整批发布，读取取消向上传递', async () => {
    const stored = id => ({ type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: `storage://${id}` } })
    const good = stored('good'), missing = stored('missing'), large = stored('large'), cancelled = stored('cancelled')
    const video = { type: 'file', mediaType: 'video/mp4', data: { type: 'url', url: 'https://example.invalid/video.mp4' } }
    const document = { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: 'ZmlsZQ==' } }
    const text = { type: 'file', mediaType: 'image/png', data: { type: 'text', text: '原图不可用' } }
    const table = fileRefTableOf([{ role: 'user', content: [good, missing, large, cancelled, video, document, text] }])
    const controller = new AbortController()
    const reads = []
    const ctx = { logger: { warn() {} }, get() { return { async getTempFile(id) {
        reads.push(id)
        if (id === 'missing') return null
        if (id === 'cancelled') controller.abort()
        return { name: 'image.png', data: Buffer.alloc(id === 'large' ? 32 * 1024 * 1024 + 1 : 1) }
    } } } }
    const qzone = { publish: assert.fail }
    const post = images => publishPost(ctx, qzone, { content: '', images }, controller.signal, table)
    for (const [ref, error] of [
        ['i' + '0'.repeat(64), /未找到/], ['', /完整的图片 ref/], ['i', /完整的图片 ref/],
        [table.refOf(video), /不是图片/], [table.refOf(document), /不是图片/],
        [table.refOf(text), /原文件不可读取/], [table.refOf(missing), /临时图片不可用/],
        [table.refOf(large), /大小超过/]
    ]) {
        const result = await post([table.refOf(good), ref])
        assert.equal(result.outcome, 'failed')
        assert.match(result.message, error)
    }
    await assert.rejects(post([table.refOf(cancelled)]), { name: 'AbortError' })
    const count = reads.length
    await assert.rejects(post([table.refOf(good)]), { name: 'AbortError' })
    assert.equal(reads.length, count)
})

test('长正文原样进入 SDK 发布请求，接口拒绝时返回失败且只提交一次', async t => {
    const content = '  ' + '日记正文🌙'.repeat(40) + '\r\n\r\n  第二段  & + 正文\t\n '
    for (const rejected of [false, true]) {
        const bodies = []
        const client = new QzoneClient({
            session: { accountId: '1234', cookies: 'uin=o1234; p_skey=test' },
            fetch: async (url, init) => {
                const { pathname } = new URL(url)
                if (pathname.endsWith('emotion_cgi_publish_v6')) {
                    assert.equal(init.method, 'POST')
                    bodies.push(new URLSearchParams(init.body).get('con'))
                    if (rejected) return new Response(null, { status: 400 })
                    return Response.json({ code: 0, tid: 'long-post' })
                }
                assert.ok(pathname.endsWith('emotion_cgi_msgdetail_v6'))
                return Response.json({ tid: 'long-post', uin: '1234', content })
            }
        })
        t.after(() => client.close())
        const result = await publishPost({ logger: { warn() {} } }, {
            publish: request => client.publishPost(request)
        }, { content })
        assert.equal(result.outcome, rejected ? 'failed' : 'verified')
        assert.deepEqual(bodies, [content])
        if (rejected) assert.match(result.message, /发布动态失败/)
    }
})

test('工具常驻目录，发帖时按本次请求者授权，并遵守框架的工具权限', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(Permissions, { rules: [] })
    await ctx.plugin(Tools)
    ctx.permissions.asker(question => ({ answer: 'once', by: question.approver.user, actor: question.approver }))
    const writes = []
    const plugin = await ctx.plugin({ inject: ['tools'], apply(scope) {
        registerPublishTool(scope, { allowUserIds: ['Alice'] }, {
            async publish(post) { writes.push(post.content); return { outcome: 'verified' } }
        })
    } })
    const entry = () => ctx.tools.catalog().find(item => item.definition.name === 'qzone_publish')
    const definition = entry().definition
    const run = (speakers, args = {}, actor) => {
        const wakes = speakers.filter(s => s.addressed).map(s => ({ platform: 'onebot', source: 'chat', ...s }))
        const subject = wakes.length === 1 ? wakes[0] : undefined
        return ctx.tools.execute({ name: 'qzone_publish', args: { content: 'Hello', ...args }, actor,
            principal: { turnId: 'turn', routeId: 'onebot:test', source: wakes.length > 1 ? 'mixed' : 'chat', wakingPrincipals: wakes,
                subject, mixed: wakes.length > 1, contextTainted: speakers.length > wakes.length },
            location: { platform: 'onebot' } })
    }
    const alice = { user: 'Alice', addressed: true }, bob = { user: 'Bob', addressed: true }
    const denied = async (...args) => {
        const result = await run(...args)
        assert.equal(result.ok, false)
        if (!['INVALID_SUBJECT', 'PERMISSION_DENIED'].includes(result.error.code)) assert.match(result.error.message, /白名单/)
    }

    await denied([bob])
    await denied([bob, { user: 'Alice' }], { for: 'Alice' })
    await denied([], {}, { platform: 'onebot', user: 'Alice' })
    await denied([{ ...alice, platform: 'discord' }])
    await denied([alice, bob], { for: 'Alice' })
    await denied([alice, { user: 'Bob' }], { for: 'Bob' })
    await denied([alice, { user: 'Bob' }], { for: 'Bob' }, { platform: 'onebot', user: 'Alice' })
    assert.deepEqual(writes, [])
    assert.equal((await run([alice, { user: 'Bob' }])).value.outcome, 'verified')
    const content = '  ' + '完整正文🌙'.repeat(30) + '\n\n  第二段  正文\t\n '
    assert.equal((await run([alice], { for: 'Alice', content })).value.outcome, 'verified')
    ctx.permissions.rule({ id: 'deny-publish', permission: 'tool:qzone_publish', effect: 'deny' })
    assert.equal((await run([alice])).ok, false)
    assert.deepEqual(writes, ['Hello', content])
    assert.equal(entry().definition, definition)
    await plugin.dispose()
    assert.equal(entry(), undefined)
})

test('发布开关独立于白名单：空名单时目录可见但不能发帖，关闭后没有工具', async t => {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    ctx.provide('satori', { bots: [] })
    await ctx.plugin(Tools)
    const entry = () => ctx.tools.catalog().find(tool => tool.definition.name === 'qzone_publish')
    const plugin = await ctx.plugin(diary)
    assert.ok(entry())
    const result = await ctx.tools.execute({ name: 'qzone_publish', args: { content: 'Hello' },
        location: { platform: 'onebot' }, principal: { source: 'chat', subject: { user: 'Alice', platform: 'onebot' }, wakingPrincipals: [{ user: 'Alice', platform: 'onebot', source: 'chat' }] } })
    assert.equal(result.ok, false)
    assert.match(result.error.message, /白名单/)
    await plugin.dispose()
    await ctx.plugin(diary, { enablePublishTool: false, allowUserIds: ['Alice'] })
    assert.equal(entry(), undefined)
})

test('发布命令与工具共用图片读取；整批成功后只提交一次，不重发结果未知的写入', async t => {
    const requests = []
    const qzone = { publish: async request => { requests.push(request); return { outcome: 'unknown' } } }
    const ctx = {
        logger: { warn() {} },
        get: () => ({ getTempFile: async id => id === 'gone' ? null : {
            name: 'local.png', size: 2, data: Promise.resolve(Buffer.from('ab'))
        } })
    }
    const server = createServer((request, response) => {
        if (request.url.includes('missing')) response.writeHead(404).end()
        else response.end('cd')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const url = `http://127.0.0.1:${server.address().port}`
    const post = (content, images) => publishPost(ctx, qzone, { content, images })
    assert.equal((await post(' \n\t ', [])).outcome, 'failed')
    assert.equal((await post('', Array(10).fill('storage://ok'))).outcome, 'failed')
    assert.equal((await post('ok', ['storage://ok', 'storage://gone'])).outcome, 'failed')
    const missing = await post('ok', [url + '/missing?token=SECRET'])
    assert.match(missing.message, /过期/)
    assert.doesNotMatch(missing.message, /SECRET/)
    assert.equal(requests.length, 0)
    const result = await post(' 秋\n 天 ', ['storage://ok', '/files/local.png', url + '/hello%20there.png'])
    assert.deepEqual(requests.map(({ content, images }) => [content, images.map(i => [i.name, Buffer.from(i.data).toString()])]), [
        [' 秋\n 天 ', [['local.png', 'ab'], ['local.png', 'ab'], ['hello there.png', 'cd']]]
    ])
    assert.equal(result.outcome, 'unknown')
    assert.match(result.message, /发布结果未知/)
    assert.equal((await post('', ['storage://ok'])).outcome, 'unknown')
    assert.equal(requests.length, 2)
    assert.equal(requests[1].content, '')
    assert.equal(requests[1].images.length, 1)
})
