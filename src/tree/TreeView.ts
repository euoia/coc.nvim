import { Neovim } from '@chemzqm/neovim'
import { CancellationTokenSource, Disposable, Emitter, Event, MarkupContent, MarkupKind, Range } from 'vscode-languageserver-protocol'
import commandManager from '../commands'
import events from '../events'
import FloatFactory from '../model/floatFactory'
import { ConfigurationChangeEvent, Documentation, HighlightItem } from '../types'
import { disposeAll } from '../util'
import { Mutex } from '../util/mutex'
import { equals } from '../util/object'
import { byteLength, byteSlice } from '../util/string'
import { hasMatch, positions, score, groupPositions } from '../util/fzy'
import workspace from '../workspace'
import window from '../window'
import Filter, { sessionKey } from './filter'
import { TreeDataProvider, TreeView, TreeViewExpansionEvent, TreeViewOptions, TreeViewSelectionChangeEvent, TreeViewVisibilityChangeEvent } from './index'
import { TreeItem, TreeItemCollapsibleState, TreeItemLabel } from './TreeItem'
import Menu from '../model/menu'
const logger = require('../util/logger')('BasicTreeView')
const highlightNamespace = 'tree'
const signOffset = 3000
let globalId = 1

interface TreeViewConfig {
  openedIcon: string
  closedIcon: string
}

interface RenderedItem<T> {
  line: string
  level: number
  node: T
}

interface ExtendedItem<T> extends RenderedItem<T> {
  index: number
  score: number
  highlights: HighlightItem[]
}

interface LineState {
  /**
   * Line count used by message
   */
  messageCount: number
  /**
   * Line count used by title
   */
  titleCount: number
}

interface Keys {
  invoke: string
  toggle: string
  actions: string
  collapseAll: string
  toggleSelection: string
  close: string
  activeFilter: string
  selectNext: string
  selectPrevious: string
}

interface TreeItemData {
  item: TreeItem
  resolved: boolean
}

/**
 * Basic TreeView implementation
 */
export default class BasicTreeView<T> implements TreeView<T> {
  // Resolved TreeItems
  private bufnr: number | undefined
  private winid: number | undefined
  private config: TreeViewConfig
  private keys: Keys
  private _creating: boolean
  private _selection: T[] = []
  private _onDidExpandElement = new Emitter<TreeViewExpansionEvent<T>>()
  private _onDidCollapseElement = new Emitter<TreeViewExpansionEvent<T>>()
  private _onDidChangeSelection = new Emitter<TreeViewSelectionChangeEvent<T>>()
  private _onDidChangeVisibility = new Emitter<TreeViewVisibilityChangeEvent>()
  public onDidExpandElement: Event<TreeViewExpansionEvent<T>> = this._onDidExpandElement.event
  public onDidCollapseElement: Event<TreeViewExpansionEvent<T>> = this._onDidCollapseElement.event
  public onDidChangeSelection: Event<TreeViewSelectionChangeEvent<T>> = this._onDidChangeSelection.event
  public onDidChangeVisibility: Event<TreeViewVisibilityChangeEvent> = this._onDidChangeVisibility.event
  public message: string | undefined
  public title: string
  public description: string | undefined
  private retryTimers = 0
  private renderedItems: RenderedItem<T>[] = []
  private provider: TreeDataProvider<T>
  private nodesMap: Map<T, TreeItemData> = new Map()
  private mutex: Mutex = new Mutex()
  private timer: NodeJS.Timer
  private disposables: Disposable[] = []
  private tooltipFactory: FloatFactory
  private resolveTokenSource: CancellationTokenSource | undefined
  private lineState: LineState = { titleCount: 0, messageCount: 0 }
  private filter: Filter<T>
  private filterText: string | undefined
  private itemsToFilter: T[] | undefined
  private readonly canSelectMany: boolean
  private readonly leafIndent: boolean
  private readonly winfixwidth: boolean
  private readonly enableFilter: boolean
  constructor(private viewId: string, private opts: TreeViewOptions<T>) {
    this.loadConfiguration()
    workspace.onDidChangeConfiguration(this.loadConfiguration, this, this.disposables)
    this.enableFilter = opts.enableFilter == true
    this.filter = new Filter(this.nvim, [this.keys.selectNext, this.keys.selectPrevious, this.keys.invoke])
    this.tooltipFactory = new FloatFactory(workspace.nvim)
    this.canSelectMany = !!opts.canSelectMany
    this.provider = opts.treeDataProvider
    this.leafIndent = opts.disableLeafIndent !== true
    this.winfixwidth = opts.winfixwidth !== false
    let message: string | undefined
    Object.defineProperty(this, 'message', {
      set: (msg: string | undefined) => {
        message = msg ? msg.replace(/\r?\n/g, ' ') : undefined
        this.updateHeadLines()
      },
      get: () => {
        return message
      }
    })
    let title = viewId.replace(/\r?\n/g, ' ')
    Object.defineProperty(this, 'title', {
      set: (newTitle: string) => {
        title = newTitle ? newTitle.replace(/\r?\n/g, ' ') : undefined
        this.updateHeadLines()
      },
      get: () => {
        return title
      }
    })
    let description: string | undefined
    Object.defineProperty(this, 'description', {
      set: (desc: string | undefined) => {
        description = desc ? desc.replace(/\r?\n/g, ' ') : undefined
        this.updateHeadLines()
      },
      get: () => {
        return description
      }
    })
    let filterText: string | undefined
    Object.defineProperty(this, 'filterText', {
      set: (text: string | undefined) => {
        let { titleCount, messageCount } = this.lineState
        let start = titleCount + messageCount
        if (text != null) {
          let highlights: HighlightItem[] = [{
            lnum: start,
            colStart: byteLength(text),
            colEnd: byteLength(text) + 1,
            hlGroup: 'Cursor'
          }]
          this.renderedItems = []
          this.updateUI([text + ' '], highlights, start, -1, true)
          void this.doFilter(text)
        } else if (filterText != null) {
          this.updateUI([], [], start, start + 1)
        }
        filterText = text
      },
      get: () => {
        return filterText
      }
    })
    this.provider.onDidChangeTreeData(this.onDataChange, this, this.disposables)
    events.on('BufUnload', bufnr => {
      if (bufnr != this.bufnr) return
      this.winid = undefined
      this.bufnr = undefined
      this._onDidChangeVisibility.fire({ visible: false })
      this.dispose()
    }, null, this.disposables)
    events.on('CursorHold', async bufnr => {
      if (bufnr != this.bufnr) return
      await this.onHover()
    }, null, this.disposables)
    events.on(['CursorMoved', 'BufEnter'], () => {
      this.cancelResolve()
    }, null, this.disposables)
    events.on('WinEnter', winid => {
      if (winid != this.windowId || !this.filter.activated) return
      let buf = this.nvim.createBuffer(this.bufnr)
      let line = this.startLnum - 1
      let len = this.filterText ? this.filterText.length : 0
      let range = Range.create(line, len, line, len + 1)
      buf.highlightRanges(highlightNamespace, 'Cursor', [range])
      this.nvim.call('coc#prompt#start_prompt', [sessionKey], true)
      this.redraw()
    }, null, this.disposables)
    events.on('WinLeave', winid => {
      if (winid != this.windowId || !this.filter.activated) return
      let buf = this.nvim.createBuffer(this.bufnr)
      this.nvim.call('coc#prompt#stop_prompt', [sessionKey], true)
      buf.clearNamespace(highlightNamespace, this.startLnum - 1, this.startLnum)
    }, null, this.disposables)
    this.disposables.push(this._onDidChangeVisibility, this._onDidChangeSelection, this._onDidCollapseElement, this._onDidExpandElement)
    this.filter.onDidExit(node => {
      this.nodesMap.clear()
      this.filterText = undefined
      this.itemsToFilter = undefined
      if (node && typeof this.provider.getParent === 'function') {
        this.renderedItems = []
        void this.reveal(node, { focus: true })
      } else {
        this.clearSelection()
        void this.render()
      }
    })
    this.filter.onDidUpdate(text => {
      this.filterText = text
    })
    this.filter.onDidKeyPress(async character => {
      let items = this.renderedItems
      if (!items?.length) return
      let curr = this.selection[0]
      if (character == '<up>' || character == this.keys.selectPrevious) {
        let idx = items.findIndex(o => o.node == curr)
        let index = idx == -1 || idx == 0 ? items.length - 1 : idx - 1
        let node = items[index]?.node
        if (node) this.selectItem(node, true)
      }
      if (character == '<down>' || character == this.keys.selectNext) {
        let idx = items.findIndex(o => o.node == curr)
        let index = idx == -1 || idx == items.length - 1 ? 0 : idx + 1
        let node = items[index]?.node
        if (node) this.selectItem(node, true)
      }
      if (character == '<cr>' || character == this.keys.invoke) {
        if (!curr) return
        await this.invokeCommand(curr)
        this.filter.deactivate(curr)
      }
    })
  }

  public get windowId(): number | undefined {
    return this.winid
  }

  private get startLnum(): number {
    let filterCount = this.filterText == null ? 0 : 1
    return this.lineState.messageCount + this.lineState.titleCount + filterCount
  }

  private get nvim(): Neovim {
    return workspace.nvim
  }

  private loadConfiguration(e?: ConfigurationChangeEvent): void {
    if (!e || e.affectsConfiguration('tree')) {
      let config = workspace.getConfiguration('tree')
      this.config = {
        openedIcon: config.get('openedIcon', ' '),
        closedIcon: config.get('closedIcon', ' ')
      }
      this.keys = {
        close: config.get<string>('key.close'),
        invoke: config.get<string>('key.invoke'),
        toggle: config.get<string>('key.toggle'),
        actions: config.get<string>('key.actions'),
        collapseAll: config.get<string>('key.collapseAll'),
        toggleSelection: config.get<string>('key.toggleSelection'),
        activeFilter: config.get<string>('key.activeFilter'),
        selectNext: config.get<string>('key.selectNext'),
        selectPrevious: config.get<string>('key.selectPrevious')
      }
      if (e) {
        void this.render()
      }
    }
  }

  private async doFilter(text: string): Promise<void> {
    let items: ExtendedItem<T>[] = []
    let index = 0
    let release = await this.mutex.acquire()
    try {
      if (!this.itemsToFilter) {
        let itemsToFilter: T[] = []
        const addNodes = async (nodes: T[]): Promise<void> => {
          for (let n of nodes) {
            itemsToFilter.push(n)
            let arr = await Promise.resolve(this.provider.getChildren(n))
            if (arr?.length) await addNodes(arr)
          }
        }
        let nodes = await Promise.resolve(this.provider.getChildren())
        await addNodes(nodes)
        this.itemsToFilter = itemsToFilter
      }
      for (let n of this.itemsToFilter) {
        let item = await this.getTreeItem(n)
        let label = TreeItemLabel.is(item.label) ? item.label.label : item.label
        if (!text || hasMatch(text, label)) {
          let idxs = text ? positions(text, label) : []
          item.collapsibleState = TreeItemCollapsibleState.None
          item.label = { label, highlights: text ? groupPositions(idxs) : [] }
          let { line, highlights } = this.getRenderedLine(item, index, 0)
          items.push({
            level: 0,
            node: n,
            line,
            index,
            score: text ? score(text, label) : 0,
            highlights
          })
          index += 1
        }
      }
      items.sort((a, b) => {
        if (a.score != b.score) return b.score - a.score
        return a.index - b.index
      })
      let lnum = this.startLnum
      let highlights: HighlightItem[] = []
      let renderedItems = this.renderedItems = items.map((o, idx) => {
        highlights.push(...o.highlights.map(h => {
          h.lnum = lnum + idx
          return h
        }))
        delete o.index
        delete o.score
        delete o.highlights
        return o
      })
      this.updateUI(renderedItems.map(o => o.line), highlights, lnum, -1, true)
      if (renderedItems.length) {
        this.selectItem(renderedItems[0].node, true)
      } else {
        this.clearSelection()
      }
      this.redraw()
      release()
    } catch (e) {
      release()
      logger.error(`Error on tree filter: ${e.message}`, e)
    }
  }

  private async onHover(): Promise<void> {
    let { nvim } = this
    let lnum = await nvim.call('line', ['.'])
    let element = this.getElementByLnum(lnum - 1)
    if (!element) return
    let obj = this.nodesMap.get(element)
    if (!obj) return
    let item = obj.item
    if (!obj.resolved) {
      item = await this.resolveItem(element, item)
      if (!item) return
    }
    if (!item.tooltip || !this.bufnr) return
    let isMarkdown = MarkupContent.is(item.tooltip) && item.tooltip.kind == MarkupKind.Markdown
    let doc: Documentation = {
      filetype: isMarkdown ? 'markdown' : 'txt',
      content: MarkupContent.is(item.tooltip) ? item.tooltip.value : item.tooltip
    }
    await this.tooltipFactory.show([doc], { modes: ['n'] })
  }

  private async onClick(element: T): Promise<void> {
    let { nvim } = this
    let [line, col] = await nvim.eval(`[getline('.'),col('.')]`) as [string, number]
    let pre = byteSlice(line, 0, col - 1)
    let character = line[pre.length]
    if (!character) return
    let { openedIcon, closedIcon } = this.config
    if (/^\s*$/.test(pre) && [openedIcon, closedIcon].includes(character)) {
      await this.toggleExpand(element)
    } else {
      await this.invokeCommand(element)
    }
  }

  private async invokeCommand(element: T): Promise<void> {
    let obj = this.nodesMap.get(element)
    if (!obj) return
    this.selectItem(element)
    let item = obj.item
    if (!obj.resolved && !item.command) {
      item = await this.resolveItem(element, item)
      if (!item) return
    }
    if (!item.command) throw new Error(`Failed to resolve command from TreeItem.`)
    await commandManager.execute(item.command)
  }

  private async invokeActions(element: T, selection?: T[]): Promise<void> {
    this.selectItem(element)
    let actions = this.opts.actions
    if (!actions) {
      await window.showWarningMessage('No actions available')
      return
    }
    let keys = Object.keys(actions)
    let res = await window.showMenuPicker(keys, 'Choose action')
    if (res == -1) return
    await Promise.resolve(actions[keys[res]](element, selection))
  }

  private async onDataChange(node: T | undefined): Promise<void> {
    if (this.filter.activated) {
      this.itemsToFilter = undefined
      await this.doFilter(this.filterText)
      return
    }
    this.clearSelection()
    if (!node) {
      await this.render()
      return
    }
    let release = await this.mutex.acquire()
    try {
      let items = this.renderedItems
      let idx = items.findIndex(o => o.node === node)
      if (idx != -1 && this.bufnr) {
        let obj = items[idx]
        let level = obj.level
        let removeCount = 0
        for (let i = idx; i < items.length; i++) {
          let o = items[i]
          if (i == idx || o && o.level > level) {
            removeCount += 1
          }
        }
        let appendItems: RenderedItem<T>[] = []
        let highlights: HighlightItem[] = []
        let start = idx + this.startLnum
        await this.appendTreeNode(node, level, start, appendItems, highlights)
        items.splice(idx, removeCount, ...appendItems)
        this.updateUI(appendItems.map(o => o.line), highlights, start, start + removeCount)
      }
      release()
    } catch (e) {
      let errMsg = `Error on tree refresh: ${e.message}`
      logger.error(errMsg, e)
      this.nvim.errWriteLine('[coc.nvim] ' + errMsg)
      release()
    }
  }

  private async resolveItem(element: T, item: TreeItem): Promise<TreeItem | undefined> {
    if (typeof this.provider.resolveTreeItem === 'function') {
      let tokenSource = this.resolveTokenSource = new CancellationTokenSource()
      let token = tokenSource.token
      item = await Promise.resolve(this.provider.resolveTreeItem(item, element, token))
      tokenSource.dispose()
      this.resolveTokenSource = undefined
      if (token.isCancellationRequested) return undefined
    }
    this.nodesMap.set(element, { item, resolved: true })
    return item
  }

  public get visible(): boolean {
    return this.winid != null
  }

  public get selection(): T[] {
    return this._selection.slice()
  }

  public async checkLines(): Promise<boolean> {
    if (!this.bufnr) return
    let buf = this.nvim.createBuffer(this.bufnr)
    let curr = await buf.lines
    let { titleCount, messageCount } = this.lineState
    curr = curr.slice(titleCount + messageCount)
    let lines = this.renderedItems.map(o => o.line)
    return equals(curr, lines)
  }

  /**
   * Expand/collapse TreeItem.
   */
  private async toggleExpand(element: T): Promise<void> {
    let o = this.nodesMap.get(element)
    if (!o) return
    let treeItem = o.item
    let lnum = this.getItemLnum(element)
    let nodeIdx = lnum - this.startLnum
    let obj = this.renderedItems[nodeIdx]
    if (!obj || treeItem.collapsibleState == TreeItemCollapsibleState.None) {
      if (typeof this.provider.getParent === 'function') {
        let node = await Promise.resolve(this.provider.getParent(element))
        if (node) {
          await this.toggleExpand(node)
          this.focusItem(node)
        }
      }
      return
    }
    // remove lines
    let removeCount = 0
    if (treeItem.collapsibleState == TreeItemCollapsibleState.Expanded) {
      let level = obj.level
      for (let i = nodeIdx + 1; i < this.renderedItems.length; i++) {
        let o = this.renderedItems[i]
        if (!o || o.level <= level) break
        removeCount += 1
      }
      treeItem.collapsibleState = TreeItemCollapsibleState.Collapsed
    } else if (treeItem.collapsibleState == TreeItemCollapsibleState.Collapsed) {
      treeItem.collapsibleState = TreeItemCollapsibleState.Expanded
    }
    let newItems: RenderedItem<T>[] = []
    let newHighlights: HighlightItem[] = []
    await this.appendTreeNode(obj.node, obj.level, lnum, newItems, newHighlights)
    this.renderedItems.splice(nodeIdx, removeCount + 1, ...newItems)
    this.updateUI(newItems.map(o => o.line), newHighlights, lnum, lnum + removeCount + 1)
    this.refreshSigns()
    if (treeItem.collapsibleState == TreeItemCollapsibleState.Collapsed) {
      this._onDidCollapseElement.fire({ element })
    } else {
      this._onDidExpandElement.fire({ element })
    }
  }

  private toggleSelection(element: T): void {
    let idx = this._selection.findIndex(o => o === element)
    if (idx !== -1) {
      this.unselectItem(idx)
    } else {
      this.selectItem(element)
    }
  }

  private clearSelection(): void {
    if (!this.bufnr) return
    this._selection = []
    let buf = this.nvim.createBuffer(this.bufnr)
    buf.unplaceSign({ group: 'CocTree' })
    this._onDidChangeSelection.fire({ selection: [] })
  }

  private selectItem(item: T, forceSingle?: boolean, noRedraw?: boolean): void {
    let { nvim } = this
    if (!this.bufnr || !workspace.env.sign) return
    let row = this.getItemLnum(item)
    if (row == null) return
    let buf = nvim.createBuffer(this.bufnr)
    let exists = this._selection.includes(item)
    if (!this.canSelectMany || forceSingle) {
      this._selection = [item]
    } else if (!exists) {
      this._selection.push(item)
    }
    nvim.pauseNotification()
    if (!this.canSelectMany || forceSingle) {
      buf.unplaceSign({ group: 'CocTree' })
    }
    nvim.call('coc#compat#execute', [this.winid, `exe ${row + 1}`], true)
    buf.placeSign({ id: signOffset + row, lnum: row + 1, name: 'CocTreeSelected', group: 'CocTree' })
    if (!noRedraw) this.redraw()
    void nvim.resumeNotification(false, true)
    if (!exists) this._onDidChangeSelection.fire({ selection: this._selection })
  }

  private unselectItem(idx: number): void {
    let item = this._selection[idx]
    let row = this.getItemLnum(item)
    if (row == null || !this.bufnr || !workspace.env.sign) return
    this._selection.splice(idx, 1)
    let buf = this.nvim.createBuffer(this.bufnr)
    buf.unplaceSign({ group: 'CocTree', id: signOffset + row })
    this._onDidChangeSelection.fire({ selection: this._selection })
  }

  public focusItem(element: T): void {
    if (!this.winid) return
    let lnum = this.getItemLnum(element)
    if (lnum == null) return
    this.nvim.call('coc#compat#execute', [this.winid, `exe ${lnum + 1}`], true)
  }

  private getElementByLnum(lnum: number): T | undefined {
    let item = this.renderedItems[lnum - this.startLnum]
    return item ? item.node : undefined
  }

  private getItemLnum(item: T): number | undefined {
    let idx = this.renderedItems.findIndex(o => o.node === item)
    if (idx == -1) return undefined
    return this.startLnum + idx
  }

  private async getTreeItem(element: T): Promise<TreeItem> {
    let exists: TreeItem
    let resolved = false
    let obj = this.nodesMap.get(element)
    if (obj != null) {
      exists = obj.item
      resolved = obj.resolved
    }
    let item = await Promise.resolve(this.provider.getTreeItem(element))
    if (item.id && !exists) {
      for (let obj of this.nodesMap.values()) {
        if (obj.item.id === item.id) {
          resolved = obj.resolved
          exists = obj.item
          break
        }
      }
    }
    if (exists
      && exists.collapsibleState != TreeItemCollapsibleState.None
      && item.collapsibleState != TreeItemCollapsibleState.None) {
      item.collapsibleState = exists.collapsibleState
    }
    this.nodesMap.set(element, { item, resolved })
    return item
  }

  private getRenderedLine(treeItem: TreeItem, lnum: number, level: number): { line: string, highlights: HighlightItem[] } {
    let { openedIcon, closedIcon } = this.config
    const highlights: HighlightItem[] = []
    const { label, deprecated } = treeItem
    let prefix = '  '.repeat(level)
    const addHighlight = (text: string, hlGroup: string) => {
      let colStart = byteLength(prefix)
      highlights.push({
        lnum,
        hlGroup,
        colStart,
        colEnd: colStart + byteLength(text),
      })
    }
    switch (treeItem.collapsibleState) {
      case TreeItemCollapsibleState.Expanded: {
        addHighlight(openedIcon, 'CocTreeOpenClose')
        prefix += openedIcon + ' '
        break
      }
      case TreeItemCollapsibleState.Collapsed: {
        addHighlight(closedIcon, 'CocTreeOpenClose')
        prefix += closedIcon + ' '
        break
      }
      default:
        prefix += this.leafIndent ? '  ' : ''
    }
    if (treeItem.icon) {
      let { text, hlGroup } = treeItem.icon
      addHighlight(text, hlGroup)
      prefix += text + ' '
    }
    if (TreeItemLabel.is(label) && Array.isArray(label.highlights)) {
      let colStart = byteLength(prefix)
      for (let o of label.highlights) {
        highlights.push({
          lnum,
          hlGroup: 'Search',
          colStart: colStart + o[0],
          colEnd: colStart + o[1]
        })
      }
    }
    let labelText = typeof label === 'string' ? label : label.label
    if (deprecated) {
      addHighlight(labelText, 'CocDeprecatedHighlight')
    }
    prefix += labelText
    return { line: prefix, highlights }
  }

  private async appendTreeNode(element: T, level: number, lnum: number, items: RenderedItem<T>[], highlights: HighlightItem[]): Promise<number> {
    let takes = 1
    let treeItem = await this.getTreeItem(element)
    let children
    let res = this.getRenderedLine(treeItem, lnum, level)
    highlights.push(...res.highlights)
    items.push({ level, line: res.line, node: element })
    if (treeItem.collapsibleState == TreeItemCollapsibleState.Expanded) {
      let l = level + 1
      if (!children) {
        children = await Promise.resolve(this.provider.getChildren(element))
        children = children || []
      }
      for (let el of children) {
        let n = await this.appendTreeNode(el, l, lnum + takes, items, highlights)
        takes = takes + n
      }
    }
    return takes
  }

  private updateUI(lines: string[], highlights: HighlightItem[], start = 0, end = -1, noRedraw = false): void {
    if (!this.bufnr) return
    let { nvim } = this
    let buf = nvim.createBuffer(this.bufnr)
    nvim.pauseNotification()
    buf.setOption('modifiable', true, true)
    void buf.setLines(lines, { start, end, strictIndexing: false }, true)
    if (highlights.length) {
      let highlightEnd = end == -1 ? -1 : start + lines.length
      nvim.call('coc#highlight#update_highlights', [this.bufnr, highlightNamespace, highlights, start, highlightEnd], true)
    }
    buf.setOption('modifiable', false, true)
    if (!noRedraw) this.redraw()
    void nvim.resumeNotification(false, true)
  }

  public async reveal(element: T, options: { select?: boolean; focus?: boolean; expand?: number | boolean } = {}): Promise<void> {
    if (this.filter.activated) return
    let isShown = this.getItemLnum(element) != null
    let { select, focus, expand } = options
    let curr = element
    if (typeof this.provider.getParent !== 'function') {
      throw new Error('missing getParent function from provider for reveal.')
    }
    if (!isShown) {
      while (curr) {
        let parentNode = await Promise.resolve(this.provider.getParent(curr))
        if (parentNode) {
          let item = await this.getTreeItem(parentNode)
          item.collapsibleState = TreeItemCollapsibleState.Expanded
          curr = parentNode
        } else {
          break
        }
      }
    }
    if (expand) {
      let item = await this.getTreeItem(element)
      if (item.collapsibleState == TreeItemCollapsibleState.None) return
      item.collapsibleState = TreeItemCollapsibleState.Expanded
      if (typeof expand === 'number' && expand > 1) {
        let curr = Math.min(expand, 2)
        let nodes = await Promise.resolve(this.provider.getChildren(element))
        while (nodes?.length > 0) {
          let arr: T[] = []
          for (let n of nodes) {
            let item = await this.getTreeItem(n)
            if (item.collapsibleState == TreeItemCollapsibleState.None) continue
            item.collapsibleState = TreeItemCollapsibleState.Expanded
            if (curr > 1) {
              let res = await Promise.resolve(this.provider.getChildren(n))
              arr.push(...res)
            }
          }
          nodes = arr
          curr = curr - 1
        }
      }
    }
    if (!isShown || expand) {
      await this.render()
    }
    if (select !== false) this.selectItem(element)
    if (focus) this.focusItem(element)
  }

  private updateHeadLines(initialize = false): void {
    let { titleCount, messageCount } = this.lineState
    let end = initialize ? -1 : titleCount + messageCount
    let lines: string[] = []
    let highlights: HighlightItem[] = []
    try {
      if (this.message) {
        highlights.push({ hlGroup: 'MoreMsg', colStart: 0, colEnd: byteLength(this.message), lnum: 0 })
        lines.push(this.message)
        lines.push('')
      }
      if (this.title) {
        highlights.push({ hlGroup: 'CocTreeTitle', colStart: 0, colEnd: byteLength(this.title), lnum: lines.length })
        if (this.description) {
          let colStart = byteLength(this.title) + 1
          highlights.push({ hlGroup: 'Comment', colStart, colEnd: colStart + byteLength(this.description), lnum: lines.length })
        }
        lines.push(this.title + (this.description ? ' ' + this.description : ''))
      }
      this.lineState.messageCount = this.message ? 2 : 0
      this.lineState.titleCount = this.title ? 1 : 0
      this.updateUI(lines, highlights, 0, end)
      if (!initialize) {
        this.refreshSigns()
      }
    } catch (e) {
      this.nvim.errWriteLine('[coc.nvim] Error on update head lines:' + e.message)
      logger.error('Error on update head lines:', e)
    }
  }

  /**
   * Update signs after collapse/expand or head change
   */
  private refreshSigns(): void {
    let { selection, nvim, bufnr } = this
    if (!selection.length || !bufnr || !workspace.env.sign) return
    let buf = nvim.createBuffer(bufnr)
    nvim.pauseNotification()
    buf.unplaceSign({ group: 'CocTree' })
    for (let n of selection) {
      let row = this.getItemLnum(n)
      if (row == null) continue
      buf.placeSign({ id: signOffset + row, lnum: row + 1, name: 'CocTreeSelected', group: 'CocTree' })
    }
    void nvim.resumeNotification(false, true)
  }

  // Render all tree items
  private async render(): Promise<void> {
    if (!this.bufnr) return
    let release = await this.mutex.acquire()
    try {
      let lines: string[] = []
      let highlights: HighlightItem[] = []
      let { startLnum } = this
      let nodes = await Promise.resolve(this.provider.getChildren())
      let level = 0
      let lnum = startLnum
      let renderedItems: RenderedItem<T>[] = []
      for (let node of nodes || []) {
        let n = await this.appendTreeNode(node, level, lnum, renderedItems, highlights)
        lnum += n
      }
      lines.push(...renderedItems.map(o => o.line))
      this.renderedItems = renderedItems
      let delta = this.startLnum - startLnum
      if (delta) highlights.forEach(o => o.lnum = o.lnum + delta)
      this.updateUI(lines, highlights, this.startLnum, -1)
      this.retryTimers = 0
      release()
    } catch (e) {
      this.renderedItems = []
      this.nodesMap.clear()
      this.lineState = { titleCount: 0, messageCount: 1 }
      release()
      let errMsg = `${e.message}`.replace(/\r?\n/g, ' ')
      this.updateUI([errMsg], [{ hlGroup: 'WarningMsg', colStart: 0, colEnd: byteLength(errMsg), lnum: 0 }])
      if (this.retryTimers == 5) return
      this.timer = setTimeout(() => {
        this.retryTimers = this.retryTimers + 1
        void this.render()
      }, 500)
    }
  }

  public async show(splitCommand = 'belowright 30vs'): Promise<void> {
    if (this.bufnr || this._creating) return
    this._creating = true
    let { nvim } = this
    let winid = await nvim.call('coc#window#find', ['cocViewId', this.viewId])
    let id = globalId
    globalId = globalId + 1
    nvim.pauseNotification()
    nvim.call('coc#window#close', [winid], true)
    nvim.command(`silent keepalt ${splitCommand} +setl\\ buftype=nofile CocTree${id}`, true)
    nvim.command('setl bufhidden=wipe nolist nonumber norelativenumber foldcolumn=0', true)
    nvim.command(`setl signcolumn=${this.canSelectMany ? 'yes' : 'no'}${this.winfixwidth ? ' winfixwidth' : ''}`, true)
    nvim.command('setl nocursorline nobuflisted wrap undolevels=-1 filetype=coctree nomodifiable noswapfile', true)
    nvim.command(`let w:cocViewId = "${this.viewId.replace(/"/g, '\\"')}"`, true)
    nvim.call('bufnr', ['%'], true)
    nvim.call('win_getid', [], true)
    let res = await nvim.resumeNotification()
    if (res[1]) throw new Error(`Error on buffer create:` + JSON.stringify(res[1]))
    this._onDidChangeVisibility.fire({ visible: true })
    this.registerKeymaps()
    this.bufnr = res[0][6]
    this.winid = res[0][7]
    this._creating = false
    this.updateHeadLines(true)
    void this.render()
  }

  private registerKeymaps(): void {
    let { toggleSelection, actions, close, invoke, toggle, collapseAll, activeFilter } = this.keys
    let { nvim } = this
    const regist = (mode: 'n' | 'v' | 's' | 'x', key: string, fn: (element: T | undefined) => Promise<void>, notify = false) => {
      this.disposables.push(workspace.registerLocalKeymap(mode, key, async () => {
        let lnum = await nvim.call('line', ['.'])
        let element = this.getElementByLnum(lnum - 1)
        if (element && !this.nodesMap.has(element)) return
        await Promise.resolve(fn(element))
      }, notify))
    }
    regist('n', '<LeftRelease>', async element => {
      if (element) await this.onClick(element)
    })
    this.enableFilter && activeFilter && regist('n', activeFilter, async () => {
      this.nvim.command(`exe ${this.startLnum}`, true)
      this.filter.active()
      this.filterText = ''
    }, true)
    toggleSelection && regist('n', toggleSelection, async element => {
      if (element) this.toggleSelection(element)
    })
    invoke && regist('n', invoke, async element => {
      if (element) await this.invokeCommand(element)
    }, true)
    actions && regist('n', actions, async element => {
      if (element) await this.invokeActions(element, this.selection.length > 1 ? this.selection : undefined)
    }, true)
    toggle && regist('n', toggle, async element => {
      if (element) await this.toggleExpand(element)
    }, true)
    collapseAll && regist('n', collapseAll, async () => {
      for (let obj of this.nodesMap.values()) {
        let item = obj.item
        if (item.collapsibleState == TreeItemCollapsibleState.Expanded) {
          item.collapsibleState = TreeItemCollapsibleState.Collapsed
        }
      }
      await this.render()
    })
    close && regist('n', close, async () => {
      this.hide()
    }, true)
  }

  private hide(): void {
    if (!this.bufnr) return
    this.nvim.command(`bd! ${this.bufnr}`, true)
    this.redraw()
    this._onDidChangeVisibility.fire({ visible: false })
    this.bufnr = undefined
    this.winid = undefined
  }

  private redraw(): void {
    if (workspace.isVim || this.filter.activated) {
      this.nvim.command('redraw', true)
    }
  }

  private cancelResolve(): void {
    if (this.resolveTokenSource) {
      this.resolveTokenSource.cancel()
      this.resolveTokenSource = undefined
    }
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.filter.dispose()
    this._selection = []
    this.hide()
    this.itemsToFilter = []
    this.cancelResolve()
    this.tooltipFactory.dispose()
    this.renderedItems = []
    this.nodesMap.clear()
    this.provider = undefined
    disposeAll(this.disposables)
  }
}
