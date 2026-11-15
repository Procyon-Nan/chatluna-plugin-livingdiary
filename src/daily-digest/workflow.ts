import type { Context } from 'cordis'
import type { QzoneManager } from '../qzone/manager.js'
import type { DiaryJournal } from '../journal/repository.js'
import { readableError } from '../publishing/publish.js'
import { decideDigest } from './model.js'
import { renderPersona } from '../persona.js'
import { buildDigestPrompts, formatMemoryLines, type DigestMemoryEntry } from './prompt.js'
import { dailyDigestResultLabels, type DailyDigestReport, type DailyDigestResult, type DailyDigestTrigger } from './report.js'

export interface DigestSettings {
    presetId: string
    model: string
    memoryLimit: number
    publishDiaryToQzone: boolean
    debug?: boolean
}

/** LivingMemory 的插件根入口未导出服务类型；只描述本插件使用的公共读方法。 */
interface MemoryReader {
    repository: {
        listEntriesByPreset(presetId: string): Promise<readonly (DigestMemoryEntry & { status: 'active' | 'archived' })[]>
    }
}

export async function runDailyDigest(ctx: Context, qzone: Pick<QzoneManager, 'publishDiary'>,
    journal: Pick<DiaryJournal, 'save' | 'beginPublication' | 'finishPublication'>, settings: DigestSettings,
    trigger: DailyDigestTrigger, signal: AbortSignal, startedAt = new Date()): Promise<DailyDigestReport> {
    signal.throwIfAborted()
    const report = (result: DailyDigestResult, detail = ''): DailyDigestReport => {
        let level: 'info' | 'warn' | 'error' = 'info'
        if (result === 'failed' || result === 'model-failed' || result === 'publish-failed') level = 'error'
        else if (result === 'preset-missing') level = 'warn'
        ctx.logger[level]('每日日记：%s（%s）：%s', settings.presetId, trigger === 'scheduled' ? '定时' : '手动', detail || dailyDigestResultLabels[result])
        return { triggeredAt: startedAt.toISOString(), trigger, result, detail }
    }
    const preset = ctx.presets.get(settings.presetId)
    if (!preset || preset.status === 'error') return report('preset-missing', '配置的空间预设不存在或无法加载。')

    const midnight = new Date(startedAt)
    midnight.setHours(0, 0, 0, 0)
    let memories: DigestMemoryEntry[]
    try {
        const memory: MemoryReader = ctx.get('livingmemory')
        const rows = await memory.repository.listEntriesByPreset(preset.id)
        signal.throwIfAborted()
        memories = rows.filter(row => row.status === 'active' && row.createdAt >= midnight && row.createdAt <= startedAt)
            .sort((a, b) => +a.createdAt - +b.createdAt).slice(-settings.memoryLimit)
    } catch {
        signal.throwIfAborted()
        return report('failed', '读取当日记忆失败。')
    }
    if (!memories.length) return report('skipped-empty', '当日无记忆。')

    let persona: string
    try { persona = await renderPersona(ctx, preset, startedAt) }
    catch {
        signal.throwIfAborted()
        return report('preset-missing', '无法渲染空间预设的人设。')
    }
    signal.throwIfAborted()
    if (!persona) return report('preset-missing', '空间预设的人设为空。')
    const prompts = buildDigestPrompts({
        assistantLabel: preset.name, persona, memoryCount: memories.length, memoryLines: formatMemoryLines(memories),
        dateText: startedAt.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    })
    const referenceMemories = memories.map(({ id, content }) => ({ id, content }))
    let content: string
    try {
        const decision = await decideDigest(ctx, settings.model, prompts, signal, settings.debug ?? false)
        signal.throwIfAborted()
        if (decision.action === 'skip') return report('skipped-by-model', '模型决定跳过本次写作。')
        content = decision.content
    } catch (error) {
        signal.throwIfAborted()
        return report('model-failed', (error as Error).message)
    }
    let id: string
    try {
        id = await journal.save({ presetId: preset.id, presetName: preset.name, content, memories: referenceMemories }, startedAt)
    } catch (error) {
        ctx.logger.error('保存日记失败：%s', error)
        return report('failed', '保存日记失败。')
    }
    if (!settings.publishDiaryToQzone) return report('saved')
    signal.throwIfAborted()
    try {
        await journal.beginPublication(id)
    } catch (error) {
        ctx.logger.error('记录日记 %s 的发布尝试失败：%s', id, error)
        return report('failed', '日记已保存，记录发布尝试失败。')
    }
    let verified = false
    let detail = '日记发布结果核验失败。'
    try {
        verified = await qzone.publishDiary({ content, signal })
        if (verified) detail = '已按回执中的动态 ID 核实发布结果。'
    } catch (error) {
        detail = readableError(error, '发布每日动态失败')
    }
    try {
        await journal.finishPublication(id, verified)
    } catch (error) {
        ctx.logger.error('更新日记 %s 的发布状态失败：%s', id, error)
        detail += ' 更新本地发布状态失败。'
    }
    if (!verified) signal.throwIfAborted()
    return report(verified ? 'published' : 'publish-failed', detail)
}
