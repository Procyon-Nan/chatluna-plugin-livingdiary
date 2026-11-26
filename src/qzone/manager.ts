import {
    type CommentMutationResult,
    type CommentOptions,
    type FeedPage,
    type GetPostOptions,
    type ListFeedsOptions,
    type PostMutationResult,
    type PublishPostOptions,
    QzoneAuthError,
    QzoneCancelledError,
    type QzoneClient,
    type QzoneLogger,
    type QzoneSessionInput,
    type QzonePost,
    type ReplyOptions,
    type SessionInfo
} from 'qzone-sdk'
import { canonicalQQ, type CookieBot, type QzoneCookieGrant } from './cookie-source.js'
import type { Logger } from 'cordis'
import {
    RebindController,
    type RebindOptions,
    RebindRejectedError,
    type RebindStats
} from './rebind.js'

export interface QzoneManagerStatus {
    readonly initialized: boolean
    readonly accountId: string | null
    readonly authenticated: boolean
    readonly sessionUpdatedAt: string | null
    readonly rebind: RebindStats
}

const writeLabels = { comment: '评论动态', reply: '回复评论', delete: '删除动态' } as const
export type QzoneWriteOperation = keyof typeof writeLabels

/** 写操作登录态失效：已按策略尝试续绑，但绝不自动重放。 */
export class QzoneWriteAuthError extends Error {
    readonly operation: QzoneWriteOperation
    readonly rebound: boolean

    constructor(operation: QzoneWriteOperation, rebound: boolean) {
        super(`${writeLabels[operation]}时登录态失效，${rebound ? '续绑已完成' : '续绑不可用'}`)
        this.name = 'QzoneWriteAuthError'
        this.operation = operation
        this.rebound = rebound
    }
}

export interface QzoneManagerDeps {
    readonly currentBot: () => Pick<CookieBot, 'platform' | 'selfId'> | undefined
    /** 从绑定机器人获取当前 Cookie 及其所属账号。 */
    readonly acquire: () => Promise<QzoneCookieGrant>
    readonly createClient: (session: QzoneSessionInput & { accountId: string }, observe?: QzoneLogger) => QzoneClient
    readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>
    readonly rebind: RebindOptions
}

/**
 * 单账号 QzoneClient 管理器：懒初始化、失效续绑与关闭语义。
 *
 * 读操作在续绑成功后自动重放一次（幂等）；写操作不重放——payload 级
 * 失效检测存在误报可能，自动重放可能导致重复发布。
 */
export class QzoneManager {
    readonly #rebind: RebindController
    readonly #deps: QzoneManagerDeps
    #client: QzoneClient | null = null
    #pendingGrant?: Promise<QzoneCookieGrant>
    #closed = false

    constructor(deps: QzoneManagerDeps) {
        this.#deps = deps
        this.#rebind = new RebindController({
            ...deps.rebind,
            logger: deps.rebind.logger ?? deps.logger
        })
    }

    /** 读取动态页；登录态失效时续绑成功后重放一次读取。 */
    listFeedPage(query: ListFeedsOptions): Promise<FeedPage> {
        return this.#runRead('读取动态', query.signal, async client => {
            if (query.scope !== 'self') return client.listFeeds(query)
            // SDK 的 self 读取空间首页，会混入好友动态。个人主页按绑定账号取帖。
            const accountId = client.getSessionInfo().accountId
            if (!accountId) throw new Error('空间登录态缺少绑定账号。')
            const userId = canonicalQQ(accountId)
            const page = await client.listFeeds({ ...query, scope: 'profile', userId })
            return { ...page, items: page.items.filter(post => canonicalQQ(post.authorId) === userId) }
        })
    }

    /** 读取动态详情；登录态失效时续绑成功后重放一次读取。 */
    getPost(request: GetPostOptions): Promise<QzonePost> {
        return this.#runRead('读取动态详情', request.signal, (client) =>
            client.getPost(request)
        )
    }

    /** 使用绑定机器人当前的 Cookie 发布动态。 */
    publish(request: PublishPostOptions): Promise<PostMutationResult> {
        return this.#publish(request)
    }

    /** SDK 也会用最近动态的相同正文确认发布；日记只接受按回执 ID 读取的详情。 */
    async publishDiary(request: Pick<PublishPostOptions, 'content' | 'signal'>): Promise<boolean> {
        let readById = false
        const { outcome } = await this.#publish(request, event => {
            if (event.phase === 'request.start' &&
                (event.endpoint === 'post.detail.legacy' || event.endpoint === 'post.detail.h5')) readById = true
        })
        return readById && outcome === 'verified'
    }

    async #publish(request: PublishPostOptions, observe?: QzoneLogger): Promise<PostMutationResult> {
        const { cookies, accountId } = await this.#acquire(request.signal)
        this.#assertOpen(request.signal)
        const client = this.#deps.createClient({ cookies, accountId }, observe)
        try {
            return await client.publishPost(request)
        } finally {
            await client.close()
        }
    }

    deleteOwnPost(target: string | QzonePost, signal: AbortSignal): Promise<PostMutationResult> {
        return this.#runWrite('delete', signal, client => {
            const accountId = client.getSessionInfo().accountId
            if (!accountId) throw new Error('空间登录态缺少绑定账号。')
            const post = typeof target === 'string' ? { id: target, authorId: accountId } : target
            return client.deleteOwnPost({ post, signal })
        })
    }

    /** 评论动态；登录态失效时仅触发续绑，不自动重放。 */
    comment(request: CommentOptions): Promise<CommentMutationResult> {
        return this.#runWrite('comment', request.signal, (client) =>
            client.comment(request)
        )
    }

    /** 回复评论；登录态失效时仅触发续绑，不自动重放。 */
    reply(request: ReplyOptions): Promise<CommentMutationResult> {
        return this.#runWrite('reply', request.signal, (client) =>
            client.reply(request)
        )
    }

    status() {
        const selected = this.#deps.currentBot()
        const bot = selected ? { platform: selected.platform, selfId: selected.selfId } : null
        return { bot, client: this.#clientStatus() }
    }

    #clientStatus(): QzoneManagerStatus {
        const info: SessionInfo | null = this.#client?.getSessionInfo() ?? null
        return {
            initialized: this.#client !== null,
            accountId: info?.accountId ?? null,
            authenticated: info?.authenticated ?? false,
            sessionUpdatedAt: info?.updatedAt ?? null,
            rebind: this.#rebind.stats()
        }
    }

    async close(): Promise<void> {
        this.#closed = true
        await this.#pendingGrant?.catch(() => {})
        await this.#rebind.settled()
        const client = this.#client
        this.#client = null
        await client?.close()
    }

    #assertOpen(signal?: AbortSignal): void {
        if (this.#closed) throw new QzoneCancelledError('QQ 空间客户端已随插件停止释放')
        signal?.throwIfAborted()
    }

    #acquire(signal?: AbortSignal): Promise<QzoneCookieGrant> {
        this.#assertOpen(signal)
        return this.#pendingGrant ??= this.#deps.acquire().finally(() => { this.#pendingGrant = undefined })
    }

    async #getClient(): Promise<QzoneClient> {
        if (this.#client) return this.#client
        const { cookies, accountId } = await this.#acquire()
        this.#assertOpen()
        return this.#client ??= this.#deps.createClient({ cookies, accountId })
    }

    async #runRead<T>(
        phase: string,
        signal: AbortSignal | undefined,
        operation: (client: QzoneClient) => Promise<T>
    ): Promise<T> {
        signal?.throwIfAborted()
        const client = await this.#getClient()
        this.#assertOpen(signal)
        try {
            return await operation(client)
        } catch (error) {
            if (!(error instanceof QzoneAuthError)) {
                throw error
            }
            signal?.throwIfAborted()
            const rebound = await this.#tryRebind(client, phase)
            if (!rebound) {
                throw error
            }
            this.#assertOpen(signal)
            return operation(client)
        }
    }

    async #runWrite<T>(
        kind: QzoneWriteOperation,
        signal: AbortSignal | undefined,
        operation: (client: QzoneClient) => Promise<T>
    ): Promise<T> {
        signal?.throwIfAborted()
        const client = await this.#getClient()
        this.#assertOpen(signal)
        try {
            return await operation(client)
        } catch (error) {
            if (error instanceof QzoneAuthError) {
                signal?.throwIfAborted()
                const rebound = await this.#tryRebind(client, writeLabels[kind])
                throw new QzoneWriteAuthError(kind, rebound)
            }
            throw error
        }
    }

    /** 执行一次续绑（单飞、限流）；返回续绑是否成功。 */
    async #tryRebind(client: QzoneClient, phase: string): Promise<boolean> {
        this.#assertOpen()
        try {
            await this.#rebind.attempt(async () => {
                const { cookies, accountId } = await this.#acquire()
                this.#assertOpen()
                await client.updateSession({ cookies, accountId })
            })
            return true
        } catch (error) {
            this.#assertOpen()
            if (error instanceof RebindRejectedError) {
                this.#deps.logger.warn(`续绑被拒绝（${phase}）：${error.message}`)
            } else {
                this.#deps.logger.warn(`续绑失败（${phase}），连续失败 ${this.#rebind.stats().consecutiveFailures} 次`)
            }
            return false
        }
    }
}
