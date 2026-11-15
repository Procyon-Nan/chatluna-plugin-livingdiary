import type { Context } from 'cordis'
import { QzoneClient, type QzoneLogEvent } from 'qzone-sdk'
import type { Config } from '../config.js'
import { acquireQzoneCookies, canonicalQQ, NoBotAvailableError, selectCookieBot } from './cookie-source.js'
import { QzoneManager } from './manager.js'

type QzoneConfig = Pick<Config, 'platform' | 'selfId' | 'debug' | 'rebindMinIntervalSeconds' | 'rebindBackoffSeconds' | 'rebindMaxConsecutiveFailures'>

const readTargets: Record<string, string> = {
    'feed.profile': '个人主页动态',
    'feed.index': '好友动态',
    'post.detail.legacy': '动态详情'
}

const readErrors: Record<string, string> = {
    QZONE_PARSE: '无法解析接口响应',
    QZONE_PERMISSION: '访问权限不足',
    QZONE_RATE_LIMIT: '请求频率受限',
    QZONE_REQUEST: '接口请求失败'
}

function fallbackMessage({ endpoint = '', errorCode = '接口异常', statusCode = 0 }: QzoneLogEvent): string {
    const target = readTargets[endpoint] ?? '空间动态'
    const reason = statusCode >= 300 && statusCode < 400
        ? '接口返回重定向'
        : readErrors[errorCode] ?? errorCode
    const status = statusCode ? `（HTTP ${statusCode}）` : ''
    return `事件：读取${target}时${reason}${status}，改用备用接口`
}

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
                        ctx.logger.info(fallbackMessage(event))
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
