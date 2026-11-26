import { addAbortListener } from 'node:events'
import { h } from '@satorijs/core'
import type { Session } from 'koishi'
import type { QzonePost } from 'qzone-sdk'
import { formatTime, sliceContent } from './format.js'
import { deletePosts, type DeleteInput } from '../qzone/deletion.js'
import type { QzoneService } from '../qzone/service.js'

function summary(post: QzonePost) {
    const caption = sliceContent(post.content) || sliceContent(post.share?.title ?? '')
    if (caption) return caption
    const labels = { image: '图片', video: '视频', audio: '音频', file: '文件' }
    const counts = new Map<string, number>()
    for (const { kind } of post.media) counts.set(labels[kind], (counts.get(labels[kind]) ?? 0) + 1)
    return Array.from(counts, ([label, n]) => `${label} × ${n}`).join('、') || '无配文'
}

async function confirm(session: Session, posts: QzonePost[], signal: AbortSignal) {
    const preview = posts.map((p, i) => `${i + 1}. ${formatTime(p.createdAt)}  ${summary(p)}  ·  ID：${p.id}`)
    signal.throwIfAborted()
    const sent = await session.send(h.text([`将删除以下 ${posts.length} 条 QQ 空间动态：`, ...preview,
        '请在 60 秒内回复「确认删除」或「取消」。'].join('\n')))
    if (!sent.length) return '删除清单发送失败，操作已取消。'
    signal.throwIfAborted()
    const deadline = Date.now() + 60_000
    const cancelled = Promise.withResolvers<void>()
    using listener = addAbortListener(signal, () => cancelled.resolve())
    // Koishi 的 prompt 每次只收一条回复。无关消息继续交给聊天，并沿用原截止时间。
    while (!signal.aborted && Date.now() < deadline) {
        let ignored = false
        const response = await Promise.race([cancelled.promise, session.prompt(answer => {
            if (signal.aborted || Date.now() >= deadline) return
            if (answer.fid === session.fid && answer.selfId === session.selfId) {
                const value = answer.content?.trim()
                if (value === '确认删除' || value === '取消') return value
            }
            ignored = true
        }, { timeout: deadline - Date.now() })])
        if (response === '确认删除') return
        if (signal.aborted || response === '取消') return '删除已取消。'
        if (!ignored) break
    }
    return signal.aborted ? '删除已取消。' : '确认已超时，删除已取消。'
}

export function createDeleteCommand(qzone: QzoneService, signal: AbortSignal) {
    const pending = new Set<string>()
    return async (input: DeleteInput, session: Session) => {
        if (input.recent === undefined) return deletePosts(qzone, input, signal)
        const key = JSON.stringify([session.sid, session.fid])
        if (pending.has(key)) return '请先完成当前会话中待确认的删除操作。'
        pending.add(key)
        try {
            return await deletePosts(qzone, input, signal, posts => confirm(session, posts, signal))
        } finally {
            pending.delete(key)
        }
    }
}
