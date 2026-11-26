import type { Context } from 'cordis'
import type { ChatFileBlock } from '@chatluna/ai'
import type {} from '@chatluna/storage-files'
import { downloadMediaBytes, MediaReadError, type MediaReadPolicy } from '../media.js'

const maxImageBytes = 15 * 1024 * 1024
const maxVideoBytes = 32 * 1024 * 1024

export function isQzoneImageUrl(url: URL) {
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.port) return false
    // QQ 空间照片列表使用 photo.store.qq.com，详情与缩略图使用 qpic.cn。
    return ['qpic.cn', 'photo.store.qq.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))
}

export async function downloadImage(url: URL, signal: AbortSignal, policy: MediaReadPolicy = { remainingBytes: maxImageBytes, allowUrl: isQzoneImageUrl }) {
    const bytes = await downloadMediaBytes(url, 'image', maxImageBytes, signal, policy)
    const head = bytes.subarray(0, 12)
    let mime: string
    if (head.subarray(0, 3).toString('hex') === 'ffd8ff') mime = 'image/jpeg'
    else if (head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') mime = 'image/png'
    else if (['GIF87a', 'GIF89a'].includes(head.toString('ascii', 0, 6))) mime = 'image/gif'
    else if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp'
    else throw new MediaReadError('图片格式不受支持。')
    return { bytes, mime }
}

export async function downloadVideo(url: URL, signal: AbortSignal) {
    const bytes = await downloadMediaBytes(url, 'video', maxVideoBytes, signal, {
        remainingBytes: maxVideoBytes,
        allowUrl: url => ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
            (url.hostname === 'photovideo.photo.qq.com' || url.hostname.endsWith('.video.qq.com') || url.hostname.endsWith('.tc.qq.com'))
    })
    // 与 SDK 的 MP4 输入一致，避免将同样以 ftyp 开头的 AVIF、HEIC 作为视频送入模型。
    if (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp' ||
        bytes.readUInt32BE(0) < 16 || bytes.readUInt32BE(0) > bytes.length ||
        !/^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(bytes.toString('ascii', 8, 12))) {
        throw new MediaReadError('空间返回的文件缺少有效的 MP4 文件头。')
    }
    return { bytes, mime: 'video/mp4' }
}

export async function asFile(ctx: Context, id: string, bytes: Buffer, mime: string, signal: AbortSignal): Promise<ChatFileBlock> {
    const filename = `${id}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`
    const file = { type: 'file' as const, filename, mediaType: mime, fileSize: bytes.length }
    const storage = ctx.get('chatluna_storage')
    if (storage) {
        try {
            const stored = await storage.createTempFile(bytes, filename, { mimeType: mime, expireHours: 1 })
            signal.throwIfAborted()
            return { ...file, data: { type: 'reference', reference: `storage://${stored.id}` } }
        } catch {
            signal.throwIfAborted()
        }
    }
    return { ...file, data: { type: 'data', data: bytes.toString('base64') } }
}
