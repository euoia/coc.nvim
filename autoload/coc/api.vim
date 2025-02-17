" ============================================================================
" Description: Client api used by vim8
" Author: Qiming Zhao <chemzqm@gmail.com>
" Licence: MIT licence
" Last Modified:  Aug 10, 2021
" ============================================================================
if has('nvim') | finish | endif
scriptencoding utf-8
let s:funcs = {}
let s:prop_offset = get(g:, 'coc_text_prop_offset', 1000)
let s:namespace_id = 1
let s:namespace_cache = {}

" helper {{
function! s:buf_line_count(bufnr) abort
  if bufnr('%') == a:bufnr
    return line('$')
  endif
  if exists('*getbufinfo')
    let info = getbufinfo(a:bufnr)
    if empty(info)
      return 0
    endif
    return info[0]['linecount']
  endif
  if exists('*getbufline')
    let lines = getbufline(a:bufnr, 1, '$')
    return len(lines)
  endif
  let curr = bufnr('%')
  execute 'buffer '.a:bufnr
  let n = line('$')
  execute 'buffer '.curr
  return n
endfunction

function! s:execute(cmd)
  if a:cmd =~# '^echo'
    execute a:cmd
  else
    silent! execute a:cmd
  endif
endfunction
" }}"

" nvim client methods {{
function! s:funcs.set_current_dir(dir) abort
  execute 'cd '.a:dir
endfunction

function! s:funcs.set_var(name, value) abort
  execute 'let g:'.a:name.'= a:value'
endfunction

function! s:funcs.del_var(name) abort
  execute 'unlet g:'.a:name
endfunction

function! s:funcs.set_option(name, value) abort
  execute 'let &'.a:name.' = a:value'
endfunction

function! s:funcs.set_current_buf(bufnr) abort
  if !bufexists(a:bufnr) | return | endif
  execute 'buffer '.a:bufnr
endfunction

function! s:funcs.set_current_win(win_id) abort
  let [tabnr, winnr] = win_id2tabwin(a:win_id)
  if tabnr == 0 | return | endif
  execute 'normal! '.tabnr.'gt'
  execute winnr.' wincmd w'
endfunction

function! s:funcs.set_current_tabpage(tabnr) abort
  execute 'normal! '.a:tabnr.'gt'
endfunction

function! s:funcs.list_wins() abort
  return map(getwininfo(), 'v:val["winid"]')
endfunction

function s:inspect_type(v) abort
  let types = ['Number', 'String', 'Funcref', 'List', 'Dictionary', 'Float', 'Boolean', 'Null']
  return get(types, type(a:v), 'Unknown')
endfunction

function! s:funcs.call_atomic(calls)
  let res = []
  for i in range(len(a:calls))
    let [key, arglist] = a:calls[i]
    let name = key[5:]
    try
      call add(res, call(s:funcs[name], arglist))
    catch /.*/
      return [res, [i, "VimException(".s:inspect_type(v:exception).")", v:exception]]
    endtry
  endfor
  return [res, v:null]
endfunction

function! s:funcs.set_client_info(...) abort
endfunction

function! s:funcs.subscribe(...) abort
endfunction

function! s:funcs.unsubscribe(...) abort
endfunction

function! s:funcs.call_function(method, args) abort
  return call(a:method, a:args)
endfunction

function! s:funcs.call_dict_function(dict, method, args) abort
  return call(a:method, a:args, a:dict)
endfunction

function! s:funcs.command(command) abort
  " command that could cause cursor vanish
  if a:command =~# '^echo' || a:command =~# '^redraw' || a:command =~# '^sign place'
    call timer_start(0, {-> s:execute(a:command)})
  else
    execute a:command
  endif
endfunction

function! s:funcs.eval(expr) abort
  return eval(a:expr)
endfunction

function! s:funcs.get_api_info()
  let names = coc#api#func_names()
  return [1, {'functions': map(names, '{"name": "nvim_".v:val}')}]
endfunction

function! s:funcs.list_bufs()
  return map(getbufinfo({'bufloaded': 1}), 'v:val["bufnr"]')
endfunction

function! s:funcs.feedkeys(keys, mode, escape_csi)
  call feedkeys(a:keys, a:mode)
endfunction

function! s:funcs.list_runtime_paths()
  return split(&runtimepath, ',')
endfunction

function! s:funcs.command_output(cmd)
  return execute(a:cmd)
endfunction

function! s:funcs.get_current_line()
  return getline('.')
endfunction

function! s:funcs.set_current_line(line)
  call setline('.', a:line)
endfunction

function! s:funcs.del_current_line(line)
  execute 'normal! dd'
endfunction

function! s:funcs.get_var(var)
  return get(g:, a:var, v:null)
endfunction

function! s:funcs.get_vvar(var)
  return get(v:, a:var, v:null)
endfunction

function! s:funcs.get_option(name)
  return eval('&'.a:name)
endfunction

function! s:funcs.get_current_buf()
  return bufnr('%')
endfunction

function! s:funcs.get_current_win()
  return win_getid()
endfunction

function! s:funcs.get_current_tabpage()
  return tabpagenr()
endfunction

function! s:funcs.list_tabpages()
  return range(1, tabpagenr('$'))
endfunction

function! s:funcs.get_mode()
  return {'blocking': v:false, 'mode': mode()}
endfunction

function! s:funcs.strwidth(str)
  return strwidth(a:str)
endfunction

function! s:funcs.out_write(str)
  echon a:str
  call timer_start(0, {-> s:execute('redraw')})
endfunction

function! s:funcs.err_write(str)
  "echoerr a:str
endfunction

function! s:funcs.err_writeln(str)
  echohl ErrorMsg
  echom a:str
  echohl None
  call timer_start(0, {-> s:execute('redraw')})
endfunction

function! s:funcs.create_namespace(name) abort
  if empty(a:name)
    let id = s:namespace_id
    let s:namespace_id = s:namespace_id + 1
    return id
  endif
  let id = get(s:namespace_cache, a:name, 0)
  if !id
    let id = s:namespace_id
    let s:namespace_id = s:namespace_id + 1
    let s:namespace_cache[a:name] = id
  endif
  return id
endfunction
" }}

" buffer methods {{
function! s:funcs.buf_set_option(bufnr, name, val)
  let val = a:val
  if val is v:true
    let val = 1
  elseif val is v:false
    let val = 0
  endif
  return setbufvar(a:bufnr, '&'.a:name, val)
endfunction

function! s:funcs.buf_get_changedtick(bufnr)
  return getbufvar(a:bufnr, 'changedtick')
endfunction

function! s:funcs.buf_is_valid(bufnr)
  return bufloaded(a:bufnr) ? v:true : v:false
endfunction

function! s:funcs.buf_get_mark(bufnr, name)
  let nr = bufnr('%')
  if a:bufnr != 0 || a:bufnr != nr
    throw 'buf_get_mark support current buffer only'
  endif
  return [line("'" . a:name), col("'" . a:name)]
endfunction

function! s:funcs.buf_add_highlight(bufnr, srcId, hlGroup, line, colStart, colEnd) abort
  if !has('textprop') || !has('patch-8.1.1719')
    return
  endif
  let bufnr = a:bufnr == 0 ? bufnr('%') : a:bufnr
  let type = 'CocHighlight'.a:hlGroup
  if empty(prop_type_get(type))
    call prop_type_add(type, {'highlight': a:hlGroup, 'combine': 1})
  endif
  let total = strlen(getbufline(bufnr, a:line + 1)[0])
  let end = a:colEnd
  if end == -1
    let end = total
  else
    let end = min([end, total])
  endif
  if end <= a:colStart
    return
  endif
  let srcId = a:srcId
  if srcId == 0
    while v:true
      let srcId = srcId + 1
      if empty(prop_find({'id': s:prop_offset + srcId, 'lnum' : 1}))
        break
      endif
    endwhile
    " generate srcId
  endif
  let id = srcId == -1 ? 0 : s:prop_offset + srcId
  try
    call prop_add(a:line + 1, a:colStart + 1, {'length': end - a:colStart, 'bufnr': bufnr, 'type': type, 'id': id})
  catch /^Vim\%((\a\+)\)\=:E967/
    " ignore 967
  endtry
  if a:srcId == 0
    " return generated srcId
    return srcId
  endif
endfunction

function! s:funcs.buf_clear_namespace(bufnr, srcId, startLine, endLine) abort
  if !has('textprop') || !has('patch-8.1.1719')
    return
  endif
  let bufnr = a:bufnr == 0 ? bufnr('%') : a:bufnr
  let start = a:startLine + 1
  let end = a:endLine == -1 ? len(getbufline(bufnr, 1, '$')) : a:endLine + 1
  if a:srcId == -1
    call prop_clear(start, end, {'bufnr' : bufnr})
  else
    try
      call prop_remove({'bufnr': bufnr, 'all': 1, 'id': s:prop_offset + a:srcId}, start, end)
    catch /^Vim\%((\a\+)\)\=:E968/
      " ignore 968
    endtry
  endif
endfunction

function! s:funcs.buf_line_count(bufnr) abort
  return s:buf_line_count(a:bufnr)
endfunction

function! s:funcs.buf_attach(...)
  " not supported
  return 1
endfunction

function! s:funcs.buf_detach()
  " not supported
  return 1
endfunction

function! s:funcs.buf_get_lines(bufnr, start, end, strict) abort
  let lines = getbufline(a:bufnr, 1, '$')
  let start = a:start < 0 ? a:start + 1 : a:start
  let end = a:end < 0 ? a:end + 1 : a:end
  if a:strict && end > len(lines)
    throw 'line number out of range: '. end
  endif
  return lines[start : end - 1]
endfunction

function! s:funcs.buf_set_lines(bufnr, start, end, strict, ...) abort
  if !bufloaded(a:bufnr)
    return
  endif
  let replacement = get(a:, 1, [])
  let lineCount = s:buf_line_count(a:bufnr)
  let startLnum = a:start >= 0 ? a:start + 1 : lineCount + a:start + 1
  let end = a:end >= 0 ? a:end : lineCount + a:end + 1
  if end == lineCount + 1
    let end = lineCount
  endif
  let delCount = end - (startLnum - 1)
  let changeBuffer = 0
  let curr = bufnr('%')
  if a:bufnr != curr && !exists('*setbufline')
    let changeBuffer = 1
    exe 'buffer '.a:bufnr
  endif
  if a:bufnr == curr || changeBuffer
    " replace
    let storeView = winsaveview()
    if delCount == len(replacement)
      call setline(startLnum, replacement)
    else
      if len(replacement)
        call append(startLnum - 1, replacement)
      endif
      if delCount
        let start = startLnum + len(replacement)
        let saved_reg = @"
        silent execute start . ','.(start + delCount - 1).'d'
        let @" = saved_reg
      endif
    endif
    call winrestview(storeView)
    if changeBuffer
      exe 'buffer '.curr
    endif
  elseif exists('*setbufline')
    " replace
    if delCount == len(replacement)
      " 8.0.1039
      call setbufline(a:bufnr, startLnum, replacement)
    else
      if len(replacement)
        " 8.10037
        call appendbufline(a:bufnr, startLnum - 1, replacement)
      endif
      if delCount
        let start = startLnum + len(replacement)
        "8.1.0039
        silent call deletebufline(a:bufnr, start, start + delCount - 1)
      endif
    endif
  endif
endfunction

function! s:funcs.buf_set_name(bufnr, name) abort
  let nr = bufnr('%')
  if a:bufnr != nr
    throw 'buf_set_name support current buffer only'
  else
    execute '0f'
    execute 'file '.fnameescape(a:name)
  endif
endfunction

function! s:funcs.buf_get_var(bufnr, name)
  return getbufvar(a:bufnr, a:name)
endfunction

function! s:funcs.buf_set_var(bufnr, name, val)
  if !bufloaded(a:bufnr) | return | endif
  call setbufvar(a:bufnr, a:name, a:val)
endfunction

function! s:funcs.buf_del_var(bufnr, name)
  call coc#compat#buf_del_var(a:bufnr, a:name)
endfunction

function! s:funcs.buf_get_option(bufnr, name)
  return getbufvar(a:bufnr, '&'.a:name)
endfunction

function! s:funcs.buf_get_name(bufnr)
  return bufname(a:bufnr)
endfunction
" }}

" window methods {{
function! s:funcs.win_get_buf(winid)
  return winbufnr(a:winid)
endfunction

function! s:funcs.win_get_position(win_id) abort
  let [row, col] = win_screenpos(a:win_id)
  if row == 0 && col == 0
    throw 'Invalid window '.a:win_id
  endif
  return [row - 1, col - 1]
endfunction

function! s:funcs.win_get_height(win_id) abort
  return winheight(a:win_id)
endfunction

function! s:funcs.win_get_width(win_id) abort
  return winwidth(a:win_id)
endfunction

if exists('*win_execute')
  function! s:win_execute(win_id, cmd, ...) abort
    let ref = get(a:000, 0, v:null)
    let cmd = ref is v:null ? a:cmd : 'let ref["out"] = ' . a:cmd
    call win_execute(a:win_id, cmd)
  endfunction
else
  function! s:win_execute(win_id, cmd, ...) abort
    let ref = get(a:000, 0, v:null)
    let cmd = ref is v:null ? a:cmd : 'let ref["out"] = ' . a:cmd
    let winid = win_getid()
    if winid == a:win_id
      execute cmd
    else
      let goto_status = win_gotoid(a:win_id)
      if !goto_status
        return
      endif
      execute cmd
      call win_gotoid(winid)
    endif
  endfunction
endif

function! s:get_tabnr(winid) abort
  let ref = {}
  call s:win_execute(a:winid, 'tabpagenr()', ref)
  return get(ref, 'out', 0)
endfunction

function! s:funcs.win_get_cursor(win_id) abort
  let ref = {}
  call s:win_execute(a:win_id, "[line('.'), col('.')-1]", ref)
  return get(ref, 'out', 0)
endfunction

function! s:funcs.win_get_var(win_id, name) abort
  let tabnr = s:get_tabnr(a:win_id)
  if tabnr
    return gettabwinvar(tabnr, a:win_id, a:name)
  endif
  throw 'window '.a:win_id. ' not a valid window'
endfunction

function! s:funcs.win_set_width(win_id, width) abort
  call s:win_execute(a:win_id, 'vertical resize '.a:width)
endfunction

function! s:funcs.win_set_buf(win_id, buf_id) abort
  call s:win_execute(a:win_id, 'buffer '.a:buf_id)
endfunction

function! s:funcs.win_get_option(win_id, name) abort
  let tabnr = s:get_tabnr(a:win_id)
  if tabnr
    return gettabwinvar(tabnr, a:win_id, '&'.a:name)
  endif
  throw 'window '.a:win_id. ' not a valid window'
endfunction

function! s:funcs.win_set_height(win_id, height) abort
  return s:win_execute(a:win_id, 'resize '.a:height)
endfunction

function! s:funcs.win_set_option(win_id, name, value) abort
  let val = a:value
  if val is v:true
    let val = 1
  elseif val is v:false
    let val = 0
  endif
  let tabnr = s:get_tabnr(a:win_id)
  if tabnr
    call settabwinvar(tabnr, a:win_id, '&'.a:name, val)
  else
    throw 'window '.a:win_id. ' not a valid window'
  endif
endfunction

function! s:funcs.win_set_var(win_id, name, value) abort
  let tabnr = s:get_tabnr(a:win_id)
  if tabnr
    call settabwinvar(tabnr, a:win_id, a:name, a:value)
  else
    throw 'window '.a:win_id. ' not a valid window'
  endif
endfunction

function! s:funcs.win_del_var(win_id, name) abort
  call s:win_execute(a:win_id, 'unlet! w:'.a:name)
endfunction

function! s:funcs.win_is_valid(win_id) abort
  let info = getwininfo(a:win_id)
  return empty(info) ? v:false : v:true
endfunction

function! s:funcs.win_get_number(win_id) abort
  let info = getwininfo(a:win_id)
  if empty(info)
    throw 'Invalid window id '.a:win_id
  endif
  return info[0]['winnr']
endfunction

function! s:funcs.win_set_cursor(win_id, pos) abort
  let [line, col] = a:pos
  call s:win_execute(a:win_id, 'call cursor('.line.','.(col + 1).')')
endfunction

function! s:funcs.win_close(win_id, ...) abort
  let force = get(a:, 1, 0)
  call s:win_execute(a:win_id, 'close'.(force ? '!' : ''))
endfunction

function! s:funcs.win_get_tabpage(win_id) abort
  let tabnr = s:get_tabnr(a:win_id)
  if !tabnr
    throw 'Invalid window id '.a:win_id
  endif
  return tabnr
endfunction
" }}

" tabpage methods {{
function! s:funcs.tabpage_get_number(id)
  return a:id
endfunction

function! s:funcs.tabpage_list_wins(tabnr)
  let info = getwininfo()
  return map(filter(info, 'v:val["tabnr"] == a:tabnr'), 'v:val["winid"]')
endfunction

function! s:funcs.tabpage_get_var(tabnr, name)
  return gettabvar(a:tabnr, a:name, v:null)
endfunction

function! s:funcs.tabpage_set_var(tabnr, name, value)
  call settabvar(a:tabnr, a:name, a:value)
endfunction

function! s:funcs.tabpage_del_var(tabnr, name)
  call settabvar(a:tabnr, a:name, v:null)
endfunction

function! s:funcs.tabpage_is_valid(tabnr)
  let max = tabpagenr('$')
  return a:tabnr <= max
endfunction

function! s:funcs.tabpage_get_win(tabnr)
  let wnr = tabpagewinnr(a:tabnr)
  return win_getid(wnr, a:tabnr)
endfunction
" }}

function! coc#api#func_names() abort
  return keys(s:funcs)
endfunction

function! coc#api#call(method, args) abort
  let err = v:null
  let res = v:null
  try
    let res = call(s:funcs[a:method], a:args)
  catch /.*/
    let err = v:exception
  endtry
  return [err, res]
endfunction

function! coc#api#notify(method, args) abort
  call call(s:funcs[a:method], a:args)
endfunction
" vim: set sw=2 ts=2 sts=2 et tw=78 foldmarker={{,}} foldmethod=marker foldlevel=0:
