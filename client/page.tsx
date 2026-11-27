import * as React from 'react'
import { useConnection, useLive, useTranslate } from '@chatluna/ui-client/client'
import { Alert, Button, EmptyState, Skeleton, Tabs, TabsList, TabsTrigger } from '@chatluna/ui-kit'
import { Journal } from './journal.tsx'
import { Settings } from './settings.tsx'
import { Guide } from './guide.tsx'

const tabs = ['journal', 'settings', 'guide'] as const
type Tab = (typeof tabs)[number]

export function LivingDiaryPage() {
    const t = useTranslate('livingdiary')
    const connection = useConnection()
    const [tab, setTab] = React.useState<Tab>('journal')
    const presets = useLive('livingdiary.presets')
    const [selection, setSelection] = React.useState<string>()
    const preset = presets.data?.find(item => item.id === selection) ?? presets.data?.[0]
    const panel = React.useRef<HTMLElement>(null)

    React.useLayoutEffect(() => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
        const animation = panel.current?.animate(
            [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
            { duration: 150, easing: 'ease-out' }
        )
        return () => animation?.cancel()
    }, [tab])

    return (
        <div className="ld-page flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
            <header className="border-b border-border">
                <Tabs value={tab} onValueChange={value => setTab(value as Tab)} aria-label="LivingDiary" className="min-w-0 gap-0">
                    <TabsList variant="line" activateOnFocus className="h-auto max-w-full justify-start overflow-x-auto">
                        {tabs.map(key => <TabsTrigger key={key} value={key} className="flex-none px-2 py-2 text-sm">
                            {t(`tab.${key}`)}
                        </TabsTrigger>)}
                    </TabsList>
                </Tabs>
            </header>
            <section ref={panel} aria-label={t(`tab.${tab}`)} className="flex min-h-0 min-w-0 flex-1 flex-col">
                {connection.state === 'offline' && tab !== 'guide' && <Alert className="mb-4">{t('offline')}</Alert>}
                <React.Activity mode={tab === 'journal' ? 'visible' : 'hidden'}>
                    {presets.error ? <Alert variant="destructive">{presets.error}</Alert> : null}
                    {!presets.error && !presets.data && <Skeleton className="h-32 w-full" />}
                    {!presets.error && presets.data && !preset && <EmptyState title={t('journal.noPreset')} hint={t('journal.noPresetHint')}
                        actions={<Button variant="outline" onClick={() => setTab('settings')}>{t('guide.openSettings')}</Button>} />}
                    {!presets.error && presets.data && preset && <Journal key={preset.id} preset={preset} presets={presets.data} onSelect={setSelection} />}
                </React.Activity>
                <React.Activity mode={tab === 'settings' ? 'visible' : 'hidden'}>
                    <Settings />
                </React.Activity>
                {tab === 'guide' && <Guide openSettings={() => setTab('settings')} />}
            </section>
        </div>
    )
}
