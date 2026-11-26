import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLite from '@cordisjs/plugin-database-sqlite'
import Koishi from 'koishi'
import { h, Session } from '@satorijs/core'
import Tools from '@chatluna/tool'
import { QzoneClient } from 'qzone-sdk'
import { registerCommands } from '../lib/commands/index.js'
import { QzoneManager } from '../lib/qzone/manager.js'
import { createDeleteCommand } from '../lib/commands/delete.js'
import { registerDeleteTool } from '../lib/qzone/delete-tool.js'

const config = { allowUserIds: ['23'], feedsDefaultLimit: 5 }
const subject = { user: '23', platform: 'onebot', channel: 'group', source: 'chat' }
const routeId = 'onebot:group'

async function entrypoints(t, qzone, inbound) {
    const ctx = new Context()
    t.after(() => ctx.fiber.dispose())
    await ctx.plugin(Database)
    await ctx.plugin(SQLite, { path: ':memory:' })
    await ctx.plugin(Koishi)
    await ctx.plugin(Tools)
    const stopping = new AbortController()
    await ctx.plugin({ inject: ['tools', 'koishi'], apply(scope) {
        registerCommands(scope, config, qzone, {}, stopping.signal)
        registerDeleteTool(scope, config, qzone, stopping.signal)
    } })
    let commandAnswer
    const bot = { ctx, selfId: '10001', platform: 'onebot', toJSON: () => ({}),
        async sendMessage(channel, elements) {
            inbound.previews.push(elements.join(''))
            if (commandAnswer) setImmediate(() => {
                const reply = new Session(bot, { type: 'message', selfId: bot.selfId, platform: bot.platform,
                    user: { id: '23' }, channel: { id: channel, type: 0 }, guild: { id: channel },
                    message: { id: '2', elements: [h.text(commandAnswer)] } })
                ctx.emit(reply, 'message', reply)
            })
            return ['preview']
        }
    }
    return {
        async command(text, userId = '23', answer) {
            commandAnswer = answer
            const session = new Session(bot, { type: 'message', selfId: bot.selfId, platform: bot.platform,
                user: { id: userId }, channel: { id: 'group', type: 0 }, guild: { id: 'group' }, message: { id: '1' } })
            return (await session.execute(text, true)).join('')
        },
        async tool(args, who = subject) {
            const result = await ctx.tools.execute({ name: 'qzone_delete', args,
                principal: { turnId: 'test', routeId, source: 'chat', wakingPrincipals: [who], subject: who } })
            return result.ok ? result.value : result.error.message
        }
    }
}

test('指令与工具使用 SDK 核验作者、真实时间和删除回执，只提交一次', async t => {
    const writes = [], reads = []
    const manager = new QzoneManager({
        acquire: async () => ({ accountId: '10001', cookies: 'p_skey=test; uin=o10001' }),
        logger: { info() {}, warn() {} }, rebind: {},
        createClient: session => new QzoneClient({ session, fetch: async (url, init) => {
            const { pathname, searchParams } = new URL(url)
            if (pathname.endsWith('emotion_cgi_delete_v6')) {
                const form = new URLSearchParams(init.body)
                const id = form.get('feedsKey')
                assert.equal(form.get('feedsTime'), '1700000000')
                assert.equal(form.get('uin'), '10001')
                writes.push(id)
                if (id === 'unknown') throw Error('lost receipt')
                return Response.json({ code: 0 })
            }
            reads.push(pathname)
            if (pathname === '/mqzone/index' || pathname === '/mqzone/profile') {
                return new Response('<script>window.shine0callback=function(){return "ab"};var FrontPage={data:[null,{"data":{"msglist":[]}}]};</script>')
            }
            if (!pathname.endsWith('emotion_cgi_msgdetail_v6')) return Response.json({ code: 0, msglist: [] })
            const id = searchParams.get('tid')
            if (id === 'missing' || (writes.includes(id) && id === 'verified')) return new Response(null, { status: 404 })
            if (writes.includes(id)) return new Response(null, { status: 403 })
            return Response.json({ data: { fid: id, hostuin: id === 'friend' ? '22222' : '10001',
                summary: '配文', ...(id === 'undated' ? {} : { time: 1700000000 }) } })
        } })
    })
    t.after(() => manager.close())
    const api = await entrypoints(t, manager)
    assert.match(await api.command('qzone.delete verified', '24'), /未授权/)
    assert.match(await api.tool({ id: 'verified' }, { ...subject, user: '24' }), /白名单/)
    await api.command('qzone.delete')
    await api.command('qzone.delete --recent 11')
    await api.command('qzone.delete verified --recent 2')
    await api.command('qzone.delete --all')
    for (const input of [{}, { id: '  ' }, { recent: 0 }, { recent: 11 }, { id: 'verified', recent: 2 }]) {
        await api.tool(input)
    }
    assert.deepEqual(reads, [])
    assert.match(await api.command('qzone.delete verified'), /verified：已删除/)
    assert.match(await api.tool({ id: 'accepted' }), /accepted：删除请求已受理/)
    assert.match(await api.tool({ id: 'unknown' }), /unknown：删除结果未知/)
    assert.match(await api.command('qzone.delete undated'), /无法确认动态真实创建时间/)
    assert.match(await api.command('qzone.delete missing'), /未找到该动态/)
    assert.doesNotMatch(await api.tool({ id: 'friend' }), /已删除/)
    assert.deepEqual(writes, ['verified', 'accepted', 'unknown'])
    const before = reads.length
    await assert.rejects(manager.deleteOwnPost({ id: 'old', authorId: '22222' }, new AbortController().signal), /只能删除当前账号/)
    assert.equal(reads.length, before)
    assert.equal(writes.length, 3)
})

const makePost = id => ({ id, authorId: '10001', createdAt: null, content: '', media: [{ kind: 'image' }, { kind: 'image' }] })

function inbound() {
    let next = Promise.withResolvers()
    const previews = []
    return {
        previews, ...subject, platform: 'onebot', userId: '23', selfId: '10001', channelId: 'group', routeId,
        sid: 'onebot:10001', fid: 'onebot:group:23',
        async send(element) { previews.push(element.toString()); return ['message'] },
        prompt(callback) {
            const answer = Promise.withResolvers()
            next.resolve(value => answer.resolve(value === undefined ? undefined : callback(value)))
            return answer.promise
        },
        async reply(content, fields = {}) {
            const answer = await next.promise
            next = Promise.withResolvers()
            answer(content === undefined ? undefined : { ...this, content, ...fields })
        }
    }
}

test('批量删除固定本人确认的清单，只在核验成功后处理下一条', async t => {
    const session = inbound()
    const posts = ['a', 'b', 'c'].map(makePost)
    posts[0].share = { title: '分享标题' }
    const writes = [], queries = []
    const qzone = {
        async listFeedPage(query) {
            queries.push(query.cursor)
            return query.cursor ? { items: [...posts], nextCursor: null } : { items: [posts[0]], nextCursor: 'next' }
        },
        async deleteOwnPost(post) { writes.push(post.id); return { outcome: post.id === 'b' ? 'unknown' : 'verified' } }
    }
    const api = await entrypoints(t, qzone, session)
    // 工具无需入站会话或确认回复；未知结果仍须停止。
    assert.match(await api.tool({ recent: 3 }), /b：删除结果未知[\s\S]*尚未执行：c/)
    assert.deepEqual(session.previews, [])
    assert.deepEqual(writes.splice(0), ['a', 'b'])
    assert.deepEqual(queries.splice(0), [undefined, 'next'])
    const deleteCommand = createDeleteCommand(qzone, new AbortController().signal)
    const command = recent => deleteCommand({ recent }, session)
    const pending = command(3)
    await session.reply('确认删除', { fid: 'onebot:group:24' })
    await session.reply('取消', { fid: 'onebot:other:23' })
    assert.deepEqual(writes, [])
    assert.match(await command(1), /先完成/)
    posts.unshift(makePost('new'))
    await session.reply('确认删除')
    assert.match(await pending, /a：已删除。[\s\S]*b：删除结果未知[\s\S]*尚未执行：c/)
    assert.deepEqual(writes, ['a', 'b'])
    assert.deepEqual(queries, [undefined, 'next'])
    assert.match(session.previews[0], /分享标题.*a[\s\S]*图片 × 2.*b/)
    // 第二次确认没有待执行的请求；下一次 recent:1 仍须获得新的本人回复。
    assert.match(await api.command('qzone.delete --recent 1', '23', '取消'), /取消/)
    assert.match(await api.command('qzone.delete --recent 1', '23', '确认删除'), /new：已删除/)
    assert.deepEqual(writes, ['a', 'b', 'new'])
})

test('指令超时、截止后才处理的确认、插件停止均不删除', async t => {
    let now = Date.now()
    t.mock.method(Date, 'now', () => now)
    const session = inbound()
    const writes = []
    const stopping = new AbortController()
    const deleteCommand = createDeleteCommand({
        async listFeedPage() { return { items: [makePost('x')], nextCursor: null } },
        async deleteOwnPost(post) { writes.push(post.id); return { outcome: 'verified' } }
    }, stopping.signal)
    const command = () => deleteCommand({ recent: 1 }, session)
    const timeout = command()
    await session.reply(undefined)
    assert.match(await timeout, /超时/)
    const late = command()
    await new Promise(resolve => setImmediate(resolve))
    now += 60_001
    await session.reply('确认删除')
    assert.match(await late, /超时/)
    const pending = command()
    await new Promise(resolve => setImmediate(resolve))
    stopping.abort()
    assert.match(await pending, /取消/)
    await session.reply('确认删除')
    assert.deepEqual(writes, [])
})
