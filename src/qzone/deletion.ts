import { QzoneNotFoundError, type QzonePost } from 'qzone-sdk'
import { readableError } from '../publishing/publish.js'
import { QzoneWriteAuthError, type QzoneManager } from './manager.js'

export const MAX_RECENT = 10
export interface DeleteInput { id?: string; recent?: number }
type DeletionService = Pick<QzoneManager, 'listFeedPage' | 'deleteOwnPost'>
type Target = string | QzonePost
const idOf = (target: Target) => typeof target === 'string' ? target : target.id

export async function deletePosts(qzone: DeletionService, { id, recent }: DeleteInput, signal: AbortSignal,
    confirm?: (posts: QzonePost[]) => Promise<string | undefined>): Promise<string> {
    if ((id === undefined) === (recent === undefined)) return '请在动态 ID 和最近条数中指定一项。'
    if (id !== undefined) return id.trim() ? execute(qzone, [id.trim()], signal) : '动态 ID 不能为空。'
    if (!recent || !Number.isInteger(recent) || recent < 1 || recent > MAX_RECENT) return '最近条数必须为 1–10 的整数。'
    try {
        const posts = new Map<string, QzonePost>()
        let cursor: string | null = null
        do {
            signal.throwIfAborted()
            const page = await qzone.listFeedPage({ scope: 'self', limit: recent - posts.size, cursor: cursor ?? undefined, signal })
            for (const post of page.items) {
                posts.set(post.id, post)
                if (posts.size === recent) break
            }
            cursor = page.nextCursor
        } while (cursor && posts.size < recent)
        if (!posts.size) return '暂无可删除的自身动态。'
        const targets = [...posts.values()]
        const stopped = await confirm?.(targets)
        return stopped ?? execute(qzone, targets, signal)
    } catch (error) {
        return signal.aborted ? '删除已取消。' : readableError(error, '准备删除动态失败')
    }
}

async function execute(qzone: DeletionService, targets: Target[], signal: AbortSignal) {
    const lines: string[] = []
    for (const target of targets) {
        if (signal.aborted) break
        const id = idOf(target)
        try {
            const { outcome } = await qzone.deleteOwnPost(target, signal)
            if (outcome === 'verified') {
                lines.push(`${id}：已删除。`)
                continue
            }
            lines.push(`${id}：${outcome === 'accepted' ? '删除请求已受理，尚未确认。' : '删除结果未知，请查看空间。'}`)
        } catch (error) {
            let message = readableError(error, '删除失败')
            if (error instanceof QzoneNotFoundError) message = '未找到该动态。'
            else if (error instanceof QzoneWriteAuthError) message = error.message
            else if (signal.aborted) message = '操作已取消，删除结果请查看空间。'
            lines.push(`${id}：${message}`)
        }
        break
    }
    const remaining = targets.slice(lines.length)
    if (remaining.length) lines.push(`尚未执行：${remaining.map(idOf).join('、')}`)
    return lines.join('\n')
}
