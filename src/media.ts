export type MediaKind = 'image' | 'video'
export const mediaLabels = { image: '图片', video: '视频' } as const
export class MediaReadError extends Error {}

export function checkMediaSize(size: number, maxBytes: number, kind: MediaKind) {
    if (size === 0) throw new MediaReadError(`${mediaLabels[kind]}内容为空。`)
    if (size > maxBytes) throw new MediaReadError(`${mediaLabels[kind]}大小超过读取上限。`)
}

export interface MediaReadPolicy {
    remainingBytes: number
    allowUrl(url: URL): boolean
}

async function mediaResponse(url: URL, kind: MediaKind, signal: AbortSignal, policy?: MediaReadPolicy) {
    const label = mediaLabels[kind]
    const headers = { accept: `${kind}/*,*/*` }
    if (!policy) return fetch(url, { headers, signal })
    if (policy.remainingBytes <= 0) throw new MediaReadError(`动态${label}总大小超过读取上限。`)
    for (let redirects = 0; redirects <= 5; redirects++) {
        if (!policy.allowUrl(url)) throw new MediaReadError(`${label}地址不属于受支持的 QQ 空间${label}域名。`)
        const response = await fetch(url, { headers, signal, redirect: 'manual' })
        if (![301, 302, 303, 307, 308].includes(response.status)) return response
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location) throw new MediaReadError(`${label}重定向缺少地址。`)
        url = new URL(location, url)
    }
    throw new MediaReadError(`${label}重定向次数超过上限。`)
}

export async function downloadMediaBytes(url: URL, kind: MediaKind, maxBytes: number, signal?: AbortSignal, policy?: MediaReadPolicy): Promise<Buffer> {
    const label = mediaLabels[kind]
    const timeout = AbortSignal.timeout(kind === 'video' ? 120_000 : 30_000)
    try {
        const response = await mediaResponse(url, kind, signal ? AbortSignal.any([signal, timeout]) : timeout, policy)
        if (!response.ok || !response.body) {
            await response.body?.cancel()
            if (response.status === 404) throw new MediaReadError(`${label}地址已过期，请改用较新的地址。`)
            throw new MediaReadError(`${label}下载失败（HTTP ${response.status}）。`)
        }
        const chunks: Uint8Array[] = []
        let size = 0
        const limit = Math.min(maxBytes, policy?.remainingBytes ?? maxBytes)
        const length = response.headers.get('content-length')
        if (length !== null && Number(length) > limit) {
            await response.body.cancel()
            throw new MediaReadError(`${label}大小超过读取上限。`)
        }
        for await (const chunk of response.body) {
            if (policy) policy.remainingBytes = Math.max(0, policy.remainingBytes - chunk.byteLength)
            size += chunk.byteLength
            checkMediaSize(size, limit, kind)
            chunks.push(chunk)
        }
        checkMediaSize(size, maxBytes, kind)
        return Buffer.concat(chunks, size)
    } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof MediaReadError) throw error
        // 平台媒体 URL 常含访问令牌，不透传底层异常。
        throw new MediaReadError(`${label}下载失败（网络错误或超时）。`)
    }
}
