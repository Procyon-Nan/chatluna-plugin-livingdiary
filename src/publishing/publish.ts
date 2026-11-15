import type { Context } from 'cordis'
import {
    QzoneAuthError, QzoneCancelledError, QzoneError, QzoneValidationError,
    type MutationOutcome, type PublishImageInput
} from 'qzone-sdk'
import { CookieAcquireError, NoBotAvailableError } from '../qzone/cookie-source.js'
import { QzoneWriteAuthError, type QzoneManager } from '../qzone/manager.js'
import { ImageReadError } from '../image.js'
import { readPublishImage } from './media.js'

export interface PublishInput {
    content: string
    images?: readonly string[]
}

export function readableError(error: unknown, prefix: string): string {
    let reason: string
    if (error instanceof QzoneWriteAuthError) {
        reason = error.rebound ? 'QQ 空间登录态已续绑，请核对发布结果。' : 'QQ 空间登录态失效，自动续绑不可用，请人工处理。'
    } else if (error instanceof QzoneAuthError) {
        reason = 'QQ 空间登录态失效，请稍后重试。'
    } else if (error instanceof QzoneCancelledError) {
        reason = '插件正在停止，操作已取消。'
    } else if (error instanceof CookieAcquireError || error instanceof NoBotAvailableError ||
        error instanceof ImageReadError || error instanceof QzoneValidationError) {
        reason = error.message
    } else if (error instanceof QzoneError) {
        reason = `QQ 空间接口错误（${error.code}）。`
    } else {
        reason = '操作失败，请检查空间服务及配图是否可用。'
    }
    return `${prefix}：${reason}`
}

export const publishOutcomeMessages: Record<MutationOutcome, string> = {
    verified: '发布成功。',
    'already-applied': '空间已处于目标状态。',
    accepted: '发布请求已受理，可用 qzone.feeds 核对。',
    unknown: '发布结果未知，可用 qzone.feeds 核对。'
}

/** 命令与工具在所有配图就绪后只提交一次。 */
export async function publishPost(ctx: Context, qzone: Pick<QzoneManager, 'publish'>, input: PublishInput, signal?: AbortSignal):
    Promise<{ outcome: MutationOutcome | 'failed'; message: string }> {
    const content = input.content.replace(/\s+/g, ' ').trim()
    const urls = input.images ?? []
    if (!content && !urls.length) return { outcome: 'failed', message: '请提供要发布的动态内容或图片。' }
    if (urls.length > 9) return { outcome: 'failed', message: '一次最多只能发布 9 张图片。' }
    const images: PublishImageInput[] = []
    try {
        for (const url of urls) {
            signal?.throwIfAborted()
            images.push(await readPublishImage(ctx, url, signal))
        }
        signal?.throwIfAborted()
        const result = await qzone.publish({
            content: content.length > 100 ? content.slice(0, 100) + '…' : content,
            ...(signal ? { signal } : {}),
            ...(images.length ? { images } : {})
        })
        return { outcome: result.outcome, message: publishOutcomeMessages[result.outcome] }
    } catch (error) {
        signal?.throwIfAborted()
        const prefix = error instanceof ImageReadError ? `第 ${images.length + 1} 张配图` : '发布动态失败'
        const message = readableError(error, prefix)
        ctx.logger.warn(message)
        return { outcome: 'failed', message }
    }
}
