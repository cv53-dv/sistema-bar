// XLSX sin dependencias: ZIP sin compresión y celdas tipadas, nunca fórmulas.
(function (global) {
    const encoder = new TextEncoder();
    const xml = value => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    function column(index) {
        let name = '';
        for (index++; index; index = Math.floor((index - 1) / 26)) name = String.fromCharCode(65 + (index - 1) % 26) + name;
        return name;
    }
    function sheet(rows) {
        return '<?xml version="1.0" encoding="UTF-8"?>' +
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
            rows.map((row, i) => `<row r="${i + 1}">` + row.map((value, j) => {
                const ref = column(j) + (i + 1);
                if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
                return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
            }).join('') + '</row>').join('') + '</sheetData></worksheet>';
    }
    function crc32(bytes) {
        let crc = -1;
        for (const byte of bytes) {
            crc ^= byte;
            for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        return (crc ^ -1) >>> 0;
    }
    function header(length, fields) {
        const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
        for (const [offset, size, value] of fields) size === 4 ? view.setUint32(offset, value, true) : view.setUint16(offset, value, true);
        return bytes;
    }
    function zip(files) {
        const local = [], central = [];
        let offset = 0, centralSize = 0;
        for (const [path, text] of files) {
            const name = encoder.encode(path), data = encoder.encode(text), crc = crc32(data);
            const h = header(30, [[0,4,0x04034b50],[4,2,20],[6,2,0x800],[12,2,33],[14,4,crc],
                [18,4,data.length],[22,4,data.length],[26,2,name.length]]);
            local.push(h, name, data);
            central.push(header(46, [[0,4,0x02014b50],[4,2,20],[6,2,20],[8,2,0x800],[14,2,33],
                [16,4,crc],[20,4,data.length],[24,4,data.length],[28,2,name.length],[42,4,offset]]), name);
            centralSize += 46 + name.length;
            offset += 30 + name.length + data.length;
        }
        const end = header(22, [[0,4,0x06054b50],[8,2,files.length],[10,2,files.length],[12,4,centralSize],[16,4,offset]]);
        return new Blob([...local, ...central, end], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    }
    function workbook(sheets) {
        const ns = 'http://schemas.openxmlformats.org/';
        const files = [
            ['[Content_Types].xml', `<Types xmlns="${ns}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` + sheets.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
            ['_rels/.rels', `<Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
            ['xl/workbook.xml', `<workbook xmlns="${ns}spreadsheetml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships"><sheets>` + sheets.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('') + '</sheets></workbook>'],
            ['xl/_rels/workbook.xml.rels', `<Relationships xmlns="${ns}package/2006/relationships">` + sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="${ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('') + '</Relationships>']
        ];
        sheets.forEach((s,i)=>files.push([`xl/worksheets/sheet${i+1}.xml`,sheet(s.rows)]));
        return zip(files);
    }
    global.ExcelMashbeer = {workbook};
})(globalThis);
