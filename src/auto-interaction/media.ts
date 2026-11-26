import type { Context } from 'cordis'
import type {} from '@chatluna/ai-runtime'
import type { ChatBlock, ChatFileBlock } from '@chatluna/ai'
import type { QzoneMedia, QzoneShareCard } from 'qzone-sdk'
import { MediaReadError } from '../media.js'
import { asFile, downloadImage, isQzoneImageUrl } from '../qzone/media-file.js'
import { callModel } from '../model.js'
import { previewGif } from './gif.js'

const maxTotalBytes = 45 * 1024 * 1024
const visionRole = '@vision'

export interface PreparedInteractionMedia {
    lines: string[]
    imageParts: ChatFileBlock[]
    readable: ReadonlySet<string>
    read(ids: string[]): Promise<ChatBlock[]>
}

function metadata(media: QzoneMedia, id: string) {
    const fields = [`media_id=${id}`, `kind=${media.kind}`]
    if (media.name) fields.push(`name=${media.name}`)
    if (media.mimeType) fields.push(`declared_mime=${media.mimeType}`)
    if (media.size !== undefined) fields.push(`size=${media.size}`)
    if ('width' in media && media.width !== undefined) fields.push(`width=${media.width}`)
    if ('height' in media && media.height !== undefined) fields.push(`height=${media.height}`)
    if ('durationMs' in media && media.durationMs !== undefined) fields.push(`durationMs=${media.durationMs}`)
    return fields.join(' ')
}

type Download = Awaited<ReturnType<typeof downloadImage>>

/** 只在当前动态内用 M 编号读取图片；给模型的内容不携带 QQ 下载地址。 */
export async function prepareInteractionMedia(ctx: Context, media: readonly QzoneMedia[], model: string,
    signal: AbortSignal, share?: QzoneShareCard): Promise<PreparedInteractionMedia> {
    signal.throwIfAborted()
    const sources: readonly QzoneMedia[] = share?.previewUrl
        ? [...media, { kind: 'image', url: share.previewUrl }]
        : media
    const imageParts: ChatFileBlock[] = []
    const lines: string[] = []
    const readers = new Map<string, () => Promise<ChatBlock[]>>()
    let imageCount = 0
    const policy = { remainingBytes: maxTotalBytes, allowUrl: isQzoneImageUrl }
    let direct = false
    let vision = false
    if (sources.some(item => item.kind === 'image')) {
        direct = (await ctx.ai.caps<'chat'>(model, signal)).image === true
        if (!direct) {
            try {
                vision = (await ctx.ai.caps<'chat'>(visionRole, signal)).image === true
            } catch {
                signal.throwIfAborted()
            }
        }
    }
    for (const [index, item] of sources.entries()) {
        signal.throwIfAborted()
        const id = `M${index + 1}`
        const description = metadata(item, id) + (index === media.length ? ' 来源=分享封面' : '')
        if (item.kind !== 'image') {
            lines.push(`${description} status=metadata-only`)
            continue
        }
        if (++imageCount > 9) {
            lines.push(`${description} status=unresolved:image-count-limit`)
            continue
        }
        if (!direct && !vision) {
            lines.push(`${description} status=unresolved:no-image-reader`)
            continue
        }

        const url = URL.parse(item.url)
        if (!url || !isQzoneImageUrl(url)) {
            lines.push(`${description} status=unresolved:unsupported-image-host`)
            continue
        }
        const load = () => downloadImage(url, signal, policy)
        let downloaded: Download | undefined
        if (direct) {
            try {
                downloaded = await load()
                if (downloaded.mime !== 'image/gif') {
                    imageParts.push(await asFile(ctx, id, downloaded.bytes, downloaded.mime, signal))
                    lines.push(`${description} actual_mime=${downloaded.mime} status=attached`)
                    continue
                }
            } catch (error) {
                signal.throwIfAborted()
                lines.push(`${description} status=unresolved:${mediaError(error)}`)
                continue
            }
        }

        lines.push(`${description} status=tool-readable`)
        readers.set(id, async () => {
            const image = downloaded ?? await load()
            const gif = image.mime === 'image/gif' ? await previewGif(image.bytes, signal) : undefined
            const file = await asFile(ctx, id, gif?.bytes ?? image.bytes, gif ? 'image/jpeg' : image.mime, signal)
            const frames = gif?.frames
            const label = frames ? `${id}：按阅读顺序展示 ${frames.sampled}/${frames.total} 帧。` : id
            const parts: ChatBlock[] = [{ type: 'text', text: label }, file]
            if (direct) return parts
            const result = await callModel(ctx, { model: visionRole, purpose: 'livingdiary.interaction.media', cache: false,
                system: '说明图片中可见的内容和文字。若为动画拼图，按阅读顺序说明画面变化。只描述观察到的内容。',
                messages: [{ role: 'user', content: parts }] }, signal)
            if (!result.text.trim()) throw new MediaReadError('读图模型没有返回描述。')
            return [{ type: 'text', text: `${id}：${result.text.trim()}` }]
        })
    }
    const cache = new Map<string, ChatBlock[]>()
    async function read(ids: string[]) {
        const parts: ChatBlock[] = []
        for (const id of ids) {
            signal.throwIfAborted()
            let result = cache.get(id)
            if (!result) {
                try {
                    result = await readers.get(id)!()
                } catch (error) {
                    signal.throwIfAborted()
                    result = [{ type: 'text', text: `${id}：读取失败，${mediaError(error)}请按未解析处理。` }]
                }
                cache.set(id, result)
            }
            parts.push(...result)
        }
        return parts
    }
    return { lines, imageParts, readable: new Set(readers.keys()), read }
}

function mediaError(error: unknown) {
    return error instanceof MediaReadError ? error.message : '图片无法解析。'
}
