import * as React from 'react'

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** 自动翻页和时间轴共用连续进度；手动拖动时由滚动位置驱动书页。 */
export function useDiaryTimeline(pages: string[], initial: number) {
    const book = React.useRef<HTMLDivElement>(null)
    const rail = React.useRef<HTMLElement>(null)
    const stage = React.useRef<HTMLDivElement>(null)
    const [position, setPosition] = React.useState({ left: initial, right: initial, current: initial })
    const selectedPage = React.useRef(pages[initial])
    const frame = React.useRef(0)
    const target = React.useRef(0)
    const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined)
    const touching = React.useRef(false)
    const step = () => rail.current!.querySelector('button')!.offsetWidth

    function stop() {
        clearTimeout(timer.current)
        cancelAnimationFrame(frame.current)
        frame.current = 0
    }
    function glide(to: number) {
        const node = rail.current!
        target.current = Math.max(0, Math.min(to, node.scrollWidth - node.clientWidth))
        if (reduceMotion()) {
            stop()
            node.scrollLeft = target.current
            showPageAt(node.scrollLeft / step())
            return
        }
        if (frame.current || node.scrollLeft === target.current) return

        // 临界阻尼：起页时逐渐加速，落页时减速；继续滚动只移动目标，不从头播放。
        const pageWidth = step()
        let offset = node.scrollLeft, velocity = 0, last = performance.now()
        function tick(now: number) {
            const dt = Math.min(48, now - last) / 1000
            last = now
            const gap = offset - target.current
            const rate = 7
            const carry = velocity + rate * gap
            const decay = Math.exp(-rate * dt)
            offset = target.current + (gap + carry * dt) * decay
            velocity = (velocity - rate * carry * dt) * decay
            const settled = Math.abs(offset - target.current) < .02 && Math.abs(velocity) < 4
            if (settled) offset = target.current
            node.scrollLeft = offset
            showPageAt(offset / pageWidth)
            frame.current = settled ? 0 : requestAnimationFrame(tick)
        }
        frame.current = requestAnimationFrame(tick)
    }
    function snapSoon() {
        clearTimeout(timer.current)
        if (touching.current) return
        timer.current = setTimeout(() => {
            const offset = frame.current ? target.current : rail.current!.scrollLeft
            const pageWidth = step()
            glide(Math.round(offset / pageWidth) * pageWidth)
        }, 110)
    }
    function goTo(index: number) {
        clearTimeout(timer.current)
        glide(index * step())
    }
    function showPageAt(page: number) {
        const value = Math.max(0, Math.min(pages.length - 1, page))
        const left = Math.floor(value), right = Math.ceil(value), current = Math.round(value)
        stage.current!.style.setProperty('--page-position', String(value))
        selectedPage.current = pages[current]
        setPosition(prev => prev.left === left && prev.right === right && prev.current === current ? prev : { left, right, current })
    }
    function sync() {
        if (frame.current) return
        showPageAt(rail.current!.scrollLeft / step())
        snapSoon()
    }
    React.useLayoutEffect(() => {
        stop()
        const selected = pages.indexOf(selectedPage.current!)
        const index = selected < 0 ? initial : selected
        rail.current!.scrollLeft = index * step()
        showPageAt(index)
        return stop
    }, [pages, initial])

    const onWheel = React.useEffectEvent((event: WheelEvent) => {
        if (event.ctrlKey) return
        const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        const text = (event.target as Element).closest('.ld-writing')
        if (!horizontal && text && text.scrollHeight > text.clientHeight + 1) return
        event.preventDefault()
        const unit = event.deltaMode === 1 ? 16 : 1
        const raw = horizontal ? event.deltaX : event.deltaY
        // 纵向滚轮用来选日期；横向触控板仍跟手。按页滚动一次对应一个日期刻度。
        const distance = event.deltaMode === 2 ? raw * step() : raw * unit * (horizontal ? 1 : 0.5)
        const offset = frame.current ? target.current : rail.current!.scrollLeft
        glide(offset + distance)
        snapSoon()
    })
    React.useEffect(() => {
        const node = book.current!
        node.addEventListener('wheel', onWheel, { passive: false })
        return () => node.removeEventListener('wheel', onWheel)
    }, [])

    function touchStart() {
        stop()
        touching.current = true
        sync()
    }
    function touchEnd() { touching.current = false; snapSoon() }
    return { book, rail, stage, position, goTo, sync, touchStart, touchEnd }
}
