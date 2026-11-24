import assert from 'node:assert/strict'
import test from 'node:test'
import { runDailyDigest } from '../lib/daily-digest/workflow.js'
import { decideDigest } from '../lib/daily-digest/model.js'
import { createQzoneService } from '../lib/qzone/service.js'

const start = new Date(2026, 10, 11, 12)
const midnight = new Date(2026, 10, 11)
const settings = { presetId: 'p', model: '@large', memoryLimit: 100, publishDiaryToQzone: true }
const text = '第一段。\n\n' + '写得长一点。'.repeat(30)
const call = input => ({ type: 'tool-call', toolCallId: 'result', toolName: 'publish_daily_digest', input })
const result = input => ({ finish: { kind: 'tool-calls' }, toolCalls: [call(input)], content: [call(input)] })
const quiet = { info() {}, warn() {}, error() {} }

function fixture() {
    const preset = { id: 'p', name: '人设 A', status: 'ok' }
    const calls = [], writes = [], reads = []
    const rows = Array.from({ length: 120 }, (_, i) => ({
        id: `m${i}`, status: 'active', createdAt: new Date(+midnight + i * 60000), type: 'plan', content: `记忆[${i}]`, sentiment: '愉快'
    })).reverse()
    const memory = {
        repository: { listEntriesByPreset(id) { reads.push(['memories', id]); return rows } },
        presetPersona: { readCard(id) { reads.push(['card', id]); return '用星星打招呼。' } }
    }
    const ctx = { logger: quiet,
        presets: { get: id => id === preset.id ? preset : undefined },
        get: () => memory,
        chatluna: { chat(input) { calls.push(input); return Promise.resolve(result({ action: 'publish', content: text })) } }
    }
    const qzone = { async publishDiary(input) { writes.push(input); return true } }
    const saved = [], outcomes = []
    const journal = {
        async save(entry, at) { saved.push({ entry, at }); return String(saved.length) },
        async beginPublication() {},
        async finishPublication(id, verified) { outcomes.push({ id, status: verified ? 'published' : 'failed' }) }
    }
    const run = (overrides = {}, signal = new AbortController().signal) => runDailyDigest(ctx, qzone, journal,
        { ...settings, ...overrides }, 'manual', signal, start)
    return { ctx, qzone, journal, saved, outcomes, rows, memory, reads, calls, writes, run }
}

test('写作使用同一预设的人设卡片和最近 100 条当日记忆，整篇只发布一次', async () => {
    const api = fixture()
    const base = { ...api.rows[0], content: '排除项', updatedAt: start }
    api.rows.unshift({ ...base, status: 'archived' }, { ...base, createdAt: new Date(+midnight - 1) },
        { ...base, createdAt: new Date(+start + 1) })
    const { result: outcome } = await api.run()
    assert.equal(outcome, 'published')
    assert.deepEqual(api.reads, [['memories', 'p'], ['card', 'p']])
    assert.equal(api.calls.length, 1)
    const request = api.calls[0]
    assert.equal(request.model, '@large')
    assert.ok(request.system.includes('<preset_context>\n用星星打招呼。\n</preset_context>'))
    assert.deepEqual(request.toolSpecs.map(x => x.name), ['publish_daily_digest'])
    const prompt = request.messages[0].content[0].text
    assert.doesNotMatch(prompt, /排除项/)
    assert.deepEqual([...prompt.matchAll(/记忆\[(\d+)\]/g)].map(m => +m[1]), Array.from({ length: 100 }, (_, i) => i + 20))
    assert.match(prompt, /计划\|情绪:愉快/)
    assert.equal(api.writes.length, 1)
    assert.equal(api.writes[0].content, text)
    assert.deepEqual(api.saved, [{ at: start, entry: { presetId: 'p', presetName: '人设 A', content: text,
        memories: Array.from({ length: 100 }, (_, i) => ({ id: `m${i + 20}`, content: `记忆[${i + 20}]` })) } }])
    assert.deepEqual(api.outcomes, [{ id: '1', status: 'published' }])
})

test('无预设、读取失败或人设为空时不调用模型或发布', async () => {
    const api = fixture()
    assert.equal((await api.run({ presetId: 'missing' })).result, 'preset-missing')
    assert.deepEqual(api.reads, [])
    api.memory.presetPersona.readCard = () => ''
    assert.equal((await api.run()).result, 'preset-missing')
    api.memory.presetPersona.readCard = () => { throw Error('card offline') }
    assert.equal((await api.run()).result, 'failed')
    api.memory.repository.listEntriesByPreset = () => { throw Error('read failed') }
    assert.equal((await api.run()).result, 'failed')
    assert.deepEqual(api.calls, [])
    assert.deepEqual(api.writes, [])
})

test('当日窗口包含本地零点和任务开始时刻，不包含前一天或任务开始之后', async () => {
    const api = fixture()
    api.rows.length = 0
    for (const [label, time] of [['昨夜', +midnight - 1], ['本地零点', +midnight], ['开始时刻', +start], ['未来', +start + 1]]) {
        api.rows.push({ id: label, type: 'plan', status: 'active', createdAt: new Date(time), content: label })
    }
    await api.run()
    const body = api.calls[0].messages[0].content[0].text
    assert.match(body, /本地零点[\s\S]*开始时刻/)
    assert.doesNotMatch(body, /昨夜|未来/)
})

test('当天仅整理或编辑了旧记忆时，日记跳过，不调用模型也不发帖', async () => {
    const api = fixture()
    api.rows.length = 0
    api.rows.push({
        type: 'fact', status: 'active', content: '今天修订的旧事',
        createdAt: new Date(+midnight - 1), updatedAt: start
    })
    assert.equal((await api.run()).result, 'skipped-empty')
    assert.deepEqual(api.reads, [['memories', 'p']])
    assert.equal(api.calls.length, 0)
    assert.equal(api.writes.length, 0)
})

test('关闭空间发布时，写好的正文和参考记忆仍存入日记册', async () => {
    const api = fixture()
    api.rows.splice(1)
    api.journal.beginPublication = assert.fail
    const { result } = await api.run({ publishDiaryToQzone: false })
    assert.equal(result, 'saved')
    const { id, content } = api.rows[0]
    assert.deepEqual(api.saved, [{ at: start, entry: { presetId: 'p', presetName: '人设 A', content: text, memories: [{ id, content }] } }])
    assert.deepEqual(api.writes, [])
    assert.deepEqual(api.outcomes, [])
})

test('日记用机器人当前的票据发帖，发布报告保留鉴权错误码', async t => {
    for (const scenario of ['已有客户端', 'HTTP 401', '业务码 -3000', '机器人离线']) {
        await t.test(scenario, async t => {
            const api = fixture()
            const posts = [], grants = []
            let ticket = 'cached'
            const bot = { platform: 'onebot', selfId: '5678', status: 1, internal: {
                async getCookies() { grants.push(ticket); return `uin=o5678; p_skey=${ticket}` }
            } }
            const service = createQzoneService({ satori: { bots: [bot] }, logger: quiet }, { platform: 'onebot' })
            t.after(() => service.close())
            api.qzone.publishDiary = input => service.publishDiary(input)
            t.mock.method(globalThis, 'fetch', async (url, init) => {
                const path = new URL(url).pathname
                if (path.endsWith('emotion_cgi_msgdetail_v6')) {
                    return Response.json({ tid: 'diary-id', uin: bot.selfId, content: text })
                }
                assert.ok(path.endsWith('emotion_cgi_publish_v6'))
                assert.equal(init.method, 'POST')
                posts.push(new Headers(init.headers).get('cookie'))
                if (scenario === 'HTTP 401') return new Response(null, { status: 401 })
                if (scenario === '业务码 -3000') return Response.json({ code: -3000, msg: 'p_skey=secret' })
                return Response.json({ code: 0, tid: 'diary-id' })
            })
            if (scenario === '已有客户端') {
                await service.getPost({ post: { id: 'diary-id', authorId: bot.selfId } })
            }
            ticket = 'current'
            if (scenario === '机器人离线') bot.status = 0
            const report = await api.run()
            assert.equal(api.saved[0].entry.content, text)
            assert.deepEqual(api.outcomes, [{ id: '1', status: scenario === '已有客户端' ? 'published' : 'failed' }])
            const online = bot.status === 1
            const expected = scenario === '已有客户端' ? ['cached', 'current'] : ['current']
            assert.deepEqual(grants, online ? expected : [])
            assert.equal(posts.length, online ? 1 : 0)
            if (online) assert.match(posts[0], /\bp_skey=current(?:;|$)/)
            if (online && scenario !== '已有客户端') {
                assert.ok(report.detail.includes(scenario))
                assert.doesNotMatch(report.detail, /已续绑|p_skey|secret/)
            }
        })
    }
})

test('模型跳过则不存不发；未验证和空间写入异常都记为发布失败，不重发', async () => {
    const api = fixture()
    api.ctx.chatluna.chat = () => Promise.resolve(result({ action: 'skip' }))
    assert.equal((await api.run()).result, 'skipped-by-model')
    assert.deepEqual(api.saved, [])
    assert.deepEqual(api.writes, [])
    api.ctx.chatluna.chat = () => Promise.resolve(result({ action: 'publish', content: text }))
    let writes = 0
    for (const throws of [false, true]) {
        api.qzone.publishDiary = async () => { writes++; if (throws) throw Error('write error'); return false }
        assert.equal((await api.run()).result, 'publish-failed')
    }
    assert.equal(writes, 2)
    assert.deepEqual(api.outcomes.map(row => row.status), ['failed', 'failed'])
})

test('先存日记再发空间；归档失败不发送，回写失败保留已知的发布结果', async () => {
    const api = fixture()
    const save = api.journal.save
    api.journal.save = async () => { throw Error('database offline') }
    assert.equal((await api.run()).result, 'failed')
    assert.deepEqual(api.writes, [])
    api.journal.save = save
    api.journal.beginPublication = async () => { throw Error('database offline') }
    assert.equal((await api.run()).result, 'failed')
    assert.deepEqual(api.writes, [])
    api.journal.beginPublication = async () => {}
    api.journal.finishPublication = async () => { throw Error('database offline') }
    const report = await api.run()
    assert.equal(report.result, 'published')
    assert.match(report.detail, /更新本地发布状态失败/)
})

test('格式错误带工具反馈纠正；模型异常共用七次预算，两次之间等五秒', async () => {
    const options = { systemPrompt: 'task', inputPrompt: 'data' }
    const signal = new AbortController().signal
    const requests = [], delays = []
    const ask = (fn) => decideDigest({ chatluna: { chat(data) { requests.push(data); return Promise.resolve().then(fn) } } },
        '@large', options, signal, false, async ms => { delays.push(ms) })
    await assert.rejects(ask(() => { if (requests.length % 2) return result({ action: 'publish' }); throw Error('network') }), /7 次.*content/)
    assert.equal(requests.length, 7)
    assert.deepEqual(delays, Array(6).fill(5000))
    assert.deepEqual(requests[1].messages.map(m => m.role), ['user', 'assistant', 'tool'])
    assert.match(requests[1].messages[2].content[0].output.value, /content/)
    assert.deepEqual(await ask(() => result({ action: 'skip' })), { action: 'skip' })
    await assert.rejects(ask(() => { throw Object.assign(Error('SECRET'), { code: 'NO_MODEL' }) }), error =>
        error.message.includes('NO_MODEL') && !error.message.includes('SECRET'))
})

test('停用会中止在途模型与等待登录的发布；已提交的写结果仍保留', async () => {
    const api = fixture()
    const first = new AbortController()
    let began
    const called = new Promise(resolve => { began = resolve })
    api.ctx.chatluna.chat = () => {
        let stop
        const p = new Promise((_, reject) => { stop = reject })
        began()
        return Object.assign(p, { abort() { stop(new Error('aborted')) } })
    }
    const pending = api.run({}, first.signal)
    await called
    first.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.deepEqual(api.writes, [])
    const second = new AbortController()
    api.ctx.chatluna.chat = () => Promise.resolve(result({ action: 'publish', content: text }))
    api.qzone.publishDiary = async ({ signal }) => {
        assert.equal(signal, second.signal)
        second.abort()
        signal.throwIfAborted()
    }
    await assert.rejects(api.run({}, second.signal), { name: 'AbortError' })
    assert.deepEqual(api.outcomes, [{ id: '1', status: 'failed' }])
    const third = new AbortController()
    api.qzone.publishDiary = async () => { third.abort(); return true }
    assert.equal((await api.run({}, third.signal)).result, 'published')
})
