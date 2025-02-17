import { CancellationTokenSource } from 'vscode-languageserver-protocol'
import { Neovim } from '@chemzqm/neovim'
import Picker, { QuickPickItem } from '../../model/picker'
import helper from '../helper'

let nvim: Neovim
let picker: Picker

beforeAll(async () => {
  await helper.setup()
  nvim = helper.nvim
})

afterAll(async () => {
  await helper.shutdown()
})

afterEach(async () => {
  if (picker) picker.dispose()
  await helper.reset()
})

const items: QuickPickItem[] = [{ label: 'foo' }, { label: 'bar' }]

describe('Picker create', () => {
  it('should show dialog with buttons', async () => {
    picker = new Picker(nvim, { title: 'title', items })
    let winid = await picker.show({ pickerButtons: true })
    expect(winid).toBeDefined()
    let id = await nvim.call('coc#float#get_related', [winid, 'buttons'])
    expect(id).toBeGreaterThan(0)
    let res = await nvim.call('sign_getplaced', [picker.buffer.id, { lnum: 1 }])
    expect(res[0].signs).toBeDefined()
    expect(res[0].signs[0].name).toBe('CocCurrentLine')
  })

  it('should cancel dialog when cancellation token requested', async () => {
    let tokenSource = new CancellationTokenSource()
    picker = new Picker(nvim, { title: 'title', items }, tokenSource.token)
    let winid = await picker.show({ pickerButtons: true })
    expect(winid).toBeDefined()
    tokenSource.cancel()
    await helper.wait(50)
    let res = await nvim.call('coc#float#valid', [winid])
    expect(res).toBe(0)
  })
})

describe('Picker key mappings', () => {
  it('should toggle selection mouse click bracket', async () => {
    picker = new Picker(nvim, { title: 'title', items })
    let winid = await picker.show()
    await nvim.setVar('mouse_position', [winid, 1, 1])
    await nvim.input('<LeftRelease>')
    await helper.wait(50)
    let buf = picker.buffer
    let lines = await buf.getLines({ start: 0, end: 1, strictIndexing: false })
    expect(lines[0]).toMatch(/^\[x\]/)
  })

  it('should change current line on mouse click label', async () => {
    picker = new Picker(nvim, { title: 'title', items })
    let winid = await picker.show()
    await nvim.setVar('mouse_position', [winid, 2, 4])
    await nvim.input('<LeftRelease>')
    await helper.wait(50)
    let buf = picker.buffer
    let res = await nvim.call('sign_getplaced', [buf.id, { lnum: 2 }])
    expect(res[0].signs).toBeDefined()
    expect(res[0].signs[0].name).toBe('CocCurrentLine')
  })

  it('should cancel by <esc>', async () => {
    await helper.createDocument()
    picker = new Picker(nvim, { title: 'title', items })
    let winid = await picker.show({ pickerButtons: true })
    expect(winid).toBeDefined()
    let fn = jest.fn()
    picker.onDidClose(fn)
    await nvim.input('<esc>')
    await helper.wait(200)
    expect(fn).toBeCalledTimes(1)
  })

  it('should confirm by <CR>', async () => {
    await helper.createDocument()
    picker = new Picker(nvim, { title: 'title', items })
    let winid = await picker.show({ pickerButtons: true })
    expect(winid).toBeDefined()
    let fn = jest.fn()
    picker.onDidClose(fn)
    await nvim.input('<space>')
    await helper.wait(100)
    await nvim.input('<cr>')
    await nvim.command('redraw')
    await helper.wait(100)
    expect(fn).toBeCalledWith([0])
  })

  it('should move cursor by j, k, g & G', async () => {
    await helper.createDocument()
    picker = new Picker(nvim, { title: 'title', items })
    let winid = await picker.show({ pickerButtons: true })
    expect(winid).toBeDefined()
    await nvim.input('j')
    await helper.wait(100)
    let res = await nvim.call('sign_getplaced', [picker.buffer.id])
    expect(res[0].signs[0].lnum).toBe(2)
    await nvim.input('k')
    await helper.wait(100)
    res = await nvim.call('sign_getplaced', [picker.buffer.id])
    expect(res[0].signs[0].lnum).toBe(1)
    await nvim.input('G')
    await helper.wait(100)
    res = await nvim.call('sign_getplaced', [picker.buffer.id])
    expect(res[0].signs[0].lnum).toBe(2)
    await nvim.input('g')
    await helper.wait(100)
    res = await nvim.call('sign_getplaced', [picker.buffer.id])
    expect(res[0].signs[0].lnum).toBe(1)
  })

  it('should toggle selection by <space>', async () => {
    await helper.createDocument()
    picker = new Picker(nvim, { title: 'title', items })
    let winid = await picker.show({ pickerButtons: true })
    expect(winid).toBeDefined()
    let fn = jest.fn()
    picker.onDidClose(fn)
    await nvim.input('<space>')
    await helper.wait(200)
    let lines = await nvim.call('getbufline', [picker.buffer.id, 1])
    expect(lines[0]).toMatch('[x]')
  })

  it('should scroll forward & backward', async () => {
    await helper.createDocument()
    let items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(s => {
      return { label: s }
    })
    picker = new Picker(nvim, { title: 'title', items })
    let winid = await picker.show({ maxHeight: 3 })
    expect(winid).toBeDefined()
    await nvim.input('<C-f>')
    await helper.wait(50)
    await nvim.command('setl scrolloff=0')
    await nvim.call('win_gotoid', [winid])
    await nvim.command('normal! h')
    let res = await nvim.call('getline', ['.'])
    expect(res).toMatch('c')
    await nvim.input('<C-b>')
    await helper.wait(100)
    res = await nvim.call('getline', ['.'])
  })
})
