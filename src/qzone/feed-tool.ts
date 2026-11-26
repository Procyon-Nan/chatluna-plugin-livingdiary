import type { Context } from 'cordis'
import type {} from '@chatluna/tool'
import type { QzonePost } from 'qzone-sdk'
import Schema from 'schemastery'
import { requireRequester } from '../access.js'
import { FEEDS_LIMIT_MAX, type Config } from '../config.js'
import type { QzoneManager } from './manager.js'

function feedTarget(scope?: 'self' | 'friends', userId?: string) {
    if (scope && userId === undefined) return { scope }
    if (!scope && userId !== undefined) return { scope: 'profile' as const, userId }
    throw new Error('请在 scope 和 userId 中指定一项。')
}

function summarizePost(post: QzonePost) {
    const { id, authorId, author, createdAt, content, likeCount, commentCount, share } = post
    const mediaCounts = { image: 0, video: 0, audio: 0, file: 0 }
    for (const media of post.media) mediaCounts[media.kind]++
    return {
        id, authorId, nickname: author.nickname, createdAt, content, likeCount, commentCount, mediaCounts,
        ...(share && { share: { title: share.title, summary: share.summary, ...(share.url && { url: share.url }) } })
    }
}

export function registerFeedTool(ctx: Context, config: Pick<Config, 'allowUserIds' | 'feedsDefaultLimit'>,
    qzone: Pick<QzoneManager, 'listFeedPage'>) {
    ctx.tools.define({
        name: 'qzone_list_feeds',
        description: 'Read Qzone posts for the current requester. Supply exactly one of scope or userId. ' +
            'If only a nickname is known, ask for the QQ number. Describe posts by nickname, time and content; ' +
            'keep authorId and id to identify each post. The friends feed follows Qzone order.',
        locales: { zh: { description: '查看机器人自己的动态、好友动态流或指定 QQ 的主页。仅知道昵称时询问 QQ 号；用昵称、时间及内容介绍动态，保留作者和动态 ID 以便指认。' } },
        args: Schema.object({
            scope: Schema.union(['self', 'friends']).description('Use self for the bot or friends for its feed. Omit when supplying userId.'),
            userId: Schema.string().pattern(/^\d+$/).description('QQ number of the profile to read, instead of scope.'),
            limit: Schema.natural().min(1).max(FEEDS_LIMIT_MAX).description('Maximum posts to return; omit to use the configured page size.'),
            cursor: Schema.string().pattern(/\S/).description('For the next page, pass the previous nextCursor with the same target. Stop when null.')
        }),
        traits: { effect: 'read', background: false },
        async run({ scope, userId, limit = config.feedsDefaultLimit, cursor }, call) {
            requireRequester(call, config.allowUserIds)
            const page = await qzone.listFeedPage({ ...feedTarget(scope, userId), limit, cursor, signal: call.signal })
            return { items: page.items.map(summarizePost), nextCursor: page.nextCursor }
        }
    })
}
