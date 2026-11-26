import type { Context } from 'cordis'
import { h } from '@satorijs/core'
import type {} from 'koishi'
import { FEEDS_LIMIT_MAX, type Config } from '../config.js'
import { isUserAllowed } from '../access.js'
import { publishPost, readableError } from '../publishing/publish.js'
import type { QzoneService } from '../qzone/service.js'
import type { RuntimeReports } from '../status.js'
import { formatFeedList, formatStatus } from './format.js'
import { createDeleteCommand } from './delete.js'

export function clampFeedCount(
    count: number | undefined,
    defaultLimit: number
): number {
    const value = count ?? defaultLimit
    return Math.min(Math.max(Math.trunc(value) || 1, 1), FEEDS_LIMIT_MAX)
}

export interface PublishParts {
    readonly content: string
    readonly imageUrls: readonly string[]
    readonly videoUrls: readonly string[]
}

/**
 * 拆分发布指令的元素参数：正文取顶层 text，图片和视频取顶层 img/video。
 *
 * 只遍历顶层，不递归子树：QQ 表情（face）内嵌的 CDN 图片不应成为
 * 配图，引用等其余元素及其子树一律丢弃（内容不进入正文）。
 */
export function extractPublishParts(elements: readonly h[]): PublishParts {
    let content = ''
    const imageUrls: string[] = []
    const videoUrls: string[] = []
    for (const element of elements) {
        if (element.type === 'text') {
            content += String(element.attrs.content ?? '')
        } else if (element.type === 'img' || element.type === 'video') {
            const src = element.attrs.src ?? element.attrs.url
            if (typeof src === 'string' && src) {
                if (element.type === 'img') imageUrls.push(src)
                else videoUrls.push(src)
            }
        }
    }
    return { content, imageUrls, videoUrls }
}

export function registerCommands(ctx: Context, config: Config, service: QzoneService, reports: RuntimeReports, stopping: AbortSignal): void {
    const deleteCommand = createDeleteCommand(service, stopping)
    const owner = 'livingdiary'
    const denial = '未授权：你的账号不在 allowUserIds 白名单中。'
    const usage = '子指令：qzone.feeds 读取动态；qzone.publish 发布动态（可附图片和 MP4 视频）；qzone.delete 删除自己的动态；qzone.status 查看状态；qzone.digest 根据今天的记忆写日记（需 LivingMemory 和模型服务）。'

    ctx.command('qzone', 'QQ 空间生活日记', { owner }).usage(usage).action(() => usage)
    ctx.command('qzone.feeds [count:posint]', '读取 QQ 空间动态', { owner })
        .option('target', '-t <qq:string> 读取指定 QQ 的公开动态，默认读取自己')
        .action(async ({ session, options }, count) => {
            if (!isUserAllowed(session?.userId, config.allowUserIds, session?.platform)) return denial
            const limit = clampFeedCount(count, config.feedsDefaultLimit)
            try {
                const target = options?.target
                const page = target
                    ? await service.listFeedPage({ scope: 'profile', userId: target, limit })
                    : await service.listFeedPage({ scope: 'self', limit })
                return h.escape(formatFeedList(page.items, !target))
            } catch (error) {
                ctx.logger.warn('错误：读取空间动态失败')
                return h.escape(readableError(error, '读取动态失败'))
            }
        })
    ctx.command('qzone.publish <content:elements>', '发布动态到 QQ 空间（最多九张图片，可附 MP4 视频）', { owner })
        .action(async ({ session }, content) => {
            if (!isUserAllowed(session?.userId, config.allowUserIds, session?.platform)) return denial
            const parts = extractPublishParts(content ?? [])
            const result = await publishPost(ctx, service, { content: parts.content, images: parts.imageUrls, videos: parts.videoUrls })
            return h.escape(result.message)
        })
    ctx.command('qzone.delete [id:string]', '删除机器人自己的 QQ 空间动态', { owner, checkUnknown: true, checkArgCount: true })
        .option('recent', '--recent <数量:posint> 预览最近 1–10 条动态并确认删除')
        .action(async ({ session, options }, id) => {
            if (!session || !isUserAllowed(session.userId, config.allowUserIds, session.platform)) return denial
            return h.escape(await deleteCommand({ id, recent: options?.recent }, session))
        })
    ctx.command('qzone.status', '查看 QQ 空间登录态', { owner })
        .action(({ session }) => isUserAllowed(session?.userId, config.allowUserIds, session?.platform)
            ? formatStatus(service.status(), reports)
            : denial)
}
