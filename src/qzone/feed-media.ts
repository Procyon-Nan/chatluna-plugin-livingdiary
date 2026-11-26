import { randomBytes } from 'node:crypto'
import type { Context } from 'cordis'
import type {} from '@chatluna/agent'
import type {} from '@chatluna/ai-runtime'
import type { ChatBlock } from '@chatluna/ai'
import type { ToolCallContext } from '@chatluna/tool'
import Schema from 'schemastery'
import { requireRequester } from '../access.js'
import { MediaReadError } from '../media.js'
import { callModel } from '../model.js'
import { asFile, downloadImage, downloadVideo } from './media-file.js'

type Kind = 'image' | 'video' | 'video-cover' | 'share-cover'
interface Source { kind: Kind; url: string; owner: string; expires: number }
export type MediaRef = (url: string, kind: Kind) => string | undefined
const labels = { image: '动态原图', video: '视频原片', 'video-cover': '视频封面（静态图片）', 'share-cover': '分享卡片封面' }

function owner(call: ToolCallContext) {
    const subject = call.principal?.subject
    const route = call.principal?.routeId ?? subject?.route
    if (subject && route) return JSON.stringify([subject.platform, subject.user, route])
}

async function readContent(ctx: Context, ref: string, source: Source, call: ToolCallContext): Promise<ChatBlock[]> {
    const { kind } = source
    const modality = kind === 'video' ? 'video' : 'image'
    const ai = ctx.get('ai')
    const agent = call.agentId ? ctx.get('agents')?.get(call.agentId) : undefined
    const config = agent && (agent.session.prompt?.config ?? ctx.get('model_selection')?.get(agent) ?? agent.options.config)
    const supports = async (model: string) => {
        try { return (await ai?.caps<'chat'>(model, call.signal))?.[modality] === true }
        catch { call.signal.throwIfAborted(); return false }
    }
    const direct = config && await supports(`${config.provider}:${config.model}`)
    if (!direct && !(await supports('@vision'))) {
        throw new MediaReadError(modality === 'video'
            ? '当前模型和 @vision 均未提供视频输入能力。若有 coverRef，可单独查看静态封面。'
            : '请使用支持图片的对话模型，或配置支持图片的 @vision。')
    }
    const url = URL.parse(source.url)
    if (!url) throw new MediaReadError('空间媒体地址无效，请重新查询。')
    const { bytes, mime } = modality === 'video' ? await downloadVideo(url, call.signal) : await downloadImage(url, call.signal)
    const file = await asFile(ctx, ref, bytes, mime, call.signal)
    const label = labels[kind]
    const content: ChatBlock[] = [{ type: 'text', text: label }, file]
    if (direct) return content
    const result = await callModel(ctx, { model: '@vision', purpose: 'livingdiary.feed.media', cache: false,
        system: '只描述所给文件中可见的内容及文字。静态封面只描述此帧，视频可描述画面随时间的变化。',
        messages: [{ role: 'user', content }] }, call.signal)
    if (!result.text.trim()) throw new MediaReadError('视觉模型没有返回描述。')
    return [{ type: 'text', text: `${label}（@vision）：${result.text.trim()}` }]
}

/** 编号绑定列表当时的文件地址，避免详情刷新后同一序号指向不同素材。 */
export function registerFeedMedia(ctx: Context, allowUserIds: readonly string[]) {
    const sources = new Map<string, Source>()
    ctx.tools.define({
        name: 'qzone_read_media',
        description: 'Inspect one media ref returned by qzone_list_feeds for this requester. Use ref for the original image or MP4, coverRef for a still cover. Never infer video events from a cover.',
        locales: { zh: { description: '按动态列表中的编号查看原图、MP4 原片或静态封面。' } },
        args: Schema.object({ ref: Schema.string().required().description('Exact ref or coverRef from the listed post.') }),
        traits: { effect: 'read', background: false },
        async run({ ref }, call) {
            requireRequester(call, allowUserIds)
            const source = sources.get(ref)
            if (!source || source.owner !== owner(call) || source.expires <= Date.now()) {
                throw new Error('媒体编号无效或已过期，请在当前会话重新查看动态。')
            }
            return readContent(ctx, ref, source, call)
        },
        render: { result: (_, value) => ({ kind: 'read', content: value as unknown as ChatBlock[] }) }
    })
    return (call: ToolCallContext): MediaRef => {
        const requester = owner(call)
        return (url, kind) => {
            if (!requester) return
            const ref = randomBytes(9).toString('base64url')
            sources.set(ref, { kind, url, owner: requester, expires: Date.now() + 15 * 60_000 })
            if (sources.size > 1024) sources.delete(sources.keys().next().value!)
            return ref
        }
    }
}
