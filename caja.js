// caja.js — Resumen de ventas, cierre de caja, mesas/QR y personal (solo admin)

let resumenTurno = null;
let mesasAbiertas = { cantidad: 0, total: 0 };
let mesasTodas = [];
let personalLista = [];

async function iniciar() {
    const rol = await requerirRol(['admin']);
    if (!rol) return;
    await Promise.all([cargarTurno(), cargarFacturas(), cargarCierres(), cargarMesas(), cargarPersonal(), cargarAuditoria()]);
}

// FACTURAS POR EMITIR
let facturasPendientes = [];

async function cargarFacturas() {
    const { data, error } = await supabaseClient
        .from('cuentas')
        .select(`id, cerrada_at, total, metodo_pago, factura_documento, factura_tipo_documento, factura_razon_social, factura_email,
                 mesas (nombre), pedidos (estado, pedido_items (nombre, cantidad, precio_unitario))`)
        .eq('factura_estado', 'pendiente')
        .order('cerrada_at');
    if (error) { mostrarAviso("Error al cargar facturas: " + error.message, 'error'); return; }
    facturasPendientes = data;

    document.getElementById('contador-facturas').textContent = data.length;
    document.getElementById('tabla-facturas').innerHTML = data.length
        ? data.map((c, i) => `
            <tr>
                <td>${formatoFechaHora(c.cerrada_at)}</td>
                <td>${escapeHtml(c.mesas?.nombre)}</td>
                <td style="white-space:nowrap;"><small style="color:#888;">${etiquetaDocumento(c.factura_tipo_documento)}</small> ${escapeHtml(c.factura_documento)}</td>
                <td>${escapeHtml(c.factura_razon_social)}${c.factura_email ? `<br><small style="color:#888;">${escapeHtml(c.factura_email)}</small>` : ''}</td>
                <td class="num">${formatoPrecio(c.total)}</td>
                <td class="num" style="white-space:nowrap;">
                    <button class="icon-btn" style="display:inline-flex;" title="Imprimir detalle" onclick="imprimirDetalleFactura(${i})"><span class="material-icons">print</span></button>
                    <button class="icon-btn" style="display:inline-flex; color:var(--green-success);" title="Marcar como emitida" onclick="marcarFacturaEmitida(${i})"><span class="material-icons">task_alt</span></button>
                </td>
            </tr>`).join('')
        : '<tr><td colspan="6" class="vacio">No hay facturas pendientes</td></tr>';
}

// Detalle de la cuenta para cargar la factura en el sistema de facturación
function imprimirDetalleFactura(indice) {
    const c = facturasPendientes[indice];
    if (!c) return;
    const lineas = {};
    c.pedidos.filter(p => p.estado === 'confirmado').forEach(p => p.pedido_items.forEach(i => {
        const clave = `${i.nombre}|${i.precio_unitario}`;
        if (!lineas[clave]) lineas[clave] = { nombre: i.nombre, cantidad: 0, importe: 0 };
        lineas[clave].cantidad += i.cantidad;
        lineas[clave].importe += i.cantidad * i.precio_unitario;
    }));
    imprimirTicket({
        titulo: CONFIG.NOMBRE_BAR,
        subtitulo: `${c.mesas?.nombre ?? ''} · ${formatoFechaHora(c.cerrada_at)} · Detalle para facturar`,
        lineas: Object.values(lineas),
        total: c.total,
        extra: [['Pago', { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' }[c.metodo_pago] ?? '-']],
        factura: { documento: c.factura_documento, tipo: c.factura_tipo_documento, razon_social: c.factura_razon_social, email: c.factura_email }
    });
}

async function marcarFacturaEmitida(indice) {
    const c = facturasPendientes[indice];
    if (!c) return;
    const numero = prompt(`Número de la factura emitida para ${c.factura_razon_social} (${formatoPrecio(c.total)}):`, '001-001-');
    if (numero === null) return;
    try {
        await llamarRpc('marcar_factura_emitida', { p_cuenta_id: c.id, p_numero: numero });
        mostrarAviso(`Factura ${numero.trim()} registrada`);
        cargarFacturas();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}

// 1. TURNO ACTUAL
async function cargarTurno() {
    try {
        const [resumen, resCuentas] = await Promise.all([
            llamarRpc('resumen_ventas'),
            supabaseClient.from('cuentas')
                .select('id, pedidos (estado, pedido_items (cantidad, precio_unitario))')
                .eq('estado', 'abierta')
        ]);
        if (resCuentas.error) throw resCuentas.error;

        resumenTurno = resumen;
        mesasAbiertas = {
            cantidad: resCuentas.data.length,
            total: resCuentas.data.reduce((suma, c) => suma + c.pedidos
                .filter(p => p.estado === 'confirmado')
                .reduce((s, p) => s + p.pedido_items.reduce((t, i) => t + i.cantidad * i.precio_unitario, 0), 0), 0)
        };
        renderTurno();
    } catch (error) {
        mostrarAviso("Error al cargar el turno: " + error.message, 'error');
    }
}

function renderTurno() {
    const r = resumenTurno;
    const stats = [
        ['Total cobrado', formatoPrecio(r.total), true],
        ['Efectivo', formatoPrecio(r.por_metodo.efectivo)],
        ['Tarjeta', formatoPrecio(r.por_metodo.tarjeta)],
        ['Transferencia', formatoPrecio(r.por_metodo.transferencia)],
        ['Cuentas cobradas', r.cuentas],
        ['Mesas abiertas', `${mesasAbiertas.cantidad} · ${formatoPrecio(mesasAbiertas.total)}`]
    ];
    if (r.turno) {
        stats.splice(1, 0, ['Monto inicial', formatoPrecio(r.turno.monto_inicial)],
                           ['Efectivo esperado', formatoPrecio(r.turno.efectivo_esperado)]);
    }
    const abierta = Boolean(r.turno && r.turno.estado === 'abierta');
    document.getElementById('form-abrir-caja').style.display = abierta ? 'none' : 'flex';
    document.getElementById('turno-sub').textContent = abierta
        ? `(caja abierta desde ${formatoFechaHora(r.desde)})`
        : '(caja cerrada: no se puede vender)';
    document.getElementById('stats-turno').innerHTML = stats.map(([etiqueta, valor, destacada]) => `
        <div class="stat ${destacada ? 'destacada' : ''}">
            <div class="etiqueta">${etiqueta}</div>
            <div class="valor">${escapeHtml(valor)}</div>
        </div>`).join('');

    document.getElementById('tabla-productos').innerHTML = r.productos.length
        ? r.productos.map(p => `
            <tr><td>${escapeHtml(p.nombre)}</td><td class="num">${Number(p.cantidad)}</td><td class="num">${formatoPrecio(p.total)}</td></tr>`).join('')
        : '<tr><td colspan="3" class="vacio">Todavía no hay ventas cobradas en este turno</td></tr>';

    document.getElementById('btn-cerrar-caja').disabled = !abierta;
}

function imprimirResumen(resumen, titulo) {
    imprimirTicket({
        titulo: CONFIG.NOMBRE_BAR,
        subtitulo: `${titulo} · ${formatoFechaHora(new Date())}`,
        lineas: resumen.productos.map(p => ({ cantidad: p.cantidad, nombre: p.nombre, importe: p.total })),
        extra: [
            ['Desde', formatoFechaHora(resumen.desde)],
            ['Hasta', formatoFechaHora(resumen.hasta)],
            ['Cuentas', String(resumen.cuentas)],
            ['Efectivo', formatoPrecio(resumen.por_metodo.efectivo)],
            ['Tarjeta', formatoPrecio(resumen.por_metodo.tarjeta)],
            ['Transferencia', formatoPrecio(resumen.por_metodo.transferencia)],
            ...(resumen.turno ? [
                ['Monto inicial', formatoPrecio(resumen.turno.monto_inicial)],
                ['Efectivo esperado', formatoPrecio(resumen.turno.efectivo_esperado)],
                ...(resumen.turno.efectivo_contado === null ? [] : [
                    ['Efectivo contado', formatoPrecio(resumen.turno.efectivo_contado)],
                    ['Diferencia', formatoPrecio(resumen.turno.diferencia)]])
            ] : [])
        ],
        total: resumen.total
    });
}

function imprimirTurno() {
    if (resumenTurno) imprimirResumen(resumenTurno, 'Resumen parcial');
}

async function cerrarCaja(boton) {
    if (!resumenTurno || !resumenTurno.turno || resumenTurno.turno.estado !== 'abierta') {
        mostrarAviso("La caja no está abierta", 'error');
        return;
    }
    const esperado = resumenTurno.turno.efectivo_esperado;
    const texto = prompt(`Arqueo: cuenta el efectivo de la caja.\nDebería haber ${formatoPrecio(esperado)} (monto inicial + efectivo cobrado).\n\nEfectivo contado (Gs.):`);
    if (texto === null) return;
    const contado = Number(String(texto).replace(/\D/g, ''));
    if (texto.trim() === '' || !Number.isFinite(contado)) {
        mostrarAviso("Indica el efectivo contado", 'error');
        return;
    }
    let mensaje = `Contado ${formatoPrecio(contado)} · diferencia ${formatoPrecio(contado - esperado)}.\n¿Cerrar la caja?`;
    if (mesasAbiertas.cantidad > 0) {
        mensaje += `\n\nHay ${mesasAbiertas.cantidad} mesa(s) abierta(s): se cobrarán cuando se vuelva a abrir la caja.`;
    }
    if (!confirm(mensaje)) return;

    boton.disabled = true;
    try {
        const cierre = await llamarRpc('cierre_caja', { p_efectivo_contado: contado });
        const resumen = await llamarRpc('resumen_ventas', { p_cierre_id: cierre.id });
        imprimirResumen(resumen, `Cierre de caja #${cierre.id}`);
        mostrarAviso(`Caja cerrada: ${formatoPrecio(cierre.total)}`);
        await Promise.all([cargarTurno(), cargarCierres()]);
    } catch (error) {
        mostrarAviso(error.message, 'error');
        boton.disabled = false;
    }
}

// 2. CIERRES ANTERIORES
async function cargarCierres() {
    const { data, error } = await supabaseClient
        .from('cierres_caja')
        .select('id, hasta, cuentas, total, diferencia')
        .eq('estado', 'cerrada')
        .order('id', { ascending: false })
        .limit(15);
    if (error) { mostrarAviso("Error al cargar cierres: " + error.message, 'error'); return; }

    document.getElementById('tabla-cierres').innerHTML = data.length
        ? data.map(c => `
            <tr>
                <td>${Number(c.id)}</td>
                <td>${formatoFechaHora(c.hasta)}</td>
                <td class="num">${Number(c.cuentas)}</td>
                <td class="num">${formatoPrecio(c.total)}</td>
                <td class="num">${c.diferencia === null ? '—' : formatoPrecio(c.diferencia)}</td>
                <td class="num"><button class="icon-btn" title="Reimprimir" onclick="reimprimirCierre(${Number(c.id)})"><span class="material-icons">print</span></button></td>
            </tr>`).join('')
        : '<tr><td colspan="6" class="vacio">Aún no hay cierres</td></tr>';
}

async function reimprimirCierre(id) {
    try {
        const resumen = await llamarRpc('resumen_ventas', { p_cierre_id: id });
        imprimirResumen(resumen, `Cierre de caja #${id} (copia)`);
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}

// 3. MESAS Y QR
async function cargarMesas() {
    const { data, error } = await supabaseClient.from('mesas').select('*').order('id');
    if (error) { mostrarAviso("Error al cargar mesas: " + error.message, 'error'); return; }
    mesasTodas = data;

    document.getElementById('tabla-mesas').innerHTML = data.length
        ? data.map(m => {
            const id = Number(m.id);
            return `
            <tr style="${m.activa ? '' : 'opacity:0.5;'}">
                <td><strong>${escapeHtml(m.nombre)}</strong>
                    <span class="tag ${m.activa ? 'tag-confirmado' : 'tag-cancelado'}" style="margin-left:6px;">${m.activa ? 'activa' : 'inactiva'}</span></td>
                <td class="num" style="white-space:nowrap;">
                    <button class="icon-btn" style="display:inline-flex;" title="Ver QR" onclick="verQR(${id})"><span class="material-icons">qr_code_2</span></button>
                    <button class="icon-btn" style="display:inline-flex;" title="Generar QR nuevo (el anterior deja de funcionar)" onclick="regenerarQR(${id})"><span class="material-icons">autorenew</span></button>
                    <button class="icon-btn" style="display:inline-flex;" title="${m.activa ? 'Desactivar' : 'Activar'}" onclick="cambiarActivaMesa(${id}, ${m.activa === true})"><span class="material-icons">${m.activa ? 'toggle_on' : 'toggle_off'}</span></button>
                </td>
            </tr>`;
        }).join('')
        : '<tr><td class="vacio">No hay mesas. Agrega la primera.</td></tr>';
}

async function agregarMesa(evento) {
    evento.preventDefault();
    const input = document.getElementById('nueva-mesa');
    const nombre = input.value.trim();
    if (!nombre) return;

    const { error } = await supabaseClient.from('mesas').insert([{ nombre }]);
    if (error) {
        mostrarAviso(error.code === '23505' ? "Ya existe una mesa con ese nombre" : error.message, 'error');
        return;
    }
    input.value = '';
    mostrarAviso(`${nombre} creada`);
    cargarMesas();
}

async function actualizarMesa(id, cambios) {
    const { data, error } = await supabaseClient.from('mesas').update(cambios).eq('id', id).select('id');
    if (error) throw error;
    if (!data || data.length === 0) throw new Error("No se aplicó el cambio. Verifica que tu usuario sea administrador.");
}

async function cambiarActivaMesa(id, activa) {
    try {
        if (activa) {
            const { data } = await supabaseClient.from('cuentas').select('id').eq('mesa_id', id).eq('estado', 'abierta');
            if (data && data.length) {
                mostrarAviso("La mesa tiene una cuenta abierta. Cóbrala antes de desactivarla.", 'error');
                return;
            }
        }
        await actualizarMesa(id, { activa: !activa });
        cargarMesas();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}

async function regenerarQR(id) {
    if (!confirm("Se generará un QR nuevo y el que está impreso en la mesa dejará de funcionar. ¿Continuar?")) return;
    try {
        await actualizarMesa(id, { token: crypto.randomUUID() });
        await cargarMesas();
        mostrarAviso("QR nuevo generado. Recuerda imprimirlo.");
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}

function urlDeMesa(mesa) {
    const base = CONFIG.URL_PUBLICA || window.location.href;
    return new URL(`index.html?mesa=${encodeURIComponent(mesa.token)}`, base).href;
}

// Un QR con localhost solo abre en esta misma PC: en el celular falla
function qrApuntaALocalhost() {
    const host = new URL(urlDeMesa({ token: 'x' })).hostname;
    return host === 'localhost' || host.startsWith('127.');
}

const AVISO_LOCALHOST = "Estos QR apuntan a localhost y no abrirán en los celulares. "
    + "Configura URL_PUBLICA en config.js o abre Caja con la IP de la PC (ej. http://192.168.x.x:8080/caja.html).";

function imagenQR(texto) {
    const qr = qrcode(0, 'M');
    qr.addData(texto);
    qr.make();
    return qr.createDataURL(8, 2);
}

function verQR(id) {
    const mesa = mesasTodas.find(m => m.id === id);
    if (!mesa) return;
    const url = urlDeMesa(mesa);
    document.getElementById('qr-titulo').textContent = mesa.nombre;
    document.getElementById('qr-imagen').innerHTML = `<img src="${imagenQR(url)}" alt="QR" style="width:220px; height:220px; display:block;">`;
    const link = document.getElementById('qr-link');
    link.href = url;
    link.textContent = url;
    const aviso = document.getElementById('qr-aviso');
    aviso.textContent = AVISO_LOCALHOST;
    aviso.style.display = qrApuntaALocalhost() ? 'block' : 'none';
    document.getElementById('qr-imprimir').onclick = () => imprimirQRs([mesa]);
    abrirModal('modal-qr');
}

function imprimirTodosLosQR() {
    const activas = mesasTodas.filter(m => m.activa);
    if (activas.length === 0) { mostrarAviso("No hay mesas activas", 'error'); return; }
    imprimirQRs(activas);
}

// Hoja A4 con un QR por mesa, para recortar y poner en cada mesa
function imprimirQRs(lista) {
    if (qrApuntaALocalhost() && !confirm(AVISO_LOCALHOST + "\n\n¿Imprimir de todos modos?")) return;
    const tarjetas = lista.map(m => `
        <div class="qr">
            <h2>${escapeHtml(m.nombre)}</h2>
            <img src="${imagenQR(urlDeMesa(m))}" alt="QR">
            <p>Escanea para ver la carta y pedir</p>
            <small>${escapeHtml(CONFIG.NOMBRE_BAR)}</small>
        </div>`).join('');

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>QR de mesas</title><style>
        @page { size: A4; margin: 10mm; }
        body { font-family: Arial, sans-serif; margin: 0; }
        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; }
        .qr { border: 1px dashed #999; padding: 5mm; text-align: center; break-inside: avoid; }
        .qr h2 { margin: 0 0 3mm; font-size: 18px; }
        .qr img { width: 48mm; height: 48mm; }
        .qr p { margin: 2mm 0 1mm; font-size: 11px; }
        .qr small { font-size: 9px; color: #555; letter-spacing: 1px; }
    </style></head><body><div class="grid">${tarjetas}</div></body></html>`;

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0;';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
    // Pequeña espera para que se dibujen las imágenes antes de imprimir
    setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(() => iframe.remove(), 1000);
    }, 300);
}

// 4. PERSONAL
async function cargarPersonal() {
    try {
        const personal = await llamarRpc('listar_personal');
        personalLista = personal;
        const { data: { session } } = await supabaseClient.auth.getSession();
        document.getElementById('tabla-personal').innerHTML = personal.map(p => {
            const esYo = session && p.user_id === session.user.id;
            return `
            <tr>
                <td>${escapeHtml(p.email)} ${esYo ? '<small style="color:#777;">(tú)</small>' : ''}</td>
                <td><span class="tag ${p.rol === 'admin' ? 'tag-qr' : 'tag-impreso'}">${escapeHtml(p.rol)}</span></td>
                <td class="num">${esYo ? '' : `<button class="icon-btn btn-del" style="display:inline-flex;" title="Quitar acceso" onclick="quitarPersonal(${personal.indexOf(p)})"><span class="material-icons">person_remove</span></button>`}</td>
            </tr>`;
        }).join('');
    } catch (error) {
        mostrarAviso("Error al cargar personal: " + error.message, 'error');
    }
}

async function asignarRol(evento) {
    evento.preventDefault();
    const email = document.getElementById('personal-email').value;
    const rol = document.getElementById('personal-rol').value;
    try {
        await llamarRpc('asignar_rol', { p_email: email, p_rol: rol });
        document.getElementById('personal-email').value = '';
        mostrarAviso(`${email} ahora es ${rol}`);
        cargarPersonal();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}

async function quitarPersonal(indice) {
    const persona = personalLista[indice];
    if (!persona) return;
    const { user_id: userId, email } = persona;
    if (!confirm(`¿Quitar el acceso de ${email}? Ya no podrá entrar al sistema.`)) return;
    try {
        await llamarRpc('quitar_personal', { p_user_id: userId });
        mostrarAviso("Acceso quitado");
        cargarPersonal();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}

document.addEventListener('DOMContentLoaded', iniciar);
