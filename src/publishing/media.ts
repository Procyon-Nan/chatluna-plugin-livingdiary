import type { Context } from 'cordis'
import type {} from '@chatluna/storage-files'
import type { FileRefTable } from '@chatluna/transform'
import type { PublishImageInput } from 'qzone-sdk'

import { checkImageSize, downloadImageBytes, ImageReadError } from '../image.js'

const maxImageBytes = 32 * 1024 * 1024

export function isImageRef(reference: string): boolean {
    return /^i[\da-f]{6,64}$/.test(reference)
}

function imageName(pathname: string): string {
    let name = pathname.split('/').pop() ?? ''
    try {
        name = decodeURIComponent(name)
    } catch {
        // 非编码的百分号按原始文件名处理。
    }
    return name.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 80) || 'image.jpg'
}

/** 按当前会话的附件编号读取原图，直接地址沿用存储和下载入口。 */
export async function readPublishImage(ctx: Context, reference: string, signal?: AbortSignal, files?: FileRefTable): Promise<PublishImageInput> {
    signal?.throwIfAborted()
    if (!isImageRef(reference)) return readImageAddress(ctx, reference, signal)
    if (!files) throw new ImageReadError('图片编号需要当前聊天会话。')
    const block = files.resolve(reference)
    if (!block) throw new ImageReadError('当前会话中未找到该图片编号，请使用对话中的图片 ref。')
    if (!block.mediaType.startsWith('image/')) throw new ImageReadError('该附件不是图片，请选择图片编号。')
    let image: PublishImageInput
    switch (block.data.type) {
        case 'reference':
            image = await readImageAddress(ctx, block.data.reference, signal)
            break
        case 'url':
            image = await readImageAddress(ctx, block.data.url, signal)
            break
        case 'data': {
            const encoded = block.data.data.replace(/^data:[^,]*,/, '')
            checkImageSize(Buffer.byteLength(encoded, 'base64'), maxImageBytes)
            image = { data: Buffer.from(encoded, 'base64'), name: 'image' }
            break
        }
        case 'text':
            throw new ImageReadError('该图片的原文件不可读取，请重新提供图片。')
    }
    signal?.throwIfAborted()
    return block.filename ? { ...image, name: block.filename } : image
}

async function readImageAddress(ctx: Context, reference: string, signal?: AbortSignal): Promise<PublishImageInput> {
    if (reference.startsWith('storage://') || reference.startsWith('/files/')) {
        const key = reference.startsWith('storage://')
            ? reference.slice('storage://'.length)
            : decodeURIComponent(reference.slice('/files/'.length))
        if (!key) throw new ImageReadError('图片地址缺少文件标识。')
        const file = await ctx.get('chatluna_storage')?.getTempFile(key)
        if (!file) throw new ImageReadError('临时图片不可用，请重新提供图片。')
        const data = await file.data
        signal?.throwIfAborted()
        checkImageSize(data.byteLength, maxImageBytes)
        return { data, name: file.name }
    }
    const url = URL.parse(reference)
    if (url?.protocol !== 'https:' && url?.protocol !== 'http:') {
        throw new ImageReadError('请提供对话中完整的图片 ref 或可读取的图片地址。')
    }
    return { data: await downloadImageBytes(url, maxImageBytes, signal), name: imageName(url.pathname) }
}
