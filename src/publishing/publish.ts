import type { Context } from 'cordis'
import type { FileRefTable } from '@chatluna/transform'
import {
    QzoneAuthError, QzoneCancelledError, QzoneError, QzoneValidationError,
    type MutationOutcome, type PublishImageInput, type PublishVideoInput
} from 'qzone-sdk'
import { CookieAcquireError, NoBotAvailableError } from '../qzone/cookie-source.js'
import type { QzoneManager } from '../qzone/manager.js'
import { MediaReadError } from '../media.js'
import { readPublishMedia } from './media.js'

export interface PublishInput {
    content: string
    images?: readonly string[]
    videos?: readonly string[]
}

export function readableError(error: unknown, prefix: string): string {
    let reason: string
    if (error instanceof QzoneAuthError) {
        const { statusCode, serviceCode } = error.context ?? {}
        reason = 'QQ 空间登录态失效'
        if (statusCode !== undefined) reason += `（HTTP ${statusCode}）`
        if (serviceCode !== undefined) reason += `（业务码 ${serviceCode}）`
        reason += '。'
    } else if (error instanceof QzoneCancelledError) {
        reason = '插件正在停止，操作已取消。'
    } else if (error instanceof CookieAcquireError || error instanceof NoBotAvailableError ||
        error instanceof MediaReadError || error instanceof QzoneValidationError) {
        reason = error.message
    } else if (error instanceof QzoneError) {
        reason = `QQ 空间接口错误（${error.code}）。`
    } else {
        reason = '操作失败，请检查空间服务及素材是否可用。'
    }
    return `${prefix}：${reason}`
}

export const publishOutcomeMessages: Record<MutationOutcome, string> = {
    verified: '发布成功。',
    'already-applied': '空间已处于目标状态。',
    accepted: '发布请求已受理，可用 qzone.feeds 核对。',
    unknown: '发布结果未知，可用 qzone.feeds 核对。'
}

/** 命令与工具在全部素材就绪后只提交一次。 */
export async function publishPost(ctx: Context, qzone: Pick<QzoneManager, 'publish'>, input: PublishInput, signal?: AbortSignal, files?: FileRefTable):
    Promise<{ outcome: MutationOutcome | 'failed'; message: string }> {
    const content = input.content
    const imageRefs = input.images ?? []
    const videoRefs = input.videos ?? []
    if (!content.trim() && !imageRefs.length && !videoRefs.length) return { outcome: 'failed', message: '请提供要发布的正文、图片或视频。' }
    if (imageRefs.length > 9) return { outcome: 'failed', message: '一次最多只能发布 9 张图片。' }
    const images: PublishImageInput[] = []
    const videos: PublishVideoInput[] = []
    let reading = ''
    try {
        for (const reference of imageRefs) {
            reading = `第 ${images.length + 1} 张配图`
            images.push(await readPublishMedia(ctx, reference, 'image', signal, files))
        }
        for (const reference of videoRefs) {
            reading = `第 ${videos.length + 1} 段视频`
            videos.push(await readPublishMedia(ctx, reference, 'video', signal, files))
        }
        signal?.throwIfAborted()
        const result = await qzone.publish({
            content,
            ...(signal ? { signal } : {}),
            ...(images.length ? { images } : {}),
            ...(videos.length ? { videos } : {})
        })
        return { outcome: result.outcome, message: publishOutcomeMessages[result.outcome] }
    } catch (error) {
        signal?.throwIfAborted()
        const prefix = error instanceof MediaReadError ? reading : '发布动态失败'
        const message = readableError(error, prefix)
        ctx.logger.warn(message)
        return { outcome: 'failed', message }
    }
}
