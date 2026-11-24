import type { Context } from 'cordis'
import type {} from '@chatluna/storage-files'
import type { FileRefTable } from '@chatluna/transform'
import type { PublishImageInput } from 'qzone-sdk'

import { checkMediaSize, downloadMediaBytes, MediaReadError, mediaLabels, type MediaKind } from '../media.js'

const maxBytes = { image: 32 * 1024 * 1024, video: 128 * 1024 * 1024 }
const defaultNames = { image: 'image.jpg', video: 'video.mp4' }
type PublishMediaInput = Pick<PublishImageInput, 'data' | 'name'>

export function isMediaRef(reference: string): boolean {
    return /^i[\da-f]{6,64}$/.test(reference)
}

function mediaName(pathname: string, kind: MediaKind): string {
    let name = pathname.split('/').pop() ?? ''
    try {
        name = decodeURIComponent(name)
    } catch {
        // 非编码的百分号按原始文件名处理。
    }
    return name.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 80) || defaultNames[kind]
}

/** 按当前会话附件编号读取原文件，直接地址沿用存储和下载入口。 */
export async function readPublishMedia(ctx: Context, reference: string, kind: MediaKind, signal?: AbortSignal, files?: FileRefTable): Promise<PublishMediaInput> {
    signal?.throwIfAborted()
    const label = mediaLabels[kind]
    if (!isMediaRef(reference)) return readMediaAddress(ctx, reference, kind, signal)
    if (!files) throw new MediaReadError(`${label}编号需要当前聊天会话。`)
    const block = files.resolve(reference)
    if (!block) throw new MediaReadError(`当前会话中未找到该${label}编号，请使用对话中的${label} ref。`)
    if (!block.mediaType.startsWith(`${kind}/`)) throw new MediaReadError(`该附件不是${label}，请选择${label}编号。`)
    let media: PublishMediaInput
    switch (block.data.type) {
        case 'reference':
            media = await readMediaAddress(ctx, block.data.reference, kind, signal)
            break
        case 'url':
            media = await readMediaAddress(ctx, block.data.url, kind, signal)
            break
        case 'data': {
            const encoded = block.data.data.replace(/^data:[^,]*,/, '')
            checkMediaSize(Buffer.byteLength(encoded, 'base64'), maxBytes[kind], kind)
            media = { data: Buffer.from(encoded, 'base64'), name: defaultNames[kind] }
            break
        }
        case 'text':
            throw new MediaReadError(`该${label}的原文件不可读取，请重新提供${label}。`)
    }
    signal?.throwIfAborted()
    return block.filename ? { ...media, name: block.filename } : media
}

async function readMediaAddress(ctx: Context, reference: string, kind: MediaKind, signal?: AbortSignal): Promise<PublishMediaInput> {
    const label = mediaLabels[kind]
    if (reference.startsWith('storage://') || reference.startsWith('/files/')) {
        const key = reference.startsWith('storage://')
            ? reference.slice('storage://'.length)
            : decodeURIComponent(reference.slice('/files/'.length))
        if (!key) throw new MediaReadError(`${label}地址缺少文件标识。`)
        const file = await ctx.get('chatluna_storage')?.getTempFile(key)
        if (!file) throw new MediaReadError(`临时${label}不可用，请重新提供${label}。`)
        checkMediaSize(file.size, maxBytes[kind], kind)
        const data = await file.data
        signal?.throwIfAborted()
        checkMediaSize(data.byteLength, maxBytes[kind], kind)
        return { data, name: file.name }
    }
    const url = URL.parse(reference)
    if (url?.protocol !== 'https:' && url?.protocol !== 'http:') {
        throw new MediaReadError(`请提供对话中完整的${label} ref 或可读取的${label}地址。`)
    }
    return { data: await downloadMediaBytes(url, kind, maxBytes[kind], signal), name: mediaName(url.pathname, kind) }
}
