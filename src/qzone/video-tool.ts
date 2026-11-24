import type { Context } from 'cordis'
import type {} from '@chatluna/chat'
import type {} from '@chatluna/tool'
import { QzoneNotFoundError, type PostReference, type QzonePost } from 'qzone-sdk'
import Schema from 'schemastery'
import { requireRequester } from '../access.js'
import type { Config } from '../config.js'
import type { QzoneService } from './service.js'

const limit = 20
type VideoInput = { author: string; postId?: string }
type VideoReader = Pick<QzoneService, 'listFeedPage' | 'getPost'>

function matchingAuthors(posts: readonly QzonePost[], name: string) {
    const exact = new Map<string, string>()
    const prefix = new Map<string, string>()
    for (const post of posts) {
        const nickname = post.author.nickname.trim().toLowerCase()
        if (nickname === name) exact.set(post.authorId, post.author.nickname)
        else if (nickname.startsWith(name)) prefix.set(post.authorId, post.author.nickname)
    }
    return exact.size ? exact : prefix
}

async function findVideo(qzone: VideoReader, input: VideoInput, signal: AbortSignal) {
    const author = input.author.trim()
    if (!author) throw new Error('请指定作者昵称或 QQ 号。')
    const numeric = /^\d+$/.test(author)
    const id = input.postId?.trim()
    if (id === '') throw new Error('动态 ID 不能为空。')
    if (numeric && id) return readVideo(qzone, { authorId: author, id }, signal)

    const query = numeric ? { scope: 'profile' as const, userId: author } : { scope: 'friends' as const }
    const { items } = await qzone.listFeedPage({ ...query, limit, signal })
    let authorId = author
    if (!numeric) {
        const candidates = [...matchingAuthors(items, author.toLowerCase())].map(([id, nickname]) => ({ id, nickname }))
        const [match] = candidates
        if (!match) return { message: '最近 20 条好友动态中未找到该作者，请提供 QQ 号。' }
        if (candidates.length > 1) return { message: '有多位匹配作者，请指定 QQ 号。', candidates }
        authorId = match.id
    }
    if (id) return readVideo(qzone, { authorId, id }, signal)
    const [latest] = items.filter(post => post.authorId === authorId && post.media.some(media => media.kind === 'video'))
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    if (latest) return readVideo(qzone, latest, signal)
    return { message: numeric ? '该主页最近 20 条动态中未找到视频。' : '最近 20 条好友动态中未找到该作者的视频。' }
}

async function readVideo(qzone: VideoReader, target: PostReference, signal: AbortSignal) {
    let post: QzonePost
    try {
        post = await qzone.getPost({ post: target, signal })
    } catch (error) {
        if (error instanceof QzoneNotFoundError) return { message: '未找到指定作者的这条动态。' }
        throw error
    }
    const videos = post.media.filter(media => media.kind === 'video').map(media => media.url)
    if (!videos.length) return { message: '指定动态没有可转发的视频。' }
    return { author: post.author.nickname, authorId: post.authorId, postId: post.id, createdAt: post.createdAt, videos }
}

export function registerVideoTool(ctx: Context, config: Pick<Config, 'allowUserIds'>, qzone: VideoReader) {
    ctx.tools.define<VideoInput>({
        name: 'qzone_get_video',
        description: 'Find a Qzone video requested by the current user. For matching candidates ask which QQ ID they mean. ' +
            'To forward a result use reply with a <video src="…"/> in the current chat, once per requested video. Never paste the URL as text.',
        locales: { zh: { description: '查找指定作者的空间视频，由机器人回复到当前会话。' } },
        args: Schema.object({
            author: Schema.string().required().description('QQ account number or nickname of the author.'),
            postId: Schema.string().description('Exact post ID, if the user selected a specific post.')
        }),
        traits: { effect: 'read', background: false },
        async run(input, call) {
            requireRequester(call, config.allowUserIds)
            if (!call.routeId || !call.agent) throw new Error('视频转发需要当前聊天会话。')
            const channels = ctx.chat.channels.ofRoute(call.routeId)
            const session = [...channels].find(channel => channel.live?.agent === call.agent)?.inbound
            if (!session || session.routeId !== call.routeId) throw new Error('无法确定当前视频回复会话。')
            const rich = Object.hasOwn(session.rules.values, 'chat.rich') ? session.rules.get('chat.rich') : undefined
            const video = ctx.chat.expressions({ q: 'video' }).find(entry => entry.name === 'video')
            if (!video?.enabled || !(rich ? rich.video : video.default)) {
                throw new Error('当前会话未开启视频发送。')
            }
            return findVideo(qzone, input, call.signal)
        }
    })
}
