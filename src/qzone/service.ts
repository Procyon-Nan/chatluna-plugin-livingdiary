import type { Context } from 'cordis'
import { QzoneClient } from 'qzone-sdk'
import type { Config } from '../config.js'
import { acquireQzoneCookies, canonicalQQ, NoBotAvailableError, selectCookieBot } from './cookie-source.js'
import { QzoneManager } from './manager.js'

type QzoneConfig = Pick<Config, 'platform' | 'selfId' | 'debug' | 'rebindMinIntervalSeconds' | 'rebindBackoffSeconds' | 'rebindMaxConsecutiveFailures'>

export function createQzoneService(ctx: Context, config: QzoneConfig) {
    let boundSelfId = config.selfId
    const currentBot = () => selectCookieBot(ctx.satori.bots, config.platform, boundSelfId)
    return new QzoneManager({
        currentBot,
        acquire: () => {
            const bot = currentBot()
            if (!bot) throw new NoBotAvailableError('未找到与 platform/selfId 匹配的在线 OneBot/Milky 机器人')
            return acquireQzoneCookies(bot)
        },
        createClient: (session, observe) => {
            const client = new QzoneClient({
                session,
                logger(event) {
                    observe?.(event)
                    if (config.debug && event.phase === 'read.fallback') {
                        const what = event.endpoint?.startsWith('post.detail') ? '动态详情' : '动态列表'
                        ctx.logger.info(`事件：读取${what}失败，切换接口继续读取`)
                    }
                }
            })
            boundSelfId = canonicalQQ(session.accountId)
            return client
        },
        logger: ctx.logger,
        rebind: {
            minIntervalSeconds: config.rebindMinIntervalSeconds,
            backoffSeconds: config.rebindBackoffSeconds,
            maxBackoffSeconds: 300,
            maxConsecutiveFailures: config.rebindMaxConsecutiveFailures
        }
    })
}

export type QzoneService = ReturnType<typeof createQzoneService>
export type LivingDiaryStatus = ReturnType<QzoneService['status']>
