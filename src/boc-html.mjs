/** Read a verified content container, accepting valid quoted/unquoted HTML attributes. */
export function readHtmlContentDiv(html,classNames) {
 const allowed=new Set(classNames.map(x=>x.toLowerCase()));
 const visible=html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,x=>' '.repeat(x.length));
 for(const tag of visible.matchAll(/<div\b([^>]*)>/gi)){
  const value=tag[1].match(/(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if(!(value?.[1]??value?.[2]??value?.[3]??'').split(/\s+/).some(x=>allowed.has(x.toLowerCase())||allowed.has('trs_editor_view')&&x.toLowerCase().startsWith('trs_editor_view')))continue;
  const start=tag.index+tag[0].length;let depth=1;
  for(const next of visible.slice(start).matchAll(/<\/?div\b[^>]*>/gi)){
   depth+=/^<\//.test(next[0])?-1:1;
   if(!depth)return {html:html.slice(start,start+next.index),sourceStart:start,sourceEnd:start+next.index};
  }
  throw Error('已识别正文容器，但标签边界不完整');
 }
 return null;
}
/** Expand HTML cell ranges while retaining the original cell and absolute HTML offsets. */
export function readHtmlTables(html, { plain, sourceOffset = 0 }) {
  // Mask invisible content rather than deleting it, so source offsets remain exact.
  const visible = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, text => ' '.repeat(text.length));
  const tables = [];
  for (const match of visible.matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi)) {
    if ((match[0].match(/<table\b/gi) ?? []).length !== 1) throw new Error('嵌套表格尚不能可靠展开，保留原HTML并报告缺口');
    const rawHtml = html.slice(match.index, match.index + match[0].length);
    const rows = [...match[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
    if (!rows.length || rows.length > 1000 || rows.length !== (match[0].match(/<tr\b/gi) ?? []).length) throw new Error('表格行结构或数量超出可靠读取范围');
    const groups = [...match[0].matchAll(/<(thead|tbody|tfoot)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)];
    const grid = rows.map(() => []);
    for (const [rowIndex, row] of rows.entries()) {
      const cells = [...row[0].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)];
      if (!cells.length || cells.length > 100 || cells.length !== (row[0].match(/<(?:td|th)\b/gi) ?? []).length) throw new Error('表格单元格结构变化，未确认关联完整');
      const group = groups.find(group => group.index <= row.index && group.index + group[0].length > row.index);
      const groupEnd = group ? rows.findLastIndex(item => item.index < group.index + group[0].length && item.index >= group.index) : rows.length - 1;
      const span = (attributes, name) => {
        const attribute = [...attributes.matchAll(/(?:^|\s)([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)].find(item => item[1].toLowerCase() === name);
        if (!attribute) return 1;
        const value = (attribute[2] ?? attribute[3] ?? attribute[4] ?? '').trim();
        if (!/^\d+$/.test(value)) throw new Error('表格跨度属性无效');
        return Number(value);
      };
      let column = 0;
      for (const cell of cells) {
        while (grid[rowIndex][column]) column++;
        const requestedRows = span(cell[2], 'rowspan');
        const rowSpan = requestedRows === 0 ? groupEnd - rowIndex + 1 : requestedRows;
        const columnSpan = span(cell[2], 'colspan');
        if (rowSpan < 1 || rowIndex + rowSpan - 1 > groupEnd || columnSpan < 1 || column + columnSpan > 100) throw new Error('表格跨度越界，未确认岗位与条件关联');
        const sourceStart = sourceOffset + match.index + row.index + cell.index;
        const original = { text: plain(cell[3]), type: cell[1].toLowerCase(), originRow: rowIndex + 1, originColumn: column + 1, rowSpan, columnSpan, sourceStart, sourceEnd: sourceStart + cell[0].length, rawHtml: html.slice(sourceStart - sourceOffset, sourceStart - sourceOffset + cell[0].length) };
        for (let down = rowIndex; down < rowIndex + rowSpan; down++) for (let across = column; across < column + columnSpan; across++) {
          if (grid[down][across]) throw new Error('表格跨度重叠，未确认岗位与条件关联');
          grid[down][across] = original;
        }
        column += columnSpan;
      }
    }
    const columns = Math.max(...grid.map(row => row.length));
    if (grid.some(row => Array.from({ length: columns }, (_, column) => row[column]).some(cell => !cell))) throw new Error('表格行列缺失，未确认岗位与条件关联');
    const expandedRows = grid.map((row, index) => ({ rowIndex: index + 1, isHeader: row.every(cell => cell.type === 'th'), cells: row.map((cell, column) => ({ ...cell, columnIndex: column + 1, inherited: cell.originRow !== index + 1 || cell.originColumn !== column + 1 })) }));
    const headerRows = expandedRows.filter(row => row.isHeader);
    const headers = Array.from({ length: columns }, (_, column) => headerRows.map(row => row.cells[column].text).filter((value, index, values) => value !== values[index - 1]));
    tables.push({ tableIndex: tables.length + 1, sourceStart: sourceOffset + match.index, sourceEnd: sourceOffset + match.index + match[0].length, rawHtml, columns, headers, rows: expandedRows, expandedText: expandedRows.map(row => row.cells.map(cell => cell.text.replace(/\s*\n\s*/g, ' ')).join(' | ')).join('\n') });
  }
  if (tables.length !== (visible.match(/<table\b/gi) ?? []).length) throw new Error('表格边界结构变化，保留原HTML不称展开完整');
  return tables;
}
