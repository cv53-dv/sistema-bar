// UTILIDADES COMPARTIDAS (carta, admin, mozo, comandas y caja)

// Escapa texto antes de insertarlo con innerHTML (evita XSS)
function escapeHtml(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatoPrecio(valor) {
    // Guaraníes: sin decimales y con punto de miles (Gs. 35.000)
    return 'Gs. ' + Math.round(Number(valor || 0)).toLocaleString('es-PY');
}

function formatoHora(fecha) {
    return new Date(fecha).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function formatoFechaHora(fecha) {
    return fecha ? new Date(fecha).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '-';
}

// Llama a una función de la base de datos y lanza el error si falla
async function llamarRpc(nombre, parametros = {}) {
    const { data, error } = await supabaseClient.rpc(nombre, parametros);
    if (error) throw error;
    return data;
}

// Categorías en el orden definido por el admin (el público solo recibe las visibles)
async function cargarCategorias() {
    const { data, error } = await supabaseClient
        .from('categorias')
        .select('id, nombre, emoji, orden, visible')
        .order('orden')
        .order('id');
    if (error) throw error;
    return data;
}

function etiquetaCategoria(categoria) {
    return `${categoria.emoji ? categoria.emoji + ' ' : ''}${categoria.nombre}`;
}

function abrirModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.style.display = 'flex';
    void modal.offsetWidth;
    modal.classList.add('active');
}

function cerrarModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('active');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
}

// --- RUC (Paraguay) ---

// Dígito verificador del RUC: módulo 11 de la SET (el mismo cálculo que ruc_valido() en la base)
function digitoVerificadorRuc(base) {
    let total = 0, k = 2;
    for (let i = base.length - 1; i >= 0; i--) {
        total += Number(base[i]) * k;
        k = k === 11 ? 2 : k + 1;
    }
    const resto = total % 11;
    return resto > 1 ? 11 - resto : 0;
}

const AYUDA_DOCUMENTO = 'RUC con guion y dígito verificador (ej. 80012345-0) o cédula sin dígito (ej. 1234567)';

// RUC o cédula, igual que tipo_documento() en la base. Los puntos y espacios se ignoran.
// Devuelve { valido, tipo: 'ruc' | 'ci' | null, documento (normalizado), mensaje }
function revisarDocumento(texto) {
    const documento = String(texto || '').replace(/[.\s]/g, '');
    const ruc = documento.match(/^(\d{1,10})-(\d)$/);
    if (ruc) {
        const esperado = digitoVerificadorRuc(ruc[1]);
        if (Number(ruc[2]) !== esperado) {
            return { valido: false, tipo: null, documento, mensaje: `El dígito verificador no coincide: para ${ruc[1]} debería ser ${esperado}` };
        }
        return { valido: true, tipo: 'ruc', documento, mensaje: 'RUC válido' };
    }
    if (/^\d{4,10}$/.test(documento)) {
        return { valido: true, tipo: 'ci', documento, mensaje: 'Cédula de identidad (si es un RUC, agrega el guion y el dígito)' };
    }
    return { valido: false, tipo: null, documento, mensaje: AYUDA_DOCUMENTO };
}

function etiquetaDocumento(tipo) {
    return tipo === 'ci' ? 'C.I.' : 'RUC';
}

// --- SESIÓN Y ROLES ---

// Rol del usuario logueado: 'admin', 'mozo' o null
async function obtenerRol() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return null;
    const { data, error } = await supabaseClient.rpc('mi_rol');
    if (error) return null;
    return data;
}

function paginaInicioPorRol(rol) {
    return rol === 'admin' ? 'admin.html' : 'mozo.html';
}

// Protege una página: redirige si el usuario no tiene uno de los roles permitidos
async function requerirRol(rolesPermitidos) {
    const rol = await obtenerRol();
    if (!rol) {
        window.location.href = "login.html";
        return null;
    }
    if (!rolesPermitidos.includes(rol)) {
        window.location.href = paginaInicioPorRol(rol);
        return null;
    }
    // Los enlaces marcados con data-solo-admin solo se muestran al admin
    document.querySelectorAll('[data-solo-admin]').forEach(el => {
        el.style.display = rol === 'admin' ? '' : 'none';
    });
    return rol;
}

async function cerrarSesion() {
    await supabaseClient.auth.signOut();
    window.location.href = "login.html";
}

// --- TICKETS (comanda, precuenta, cierre de caja) ---
// Se imprimen en un iframe aparte con formato para impresora térmica de 80 mm.
// Ningún ticket es comprobante legal: los que llevan montos imprimen "DOCUMENTO NO VÁLIDO COMO FACTURA".
// La factura electrónica (KuDE con CDC y QR) solo la puede generar el sistema de facturación SIFEN.
// lineas: [{ cantidad, nombre, nota?, importe? }] · factura: { documento, tipo ('ruc'|'ci'), razon_social, email? } o null
function imprimirTicket({ titulo, subtitulo = '', lineas = [], total = null, nota = '', extra = [], pie = '', factura = null }) {
    const conImportes = total !== null;

    const filas = lineas.map(l => `
        <tr>
            <td class="cant">${escapeHtml(l.cantidad)}</td>
            <td>${escapeHtml(l.nombre)}${l.nota ? `<div class="nota">» ${escapeHtml(l.nota)}</div>` : ''}</td>
            ${conImportes ? `<td class="importe">${formatoPrecio(l.importe)}</td>` : ''}
        </tr>`).join('');

    const filasExtra = extra.map(([etiqueta, valor]) =>
        `<div class="fila"><span>${escapeHtml(etiqueta)}</span><span>${escapeHtml(valor)}</span></div>`).join('');

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(titulo)}</title><style>
        @page { size: 80mm auto; margin: 0; }
        * { box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; width: 72mm; margin: 0 auto; padding: 4mm 0 8mm; font-size: 12px; color: #000; }
        h1 { font-size: 20px; text-align: center; margin: 0 0 2px; }
        .sub { text-align: center; margin-bottom: 6px; }
        table { width: 100%; border-collapse: collapse; border-top: 1px dashed #000; border-bottom: 1px dashed #000; margin: 4px 0; }
        td { padding: 3px 0; vertical-align: top; font-size: 14px; }
        .cant { width: 9mm; font-weight: bold; }
        .importe { text-align: right; white-space: nowrap; padding-left: 2mm; }
        .nota { font-size: 12px; font-style: italic; }
        .nota-general { border: 1px solid #000; padding: 3px; margin: 4px 0; font-size: 13px; }
        .fila { display: flex; justify-content: space-between; margin: 2px 0; }
        .total { font-size: 17px; font-weight: bold; border-top: 1px solid #000; padding-top: 3px; }
        .pie { text-align: center; margin-top: 8px; font-size: 11px; }
        .factura { border: 1px dashed #000; padding: 4px; margin-top: 8px; font-size: 12px; }
        .factura b { display: block; text-align: center; margin-bottom: 2px; }
        .no-fiscal { text-align: center; font-weight: bold; font-size: 13px; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 3px 0; margin-top: 8px; }
    </style></head><body>
        <h1>${escapeHtml(titulo)}</h1>
        <div class="sub">${escapeHtml(subtitulo)}</div>
        ${lineas.length ? `<table>${filas}</table>` : ''}
        ${nota ? `<div class="nota-general">NOTA: ${escapeHtml(nota)}</div>` : ''}
        ${filasExtra}
        ${conImportes ? `<div class="fila total"><span>TOTAL</span><span>${formatoPrecio(total)}</span></div>` : ''}
        ${conImportes ? '<div class="no-fiscal">DOCUMENTO NO VÁLIDO COMO FACTURA</div>' : ''}
        ${factura ? `<div class="factura"><b>DATOS DEL CLIENTE PARA FACTURACIÓN</b>
            <div>${etiquetaDocumento(factura.tipo)}: ${escapeHtml(factura.documento)}</div>
            <div>${factura.tipo === 'ci' ? 'Nombre' : 'Razón social'}: ${escapeHtml(factura.razon_social)}</div>
            ${factura.email ? `<div>Email: ${escapeHtml(factura.email)}</div>` : ''}</div>` : ''}
        ${pie ?`<div class="pie">${escapeHtml(pie)}</div>` : ''}
    </body></html>`;

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0;';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 1000);
}

// Comanda de un pedido con { id, nota, created_at, origen, mesas: { nombre }, pedido_items: [...] }
function imprimirComanda(pedido) {
    imprimirTicket({
        titulo: pedido.mesas?.nombre || 'Pedido',
        subtitulo: `Comanda #${pedido.id} · ${formatoHora(pedido.confirmado_at || pedido.created_at)}${pedido.origen === 'cliente' ? ' · QR' : ''}`,
        lineas: (pedido.pedido_items || []).map(i => ({ cantidad: i.cantidad, nombre: i.nombre, nota: i.nota })),
        nota: pedido.nota
    });
}

// Avisos flotantes (requiere <div id="toast-container"> en la página)
function mostrarAviso(mensaje, tipo = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) { alert(mensaje); return; }
    const toast = document.createElement('div');
    toast.className = `toast ${tipo}`;
    const icono = tipo === 'success' ? '✨' : '⚠️';
    toast.innerHTML = `<span class="toast-icon">${icono}</span><span class="toast-msg">${escapeHtml(mensaje)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.4s forwards';
        setTimeout(() => toast.remove(), 400);
    }, 3500);
}
