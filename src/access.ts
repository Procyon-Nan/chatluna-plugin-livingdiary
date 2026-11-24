import type { ToolCallContext } from '@chatluna/tool'

export function isUserAllowed(userId: string | undefined, allowed: readonly string[], platform: string | undefined): boolean {
    return (platform === 'onebot' || platform === 'milky' || platform === 'qq') &&
        userId !== undefined && allowed.includes(userId)
}

/** 只接受本轮唤醒机器人的聊天用户，工具获准代行的身份不能替代请求者。 */
export function requireRequester(call: ToolCallContext, allowed: readonly string[]) {
    const principal = call.principal
    const subject = principal?.subject
    if (principal?.source !== 'chat' || principal.wakingPrincipals.length !== 1 || !subject ||
        !isUserAllowed(subject.user, allowed, subject.platform) ||
        (call.actor && (call.actor.user !== subject.user ||
            (call.actor.platform !== undefined && call.actor.platform !== subject.platform)))) {
        throw new Error('仅允许白名单中的 QQ 用户为本人请求此操作。')
    }
}
